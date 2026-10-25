/**
 * AI 记成本：确认入账与补用量。
 *
 * commitCostDraft（一个 Firestore 事务，整单要么全部写入、要么一笔都不写）：
 * - 只入账老板确认过、已持久化的 expectedRevision；服务端按 domain/aiCost 重算分摊与合计，不再调用模型改写。
 * - 同一草稿只入账一次：草稿已 committed 时，任何 operationId 都返回原回执；行文档 ID 由 draftId + lineId 派生，重复写入会失败。
 * - 沿用原规则：营业日已关账整单拒绝；租金 / 电费走原月份唯一槽；工资需已启用；未知付款不能入账。
 * - 收据凭证（costReceipts）只是汇总与来源，不是额外支出；没有数量的食材只建「用量待补」的采购明细，不伪造批次。
 *
 * completePurchaseUsage：给已入账的采购补数量与食材 → 新建一批库存，原支出不变、不新增支出。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { buildCostPostingPlan, CostDraftInvalid, CostPostingPlan, ingredientCategoryOf, PLAN_ITEM_ZH, monthOf, RecurringItem, type CostCategory } from '../../../src/domain';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { loadStoreConfig, markDayActivity, requireDayOpen } from '../core/store';
import { assertRecurringOpen, ingredientFor, loadPlan } from '../commands/costing';
import { DraftDoc } from './drafts';

export interface CostPostingReceipt {
  receiptId: string;
  draftId: string;
  businessDate: string;
  expenseIds: string[];
  purchaseIds: string[];
  batchIds: string[];
  totalSen: number;
  committedRevision: number;
  foodCount: number;
  dailyCount: number;
  pendingUsageCount: number;
  excludedCount: number;
}

const descriptionOf = (l: CostPostingPlan['lines'][number]) => {
  if (l.kind === 'fixed_payment') return `${l.periodMonth} ${PLAN_ITEM_ZH[l.planItem!]}`;
  const qty = l.quantity !== null && l.unit ? ` · ${l.quantity} ${l.unit}` : '';
  const days = l.planItem === 'wage' && l.workDays ? ` · ${l.workDays} 天` : '';
  return `${l.name}${qty}${days}`.slice(0, 120);
};

/** 收据「疑似重复」指纹：商家 + 单号 + 日期 + 总额（缺商家与单号时不比，避免误报）。 */
export const semanticKeyOf = (d: { supplier: string | null; receiptNumber: string | null; purchaseDate: string; printedTotalSen: number | null }) =>
  (d.supplier || d.receiptNumber) && d.printedTotalSen !== null ? [d.supplier ?? '', d.receiptNumber ?? '', d.purchaseDate, d.printedTotalSen].join('|').toLowerCase() : null;

export async function commitCostDraft(db: Firestore, uid: string | undefined, input: {
  storeId: string; operationId: string; draftId: string; expectedRevision: number; duplicateAcknowledgement: { candidateId: string; reason: string } | null;
}) {
  return runCommand<CostPostingReceipt & { alreadyCommitted: boolean }>(db, {
    type: 'commitCostDraft', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.costDraft(input.draftId);
      const d = (await tx.get(ref)).data() as DraftDoc | undefined;
      if (!d) throw new CommandError('NOT_FOUND', '草稿不存在');
      // 已入账：无论哪个 operationId，都返回原回执，不重建。
      if (d.status === 'committed' && d.receipt) {
        return { result: { ...(d.receipt as unknown as CostPostingReceipt), alreadyCommitted: true }, audit: { entityId: input.draftId, action: 'commitCostDraft.replayed' } };
      }
      if (!['review', 'failed', 'analyzing', 'created'].includes(d.status) || !d.edited) throw new CommandError('DRAFT_STATE', '这份草稿还没有可确认的内容');
      if (d.revision !== input.expectedRevision) throw new CommandError('STALE_VERSION', '草稿已有新版本，请先载入再确认', { revision: d.revision });
      const config = await loadStoreConfig(tx, store);
      const today = businessDateOf(nowMs, config.businessDay);
      let plan: CostPostingPlan;
      try {
        plan = buildCostPostingPlan(d.edited, { today });
      } catch (e) {
        if (e instanceof CostDraftInvalid) throw new CommandError('DRAFT_INVALID', e.message, { issues: e.issues });
        throw e;
      }
      const date = plan.purchaseDate;
      const day = await requireDayOpen(tx, store, date);

      // 固定费用：原月份唯一槽；同一草稿里同项同月只能一行。
      const recurring = plan.lines.filter((l) => l.kind === 'fixed_payment');
      const keys = recurring.map((l) => `${l.planItem}-${l.periodMonth}`);
      if (new Set(keys).size !== keys.length) throw new CommandError('PERIOD_ALREADY_PAID', '同一个月的租金 / 电费在这份草稿里出现了两次');
      const slots = [];
      for (const l of recurring) slots.push({ line: l, ...(await assertRecurringOpen(tx, store, l.planItem as RecurringItem, l.periodMonth!, today)) });
      if (plan.lines.some((l) => l.planItem === 'wage') && !(await loadPlan(tx, store)).staff.enabled) throw new CommandError('STAFF_NOT_ENABLED', '员工工资尚未启用');
      const stockLines = plan.lines.filter((l) => l.stock);
      const ingredients = new Map<string, Awaited<ReturnType<typeof ingredientFor>>>();
      for (const l of stockLines) ingredients.set(l.lineId, await ingredientFor(tx, store, l.ingredientId!));

      // 疑似重复收据：同一张图片或同商家 + 单号 + 日期 + 总额已入账。
      const semanticKey = semanticKeyOf({ ...d.edited, purchaseDate: date });
      const dupDocs = [
        ...(d.imageHashes.length ? (await tx.get(store.root.collection('costReceipts').where('imageHashes', 'array-contains-any', d.imageHashes))).docs : []),
        ...(semanticKey ? (await tx.get(store.root.collection('costReceipts').where('semanticKey', '==', semanticKey))).docs : []),
      ].filter((x) => x.data().draftId !== input.draftId && x.data().status !== 'voided');
      const candidates = [...new Map(dupDocs.map((x) => [x.id, x.data()])).entries()].map(([id, r]) => ({ receiptId: id, businessDate: r.businessDate, totalSen: r.totalSen, supplier: r.supplier ?? null }));
      if (candidates.length) {
        const ack = input.duplicateAcknowledgement;
        if (!ack || !candidates.some((c) => c.receiptId === ack.candidateId)) throw new CommandError('DUPLICATE_RECEIPT', '这张收据好像已经记过了', { candidates });
      }

      // —— 以下只写 ——
      const receiptId = `rcp-${input.draftId}`;
      const expenseIds: string[] = [], purchaseIds: string[] = [], batchIds: string[] = [];
      for (const l of plan.lines) {
        const expenseId = `exp-${input.draftId}-${l.lineId}`;
        const purchaseId = l.kind === 'purchase' ? `pd-${input.draftId}-${l.lineId}` : null;
        const batchId = l.stock ? `bat-${input.draftId}-${l.lineId}` : null;
        tx.create(store.expense(expenseId), {
          id: expenseId, category: l.kind, description: descriptionOf(l), amountSen: l.netSen, paidSen: l.paid ? l.netSen : 0,
          paymentSource: plan.paymentSource, businessDate: date, accrualDate: date, status: 'active', correctionOf: null, occurredAtMs: nowMs, recordedBy: actor.uid,
          planItem: l.planItem, periodMonth: l.kind === 'fixed_payment' ? l.periodMonth : l.kind === 'opex' ? monthOf(date) : null, ingredientBatchId: batchId, settlesExpenseId: null,
          workDays: l.workDays, costReceiptId: receiptId, costDraftId: input.draftId, costCategory: l.category, purchaseDetailId: purchaseId,
        });
        expenseIds.push(expenseId);
        if (purchaseId) {
          tx.create(store.purchaseDetail(purchaseId), {
            id: purchaseId, expenseId, draftId: input.draftId, receiptId, name: l.name, costCategory: l.category, ingredientCategory: ingredientCategoryOf(l.category as CostCategory),
            ingredientId: l.ingredientId, quantity: l.quantity, unit: l.unit, amountSen: l.netSen, purchasedDate: date, usageState: batchId ? 'stocked' : 'pending', batchId,
            revision: 1, createdAtMs: nowMs, updatedAtMs: nowMs,
          });
          purchaseIds.push(purchaseId);
        }
        if (batchId) {
          const ing = ingredients.get(l.lineId)!;
          // 库存待启用：不开封、不结束旧批，也不认定已消耗。
          tx.create(store.batch(batchId), {
            id: batchId, ingredientId: ing.id, ingredientName: ing.name, category: ing.category, quantity: l.quantity, unit: l.unit, costSen: l.netSen,
            origin: 'purchase', purchaseExpenseId: expenseId, purchasedDate: date, paid: l.paid, status: 'stocked', startedAtMs: null, endedAtMs: null,
            wastageQuantity: null, endNote: '', note: l.note, createdAtMs: nowMs, updatedAtMs: nowMs, createdBy: actor.uid, costHistory: [], purchaseDetailId: purchaseId,
          });
          batchIds.push(batchId);
        }
      }
      for (const s of slots) {
        const expenseId = `exp-${input.draftId}-${s.line.lineId}`;
        tx.set(s.slotRef, { item: s.line.planItem, month: s.line.periodMonth, expenseId, updatedAtMs: nowMs, history: [...((s.slot?.history as string[]) ?? []), expenseId] }, { merge: true });
      }
      const receipt: CostPostingReceipt = {
        receiptId, draftId: input.draftId, businessDate: date, expenseIds, purchaseIds, batchIds, totalSen: plan.totals.businessTotalSen, committedRevision: d.revision,
        foodCount: plan.lines.filter((l) => l.kind === 'purchase').length, dailyCount: plan.lines.filter((l) => l.kind !== 'purchase').length,
        pendingUsageCount: plan.lines.filter((l) => l.kind === 'purchase' && !l.stock).length, excludedCount: plan.excluded.length,
      };
      tx.create(store.costReceipt(receiptId), {
        ...receipt, status: 'active', source: d.source, supplier: d.edited.supplier, receiptNumber: d.edited.receiptNumber, semanticKey,
        imageHashes: d.imageHashes, attachments: d.input.attachments, text: d.input.text, printedTotalSen: plan.totals.printedTotalSen,
        computedTotalSen: plan.totals.computedTotalSen, discountSen: plan.totals.discountSen, taxSen: plan.totals.taxSen, difference: d.edited.difference,
        excluded: plan.excluded, zeroLines: plan.zeroLines, paymentSource: plan.paymentSource, extractionMeta: d.extractionMeta,
        duplicateAcknowledgement: candidates.length ? input.duplicateAcknowledgement : null, createdAtMs: nowMs, createdBy: actor.uid,
      });
      markDayActivity(tx, store, date, day, nowMs);
      tx.update(ref, { status: 'committed', receipt, committedAtMs: nowMs, activeAttemptId: null, leaseUntilMs: null, candidate: null, updatedAtMs: nowMs });
      return {
        result: { ...receipt, alreadyCommitted: false },
        audit: { entityId: input.draftId, after: { receiptId, totalSen: receipt.totalSen, lines: plan.lines.map((l) => ({ lineId: l.lineId, kind: l.kind, netSen: l.netSen, paid: l.paid })), excluded: plan.excluded.length } },
      };
    },
  });
}

/** 补用量：给「用量待补」的采购补数量与食材，建一批库存（原支出不变）。重复 / 并发只会得到同一个批次。 */
export async function completePurchaseUsage(db: Firestore, uid: string | undefined, input: {
  storeId: string; operationId: string; purchaseId: string; expectedRevision: number; ingredientId: string; quantity: number; unit: string; startUsingAtMs: number | null;
}) {
  return runCommand<{ purchaseId: string; batchId: string; expenseId: string; status: string }>(db, {
    type: 'completePurchaseUsage', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const ref = store.purchaseDetail(input.purchaseId);
      const pd = (await tx.get(ref)).data();
      if (!pd) throw new CommandError('NOT_FOUND', '采购记录不存在');
      if (pd.usageState === 'stocked' && pd.batchId) {
        return { result: { purchaseId: input.purchaseId, batchId: pd.batchId as string, expenseId: pd.expenseId as string, status: 'already' }, audit: { entityId: input.purchaseId, action: 'completePurchaseUsage.replayed' } };
      }
      if (pd.revision !== input.expectedRevision) throw new CommandError('STALE_VERSION', '这笔采购已有新版本，请刷新', { revision: pd.revision });
      const expense = (await tx.get(store.expense(pd.expenseId))).data();
      if (!expense || expense.status !== 'active') throw new CommandError('BATCH_STATE', '这笔采购已作废，不能补库存');
      const ing = await ingredientFor(tx, store, input.ingredientId);
      if (pd.ingredientCategory && ing.category !== pd.ingredientCategory) throw new CommandError('INVALID_ARGUMENT', '所选食材与这笔采购的分类不一致');
      const batchId = `bat-${input.purchaseId}`;
      let startedAtMs: number | null = null;
      if (input.startUsingAtMs !== null) {
        if (input.startUsingAtMs > nowMs + 10 * 60_000) throw new CommandError('INVALID_ARGUMENT', '开始使用时间不能是未来');
        const inUse = await tx.get(store.root.collection('ingredientBatches').where('ingredientId', '==', ing.id).where('status', '==', 'in_use'));
        if (!inUse.empty) throw new CommandError('BATCH_STATE', '这种食材还有在用的旧批，请到「详细用料管理」换批');
        startedAtMs = input.startUsingAtMs;
      }
      tx.create(store.batch(batchId), {
        id: batchId, ingredientId: ing.id, ingredientName: ing.name, category: ing.category, quantity: input.quantity, unit: input.unit, costSen: expense.amountSen,
        origin: 'purchase', purchaseExpenseId: pd.expenseId, purchasedDate: expense.businessDate, paid: expense.paidSen >= expense.amountSen, status: startedAtMs === null ? 'stocked' : 'in_use',
        startedAtMs, endedAtMs: null, wastageQuantity: null, endNote: '', note: '补用量', createdAtMs: nowMs, updatedAtMs: nowMs, createdBy: actor.uid, costHistory: [], purchaseDetailId: input.purchaseId,
      });
      tx.update(store.expense(pd.expenseId), { ingredientBatchId: batchId });
      tx.update(ref, { usageState: 'stocked', batchId, ingredientId: ing.id, quantity: input.quantity, unit: input.unit, revision: pd.revision + 1, updatedAtMs: nowMs });
      return {
        result: { purchaseId: input.purchaseId, batchId, expenseId: pd.expenseId, status: startedAtMs === null ? 'stocked' : 'in_use' },
        audit: { entityId: input.purchaseId, before: { usageState: 'pending' }, after: { batchId, quantity: input.quantity, unit: input.unit, ingredientId: ing.id } },
      };
    },
  });
}
