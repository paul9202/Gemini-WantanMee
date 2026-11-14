/**
 * 日结关账与更正版本（10 章、03 §8）。
 * - 关账在一个事务里读取该营业日全部账本并写入不可变的版本快照；与所有当日账本命令在营业日文档上串行。
 * - 未完成订单、待登记收款（含之前营业日结转来的）、离线待核对、应退款待处理、旧版待回收餐牌列为例外；
 *   不确认例外不能关账（老板写明原因后结转，未登记金额不默认为已收、也不丢弃）。
 * - 新版日结（figures.schemaVersion=2）不分收款渠道：不录钱箱实点 / QR 银行核对，不推算钱箱应有。
 *   旧版已冻结报表保持原形状可查看；对旧版报表做更正仍按旧口径。
 * - 关账后迟到的离线单与更正只增加「待调整」计数；更正版本 n+1 写新快照，旧版本与旧导出不变。
 * - 跨日补登记的收款计入登记日的账本，不改写原营业日的冻结报表。
 */
import { Firestore, Transaction } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { DEFAULT_FIXED_COST, FixedCostPolicy } from '../../../src/domain/finance';
import type { ExpenseLinkDoc } from '../../../src/domain/costing';
import { addDays, businessDateOf, isDateString } from '../../../src/domain/businessDay';
import { closeFigures, closeFiguresV2, CloseOrderRow, isCloseFiguresV2, LedgerDocs } from '../../../src/domain/ledger';
import { runCommand, storeRefs, StoreRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, int, obj, optInt, optStr, storeId, uuid } from '../core/input';
import { loadStoreConfig } from '../core/store';

async function readDay(tx: Transaction, store: StoreRefs, date: string) {
  const q = <T>(name: string, field = 'businessDate') => tx.get(store.root.collection(name).where(field, '==', date)).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }) as T));
  const [payments, refunds, costEvents, wastage, expensesPaid, expensesAccrued, cashMovements, orders, writeOffs] = await Promise.all([
    q<LedgerDocs['payments'][number]>('payments'), q<LedgerDocs['refunds'][number]>('refunds'), q<LedgerDocs['costEvents'][number]>('costEvents'),
    q<LedgerDocs['wastage'][number]>('wastage'), q<LedgerDocs['expenses'][number]>('expenses'), q<LedgerDocs['expenses'][number]>('expenses', 'accrualDate'),
    q<LedgerDocs['cashMovements'][number]>('cashMovements'),
    q<CloseOrderRow>('orders'),
    q<NonNullable<LedgerDocs['writeOffs']>[number]>('paymentWriteOffs'),
  ]);
  const expenses = [...new Map([...expensesPaid, ...expensesAccrued].map((e) => [e.id, e])).values()];
  // 老板确认的支出归属：已归属到月租 / 开档项目的营业费用不再按营业费用扣（与老板端预览同一口径）。
  const linkSnaps = expenses.length ? await tx.getAll(...expenses.map((e) => store.expenseLink(e.id))) : [];
  const expenseLinks = linkSnaps.filter((s) => s.exists).map((s) => s.data() as ExpenseLinkDoc);
  // 待登记收款不限于本营业日：之前营业日结转来的未登记单也要在日结前核对。
  const unpaid = await tx.get(store.root.collection('orders').where('paymentState', '==', 'unpaid'))
    .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }) as CloseOrderRow).filter((o) => o.businessDate <= date));
  return { docs: { payments, refunds, costEvents, wastage, expenses, cashMovements, writeOffs, expenseLinks } as LedgerDocs, orders, unpaid };
}

async function exceptionsFor(tx: Transaction, store: StoreRefs, orders: CloseOrderRow[], unpaid: CloseOrderRow[]) {
  const [reviews, tokens] = await Promise.all([
    tx.get(store.root.collection('offlineInbox').where('status', 'in', ['needs_review', 'blocked'])),
    tx.get(store.root.collection('tokens').where('state', '==', 'awaiting_return')),
  ]);
  return {
    unpaidOrders: unpaid.filter((o) => o.fulfillmentStatus !== 'cancelled').map((o) => ({
      id: o.id, receiptNumber: o.receiptNumber, tokenNumber: o.tokenNumber, businessDate: o.businessDate, totalSen: o.totalSen, fulfillmentStatus: o.fulfillmentStatus,
    })),
    unfinishedOrders: orders.filter((o) => o.fulfillmentStatus === 'queued' || o.fulfillmentStatus === 'preparing').map((o) => ({ id: o.id, tokenNumber: o.tokenNumber, receiptNumber: o.receiptNumber })),
    refundDue: orders.filter((o) => o.paymentState === 'refund_due').map((o) => ({ id: o.id, receiptNumber: o.receiptNumber, totalSen: o.totalSen })),
    // 只会是改版前遗留的待回收牌；新流程出餐 / 取消即自动释放。
    awaitingTokens: tokens.docs.map((d) => d.data().number as number),
    offlineReviews: reviews.docs.map((d) => ({ eventId: d.id, status: d.data().status as string, reasonCode: d.data().reasonCode as string, amountSen: (d.data().amountSen as number | null) ?? null })),
  };
}

const hasExceptions = (e: Awaited<ReturnType<typeof exceptionsFor>>) =>
  e.unfinishedOrders.length + e.unpaidOrders.length + e.refundDue.length + e.awaitingTokens.length + e.offlineReviews.length > 0;

async function fixedPolicy(tx: Transaction, store: StoreRefs): Promise<FixedCostPolicy> {
  return ((await tx.get(store.configFinance)).data()?.fixedCostPolicy as FixedCostPolicy | undefined) ?? DEFAULT_FIXED_COST;
}

function watermark(docs: LedgerDocs) {
  const all = [...docs.payments, ...docs.refunds, ...docs.wastage, ...docs.expenses, ...docs.cashMovements] as { occurredAtMs?: number }[];
  return {
    counts: { payments: docs.payments.length, refunds: docs.refunds.length, costEvents: docs.costEvents.length, wastage: docs.wastage.length, expenses: docs.expenses.length, cashMovements: docs.cashMovements.length },
    maxOccurredAtMs: Math.max(0, ...all.map((d) => d.occurredAtMs ?? 0)),
  };
}

export async function closeBusinessDay(db: Firestore, uid: string | undefined, raw: unknown) {
  // countedCashSen / qrBankConfirmedSen 只为旧客户端兼容而接受；新版日结不使用、不要求。
  const o = obj(raw, ['storeId', 'operationId', 'businessDate', 'countedCashSen', 'qrBankConfirmedSen', 'note', 'acknowledgeExceptions', 'exceptionReason']);
  optInt(o, 'countedCashSen', 0, 100_000_000);
  optInt(o, 'qrBankConfirmedSen', 0, 100_000_000);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), businessDate: o.businessDate as string,
    note: optStr(o, 'note', 500) ?? '', acknowledgeExceptions: bool(o, 'acknowledgeExceptions'), exceptionReason: optStr(o, 'exceptionReason', 500),
  };
  if (!isDateString(input.businessDate)) throw bad('businessDate 非法');
  return runCommand(db, {
    type: 'closeBusinessDay', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const r = await closeDayTx(tx, store, input.businessDate, nowMs, actor.uid, { mode: 'manual', note: input.note, acknowledge: input.acknowledgeExceptions, exceptionReason: input.exceptionReason });
      return {
        result: { businessDate: input.businessDate, version: r.version, figures: r.figures, exceptions: r.exceptions },
        audit: { entityId: `day-${input.businessDate}`, after: { version: r.version, netRegisteredSen: r.figures.netRegisteredSen, unpaidSen: r.figures.unpaid.totalSen } },
      };
    },
  });
}

/**
 * 关账核心（手动日结与每天自动关账共用）。所有读在写之前。
 * - manual：有例外必须老板确认并写原因，否则拒绝。
 * - auto：不拦；例外照样冻结在快照里，原因写明「系统自动关账」，未登记收款结转（不当作已收、不丢弃）。
 */
export async function closeDayTx(
  tx: Transaction, store: StoreRefs, date: string, nowMs: number, closedBy: string,
  opts: { mode: 'manual' | 'auto'; note: string; acknowledge?: boolean; exceptionReason?: string | null },
) {
  const daySnap = await tx.get(store.businessDay(date));
  const day = daySnap.data();
  if (day && day.state !== 'open') throw new CommandError('DAY_CLOSED', '该营业日已关账，请使用更正版本');
  const reportSnap = await tx.get(store.dailyReport(date));
  const { docs, orders, unpaid } = await readDay(tx, store, date);
  const exceptions = await exceptionsFor(tx, store, orders, unpaid);
  const fixed = await fixedPolicy(tx, store);
  const has = hasExceptions(exceptions);
  if (opts.mode === 'manual' && has && !(opts.acknowledge && opts.exceptionReason && opts.exceptionReason.trim().length >= 2)) {
    throw new CommandError('CLOSE_EXCEPTIONS', '有未处理事项，请确认并写明原因后再关账', { exceptions });
  }
  const exceptionReason = opts.mode === 'auto'
    ? (has ? `系统自动关账：${autoExceptionText(exceptions)}，已结转；之后补登记或核对会记成关账后的调整` : null)
    : opts.exceptionReason ?? null;
  const figures = closeFiguresV2(docs, orders, unpaid, date, fixed);
  const version = ((reportSnap.data()?.latestVersion as number) ?? 0) + 1;
  tx.create(store.dailyReportVersion(date, version), {
    version, businessDate: date, kind: 'close', mode: opts.mode, figures, exceptions, exceptionReason, note: opts.note,
    // 未登记收款明确结转：金额与订单清单随快照冻结，之后补登记计入登记日。
    unpaidCarriedForward: { count: figures.unpaid.count, totalSen: figures.unpaid.totalSen, reason: exceptions.unpaidOrders.length ? exceptionReason : null },
    ledgerWatermark: watermark(docs), fixedCostPolicy: fixed, closedBy, closedAtMs: nowMs, restates: null,
  });
  tx.set(store.dailyReport(date), { businessDate: date, latestVersion: version, status: 'closed', closedAtMs: nowMs, pendingAdjustments: 0, closeMode: opts.mode }, { merge: true });
  tx.set(store.businessDay(date), { state: 'closed', closedVersion: version, closedAtMs: nowMs, closeMode: opts.mode, pendingAdjustments: 0, receiptSeq: (day?.receiptSeq as number) ?? 0 }, { merge: true });
  return { version, figures, exceptions };
}

function autoExceptionText(e: Awaited<ReturnType<typeof exceptionsFor>>): string {
  return [
    e.unpaidOrders.length ? `待登记收款 ${e.unpaidOrders.length} 单` : '', e.unfinishedOrders.length ? `未出餐 ${e.unfinishedOrders.length} 单` : '',
    e.refundDue.length ? `应退款 ${e.refundDue.length} 单` : '', e.offlineReviews.length ? `离线待核对 ${e.offlineReviews.length} 条` : '',
    e.awaitingTokens.length ? `待回收餐牌 ${e.awaitingTokens.length} 张` : '',
  ].filter(Boolean).join('、');
}

/** 自动关账最多往回看几天（之前没关的旧日子也一起关，按日期从早到晚）。 */
export const AUTO_CLOSE_LOOKBACK_DAYS = 31;

/**
 * 每天自动关账（2026-11-14 起，老板不用再手动日结）：把今天之前所有仍未关账的营业日按日期关掉。
 * config/autoClose.enabled === false 时停用（默认开）。每天一个事务，已关的跳过，可以重复跑。审计记为系统（actorUid: 'system'）。
 */
export async function autoCloseBusinessDays(db: Firestore, storeId: string, nowMs = Date.now()): Promise<{ closed: string[]; skipped: string | null }> {
  const store = storeRefs(db, storeId);
  const flag = (await store.root.collection('config').doc('autoClose').get()).data();
  if (flag?.enabled === false) return { closed: [], skipped: 'disabled' };
  const cfg = await store.configPublic.get();
  if (!cfg.exists) return { closed: [], skipped: 'not_configured' };
  const today = await db.runTransaction(async (tx) => businessDateOf(nowMs, (await loadStoreConfig(tx, store)).businessDay));
  const open = await store.root.collection('businessDays').where('state', '==', 'open').get();
  const dates = open.docs.map((d) => d.id).filter((d) => isDateString(d) && d < today && d >= addDays(today, -AUTO_CLOSE_LOOKBACK_DAYS)).sort();
  const closed: string[] = [];
  for (const date of dates) {
    const ok = await db.runTransaction(async (tx) => {
      const at = Date.now();
      try {
        const r = await closeDayTx(tx, store, date, at, 'system', { mode: 'auto', note: '系统自动关账' });
        const id = `auto-close-${date}-${randomUUID().slice(0, 8)}`;
        tx.create(store.audit(id), {
          operationId: id, action: 'autoCloseBusinessDay', actorUid: 'system', actorRole: 'system', entityId: `day-${date}`, before: null,
          after: { version: r.version, netRegisteredSen: r.figures.netRegisteredSen, unpaidSen: r.figures.unpaid.totalSen }, atMs: at,
        });
        return true;
      } catch (e) {
        if (e instanceof CommandError && e.reasonCode === 'DAY_CLOSED') return false;
        throw e;
      }
    });
    if (ok) closed.push(date);
  }
  return { closed, skipped: null };
}

/** 更正版本：用当前账本（含关账后迟到的调整）重算，写新版本；旧版本保持不变。 */
export async function restateBusinessDay(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'businessDate', 'reason', 'countedCashSen', 'qrBankConfirmedSen']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), businessDate: o.businessDate as string, reason: (o.reason as string) ?? '',
    countedCashSen: o.countedCashSen === undefined ? null : int(o, 'countedCashSen', 0, 100_000_000),
    qrBankConfirmedSen: o.qrBankConfirmedSen === undefined ? null : int(o, 'qrBankConfirmedSen', 0, 100_000_000),
  };
  if (!isDateString(input.businessDate)) throw bad('businessDate 非法');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 2 || input.reason.length > 500) throw bad('请写明更正原因');
  return runCommand(db, {
    type: 'restateBusinessDay', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const day = (await tx.get(store.businessDay(input.businessDate))).data();
      if (!day || day.state !== 'closed') throw new CommandError('NOT_CLOSED', '该营业日尚未关账');
      const report = (await tx.get(store.dailyReport(input.businessDate))).data()!;
      const prevVersion = report.latestVersion as number;
      const prev = (await tx.get(store.dailyReportVersion(input.businessDate, prevVersion))).data()!;
      const { docs, orders, unpaid } = await readDay(tx, store, input.businessDate);
      const exceptions = await exceptionsFor(tx, store, orders, unpaid);
      const fixed = await fixedPolicy(tx, store);
      // 新版报表按新口径重算；旧版（钱箱 / QR 拆分）报表按旧口径更正，不混用。
      const figures = isCloseFiguresV2(prev.figures)
        ? closeFiguresV2(docs, orders, unpaid, input.businessDate, fixed)
        : closeFigures(docs, {
          businessDate: input.businessDate,
          countedCashSen: input.countedCashSen ?? prev.figures.countedCashSen,
          qrBankConfirmedSen: input.qrBankConfirmedSen ?? prev.figures.qrBankConfirmedSen,
        }, fixed);
      const version = prevVersion + 1;
      tx.create(store.dailyReportVersion(input.businessDate, version), {
        version, businessDate: input.businessDate, kind: 'restatement', figures, exceptions, note: input.reason, restates: prevVersion,
        ledgerWatermark: watermark(docs), fixedCostPolicy: fixed, closedBy: actor.uid, closedAtMs: nowMs,
        adjustmentsIncluded: (day.pendingAdjustments as number) ?? 0,
      });
      tx.update(store.dailyReport(input.businessDate), { latestVersion: version, pendingAdjustments: 0, restatedAtMs: nowMs });
      tx.update(store.businessDay(input.businessDate), { closedVersion: version, pendingAdjustments: 0 });
      return {
        result: { businessDate: input.businessDate, version, restates: prevVersion, figures },
        audit: { entityId: `day-${input.businessDate}`, before: { version: prevVersion }, after: { version, reason: input.reason } },
      };
    },
  });
}
