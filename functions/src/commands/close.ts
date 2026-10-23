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
import { DEFAULT_FIXED_COST, FixedCostPolicy } from '../../../src/domain/finance';
import { isDateString } from '../../../src/domain/businessDay';
import { closeFigures, closeFiguresV2, CloseOrderRow, isCloseFiguresV2, LedgerDocs } from '../../../src/domain/ledger';
import { runCommand, StoreRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, int, obj, optInt, optStr, storeId, uuid } from '../core/input';

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
  // 待登记收款不限于本营业日：之前营业日结转来的未登记单也要在日结前核对。
  const unpaid = await tx.get(store.root.collection('orders').where('paymentState', '==', 'unpaid'))
    .then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() }) as CloseOrderRow).filter((o) => o.businessDate <= date));
  return { docs: { payments, refunds, costEvents, wastage, expenses, cashMovements, writeOffs } as LedgerDocs, orders, unpaid };
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
      const daySnap = await tx.get(store.businessDay(input.businessDate));
      const day = daySnap.data();
      if (day && day.state !== 'open') throw new CommandError('DAY_CLOSED', '该营业日已关账，请使用更正版本');
      const reportSnap = await tx.get(store.dailyReport(input.businessDate));
      const { docs, orders, unpaid } = await readDay(tx, store, input.businessDate);
      const exceptions = await exceptionsFor(tx, store, orders, unpaid);
      const fixed = await fixedPolicy(tx, store);
      if (hasExceptions(exceptions) && !(input.acknowledgeExceptions && input.exceptionReason && input.exceptionReason.trim().length >= 2)) {
        throw new CommandError('CLOSE_EXCEPTIONS', '有未处理事项，请确认并写明原因后再关账', { exceptions });
      }
      const figures = closeFiguresV2(docs, orders, unpaid, input.businessDate, fixed);
      const version = ((reportSnap.data()?.latestVersion as number) ?? 0) + 1;
      tx.create(store.dailyReportVersion(input.businessDate, version), {
        version, businessDate: input.businessDate, kind: 'close', figures, exceptions, exceptionReason: input.exceptionReason, note: input.note,
        // 未登记收款明确结转：金额与订单清单随快照冻结，之后补登记计入登记日。
        unpaidCarriedForward: { count: figures.unpaid.count, totalSen: figures.unpaid.totalSen, reason: exceptions.unpaidOrders.length ? input.exceptionReason : null },
        ledgerWatermark: watermark(docs), fixedCostPolicy: fixed, closedBy: actor.uid, closedAtMs: nowMs, restates: null,
      });
      tx.set(store.dailyReport(input.businessDate), { businessDate: input.businessDate, latestVersion: version, status: 'closed', closedAtMs: nowMs, pendingAdjustments: 0 }, { merge: true });
      tx.set(store.businessDay(input.businessDate), { state: 'closed', closedVersion: version, closedAtMs: nowMs, pendingAdjustments: 0, receiptSeq: (day?.receiptSeq as number) ?? 0 }, { merge: true });
      return {
        result: { businessDate: input.businessDate, version, figures, exceptions },
        audit: { entityId: `day-${input.businessDate}`, after: { version, netRegisteredSen: figures.netRegisteredSen, unpaidSen: figures.unpaid.totalSen } },
      };
    },
  });
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
