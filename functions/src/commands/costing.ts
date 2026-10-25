/**
 * 收支改版命令（2026-10-25）：食材与批次、日常开支、开档成本、经营目标。
 * - 全部经 runCommand：老板角色、operationId 幂等、审计；事务内先读后写。
 * - 有账务影响的记录不删除：作废并保留原因，需要时另记更正。
 * - 首次录入的现有食材、启用库存批次都不产生支出；只有「记新进货」生成一笔进货支出（可未付，之后补付款）。
 * - 租金、冰箱电费每月只能登记一笔（recurringSlots 串行防重复）；开档成本已付的同月租金不再收。
 * - 开档初始清单幂等写入：已有记录（含作废）一律不覆盖。
 */
import { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  BatchDoc, BUILT_IN_BY_ID, CostCoverage, DEFAULT_EXPENSE_PLAN, ExpenseLink, ExpenseLinkDoc, GoalDoc, goalProgress, NewExpenseLink, validateExpenseLink, DEFAULT_SALES_TARGETS, ExpensePlan, INGREDIENT_CATEGORY_IDS, isMonthString, isQuantity,
  monthlyPlanRows, monthOf, paybackStatus, PlanExpense, RECURRING_ITEMS, SalesTargets, scheduleFromPlan, STARTUP_SEED, startupSeedId,
  StartupCostDoc, startupSummary, validateStartBatch, validateStartupDetails,
} from '../../../src/domain/costing';
import { businessDateOf } from '../../../src/domain/businessDay';
import { DEFAULT_FIXED_COST, FixedCostPolicy } from '../../../src/domain/finance';
import { runCommand, StoreRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, bool, int, obj, oneOf, optInt, optStr, Raw, str, storeId, uuid } from '../core/input';
import { loadStoreConfig, markDayActivity, requireDayOpen } from '../core/store';
import { ledgerDay, optDate } from './ledger';

const SOURCES = ['drawer', 'bank', 'owner'] as const;
const MAX_SEN = 100_000_000;
const EARLIEST_MS = Date.UTC(2024, 0, 1);

function quantity(o: Raw, k: string): number {
  if (!isQuantity(o[k])) throw bad(`${k} 必须是大于 0、最多 3 位小数的数量`);
  return o[k] as number;
}

/** 时间不得早于 2024 年，也不得晚于现在 10 分钟以上（防误填未来）。 */
function checkTime(ms: number, nowMs: number, what: string) {
  if (ms < EARLIEST_MS || ms > nowMs + 10 * 60_000) throw bad(`${what}不能是未来时间`);
}

const optMonth = (o: Raw, k: string) => {
  const v = o[k];
  if (v === undefined || v === null) return null;
  if (!isMonthString(v)) throw bad(`${k} 必须是 YYYY-MM`);
  return v;
};

export async function ingredientFor(tx: Transaction, store: StoreRefs, id: string) {
  const b = BUILT_IN_BY_ID.get(id);
  if (b) return b;
  const d = (await tx.get(store.ingredient(id))).data();
  if (!d || d.active === false) throw new CommandError('NOT_FOUND', '食材不存在');
  return { id, category: d.category, name: d.name as string, unit: d.unit as string, builtIn: false };
}

async function getBatch(tx: Transaction, store: StoreRefs, id: string): Promise<BatchDoc> {
  const d = (await tx.get(store.batch(id))).data();
  if (!d) throw new CommandError('NOT_FOUND', '批次不存在');
  return d as BatchDoc;
}

export async function loadPlan(tx: Transaction, store: StoreRefs): Promise<ExpensePlan> {
  const d = (await tx.get(store.configExpensePlan)).data();
  return { ...DEFAULT_EXPENSE_PLAN, ...(d?.plan ?? {}) } as ExpensePlan;
}

async function loadStartup(tx: Transaction, store: StoreRefs): Promise<StartupCostDoc[]> {
  return (await tx.get(store.root.collection('startupCosts'))).docs.map((d) => d.data() as StartupCostDoc);
}

// ───────────────────────── 食材与批次 ─────────────────────────

export async function addIngredient(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'category', 'name', 'unit']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), category: oneOf(o, 'category', INGREDIENT_CATEGORY_IDS), name: str(o, 'name', 30).trim(), unit: str(o, 'unit', 10).trim() };
  if (!input.name || !input.unit) throw bad('名称和单位不能为空');
  return runCommand(db, {
    type: 'addIngredient', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const existing = await tx.get(store.root.collection('ingredients').where('name', '==', input.name));
      if (!existing.empty || [...BUILT_IN_BY_ID.values()].some((b) => b.name === input.name)) throw bad('已有同名食材');
      const id = `ing-${input.operationId}`;
      tx.create(store.ingredient(id), { id, category: input.category, name: input.name, unit: input.unit, builtIn: false, active: true, createdAtMs: nowMs, createdBy: actor.uid });
      return { result: { id }, audit: { entityId: id, after: { category: input.category, name: input.name, unit: input.unit } } };
    },
  });
}

/** 首次录入手上现有的食材：不产生采购支出；成本可暂缺（待补）。填了开始使用时间即为使用中。 */
export async function recordExistingBatch(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'ingredientId', 'quantity', 'unit', 'costSen', 'startedAtMs', 'note']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), ingredientId: str(o, 'ingredientId', 80), quantity: quantity(o, 'quantity'), unit: str(o, 'unit', 10),
    costSen: optInt(o, 'costSen', 0, MAX_SEN), startedAtMs: optInt(o, 'startedAtMs', 0, 4_102_444_800_000), note: optStr(o, 'note', 200) ?? '',
  };
  return runCommand(db, {
    type: 'recordExistingBatch', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      if (input.startedAtMs !== null) checkTime(input.startedAtMs, nowMs, '开始使用时间');
      const ing = await ingredientFor(tx, store, input.ingredientId);
      const id = `bat-${input.operationId}`;
      const batch: BatchDoc = {
        id, ingredientId: ing.id, ingredientName: ing.name, category: ing.category, quantity: input.quantity, unit: input.unit, costSen: input.costSen,
        origin: 'existing', purchaseExpenseId: null, purchasedDate: null, paid: null, status: input.startedAtMs === null ? 'stocked' : 'in_use',
        startedAtMs: input.startedAtMs, endedAtMs: null, wastageQuantity: null, endNote: '', note: input.note, createdAtMs: nowMs, updatedAtMs: nowMs,
      };
      tx.create(store.batch(id), { ...batch, createdBy: actor.uid, costHistory: [] });
      return { result: { id, status: batch.status }, audit: { entityId: id, after: { origin: 'existing', costSen: input.costSen, quantity: input.quantity } } };
    },
  });
}

/** 新进货：一批库存 + 一笔进货支出（按购买日记入现金账；未付则之后补付款）。不自动结束旧批。 */
export async function recordIngredientPurchase(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'ingredientId', 'quantity', 'unit', 'amountSen', 'purchasedDate', 'paid', 'paymentSource', 'note']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), ingredientId: str(o, 'ingredientId', 80), quantity: quantity(o, 'quantity'), unit: str(o, 'unit', 10),
    amountSen: int(o, 'amountSen', 1, MAX_SEN), purchasedDate: optDate(o, 'purchasedDate'), paid: bool(o, 'paid'),
    paymentSource: oneOf(o, 'paymentSource', SOURCES), note: optStr(o, 'note', 200) ?? '',
  };
  return runCommand(db, {
    type: 'recordIngredientPurchase', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const ing = await ingredientFor(tx, store, input.ingredientId);
      const { date, day } = await ledgerDay(tx, store, config, input.purchasedDate, nowMs);
      const id = `bat-${input.operationId}`;
      const expenseId = `exp-${input.operationId}`;
      tx.create(store.expense(expenseId), {
        id: expenseId, category: 'purchase', description: `${ing.name} · ${input.quantity} ${input.unit}`, amountSen: input.amountSen,
        paidSen: input.paid ? input.amountSen : 0, paymentSource: input.paymentSource, businessDate: date, accrualDate: date, status: 'active',
        correctionOf: null, occurredAtMs: nowMs, recordedBy: actor.uid, ingredientBatchId: id, planItem: null, periodMonth: null, settlesExpenseId: null,
      });
      tx.create(store.batch(id), {
        id, ingredientId: ing.id, ingredientName: ing.name, category: ing.category, quantity: input.quantity, unit: input.unit, costSen: input.amountSen,
        origin: 'purchase', purchaseExpenseId: expenseId, purchasedDate: date, paid: input.paid, status: 'stocked', startedAtMs: null, endedAtMs: null,
        wastageQuantity: null, endNote: '', note: input.note, createdAtMs: nowMs, updatedAtMs: nowMs, createdBy: actor.uid, costHistory: [],
      });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, expenseId, businessDate: date }, audit: { entityId: id, after: { expenseId, amountSen: input.amountSen, paid: input.paid } } };
    },
  });
}

/** 启用库存批次（换批）：另填实际开始使用时间；逐个确认旧批已用完或继续用（可两批同时使用）。不记任何支出。 */
export async function startBatch(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'batchId', 'startedAtMs', 'previous']);
  if (!Array.isArray(o.previous) || o.previous.length > 5) throw bad('previous 必须是最多 5 项的数组');
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), batchId: str(o, 'batchId', 80), startedAtMs: int(o, 'startedAtMs', 0, 4_102_444_800_000),
    previous: (o.previous as unknown[]).map((p, i) => {
      const x = obj(p, ['batchId', 'action', 'endedAtMs', 'wastageQuantity', 'endNote'], `previous[${i}]`);
      return {
        batchId: str(x, 'batchId', 80), action: oneOf(x, 'action', ['finished', 'continue'] as const), endedAtMs: optInt(x, 'endedAtMs', 0, 4_102_444_800_000),
        wastageQuantity: x.wastageQuantity === undefined || x.wastageQuantity === null ? null : quantity(x, 'wastageQuantity'), endNote: optStr(x, 'endNote', 200) ?? '',
      };
    }),
  };
  if (new Set(input.previous.map((p) => p.batchId)).size !== input.previous.length || input.previous.some((p) => p.batchId === input.batchId)) throw bad('旧批重复');
  return runCommand(db, {
    type: 'startBatch', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      checkTime(input.startedAtMs, nowMs, '开始使用时间');
      const next = await getBatch(tx, store, input.batchId);
      const prev = await Promise.all(input.previous.map(async (p) => ({ ...p, batch: await getBatch(tx, store, p.batchId) })));
      const err = validateStartBatch(next, input.startedAtMs, prev);
      if (err) throw new CommandError('BATCH_STATE', err);
      // 同食材仍在使用、但没有被确认处理的旧批：要求明确选择，避免默默叠加。
      const inUse = await tx.get(store.root.collection('ingredientBatches').where('ingredientId', '==', next.ingredientId).where('status', '==', 'in_use'));
      const unhandled = inUse.docs.map((d) => d.id).filter((id) => !input.previous.some((p) => p.batchId === id));
      if (unhandled.length) throw new CommandError('BATCH_STATE', '还有在用的旧批没有确认（已用完或继续用）', { unhandled });
      for (const p of prev) {
        if (p.endedAtMs !== null) checkTime(p.endedAtMs, nowMs, '旧批结束时间');
        if (p.action === 'finished') {
          tx.update(store.batch(p.batchId), { status: 'finished', endedAtMs: p.endedAtMs ?? input.startedAtMs, wastageQuantity: p.wastageQuantity, endNote: p.endNote, updatedAtMs: nowMs });
        }
      }
      tx.update(store.batch(input.batchId), { status: 'in_use', startedAtMs: input.startedAtMs, updatedAtMs: nowMs });
      return {
        result: { id: input.batchId, finished: prev.filter((p) => p.action === 'finished').map((p) => p.batchId), continued: prev.filter((p) => p.action === 'continue').map((p) => p.batchId) },
        audit: { entityId: input.batchId, before: { status: 'stocked' }, after: { status: 'in_use', startedAtMs: input.startedAtMs, previous: input.previous } },
      };
    },
  });
}

/** 旧批用完：记录实际结束时间，可补损耗数量与备注。 */
export async function finishBatch(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'batchId', 'endedAtMs', 'wastageQuantity', 'endNote']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), batchId: str(o, 'batchId', 80), endedAtMs: int(o, 'endedAtMs', 0, 4_102_444_800_000),
    wastageQuantity: o.wastageQuantity === undefined || o.wastageQuantity === null ? null : quantity(o, 'wastageQuantity'), endNote: optStr(o, 'endNote', 200) ?? '',
  };
  return runCommand(db, {
    type: 'finishBatch', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      checkTime(input.endedAtMs, nowMs, '结束时间');
      const b = await getBatch(tx, store, input.batchId);
      if (b.status !== 'in_use' || b.startedAtMs === null) throw new CommandError('BATCH_STATE', '只有使用中的批次可以结束');
      if (input.endedAtMs <= b.startedAtMs) throw new CommandError('BATCH_STATE', '结束时间必须晚于开始使用时间');
      if (input.wastageQuantity !== null && input.wastageQuantity > b.quantity) throw bad('损耗数量不能超过整批数量');
      tx.update(store.batch(input.batchId), { status: 'finished', endedAtMs: input.endedAtMs, wastageQuantity: input.wastageQuantity, endNote: input.endNote, updatedAtMs: nowMs });
      return { result: { id: input.batchId }, audit: { entityId: input.batchId, before: { status: 'in_use' }, after: { status: 'finished', endedAtMs: input.endedAtMs, wastageQuantity: input.wastageQuantity } } };
    },
  });
}

/** 补填 / 更正首次录入批次的成本（进货批次的成本来自支出，需作废重记）。保留修改历史。 */
export async function setBatchCost(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'batchId', 'costSen', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), batchId: str(o, 'batchId', 80), costSen: int(o, 'costSen', 0, MAX_SEN), reason: optStr(o, 'reason', 200) ?? '' };
  return runCommand(db, {
    type: 'setBatchCost', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const snap = await tx.get(store.batch(input.batchId));
      const b = snap.data() as BatchDoc | undefined;
      if (!b) throw new CommandError('NOT_FOUND', '批次不存在');
      if (b.origin !== 'existing') throw new CommandError('LINKED_TO_BATCH', '进货批次的成本来自进货支出，请作废后重新记录');
      if (b.status === 'voided') throw new CommandError('BATCH_STATE', '批次已作废');
      if (b.costSen !== null && input.reason.trim().length < 2) throw new CommandError('REASON_REQUIRED', '更正已有成本需要写明原因');
      const history = [...((snap.data()?.costHistory as unknown[]) ?? []), { costSen: b.costSen, atMs: nowMs, by: actor.uid, reason: input.reason }];
      tx.update(store.batch(input.batchId), { costSen: input.costSen, costHistory: history, updatedAtMs: nowMs });
      return { result: { id: input.batchId }, audit: { entityId: input.batchId, before: { costSen: b.costSen }, after: { costSen: input.costSen, reason: input.reason } } };
    },
  });
}

/** 作废批次（录错）：进货批次同时作废对应支出（其营业日必须未关账）。不硬删除。 */
export async function voidBatch(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'batchId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), batchId: str(o, 'batchId', 80), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'voidBatch', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const b = await getBatch(tx, store, input.batchId);
      if (b.status === 'voided') return { result: { id: input.batchId, status: 'voided' }, audit: { entityId: input.batchId } };
      let expense: Record<string, unknown> | undefined;
      let day: { exists: boolean } | null = null;
      if (b.purchaseExpenseId) {
        expense = (await tx.get(store.expense(b.purchaseExpenseId))).data();
        if (expense && expense.status === 'active') {
          const settled = await tx.get(store.root.collection('expenses').where('settlesExpenseId', '==', b.purchaseExpenseId).where('status', '==', 'active'));
          if (!settled.empty) throw new CommandError('ALREADY_SETTLED', '这笔进货已补登付款，请先作废补付款记录');
          day = await requireDayOpen(tx, store, expense.businessDate as string);
        }
      }
      if (expense && day) {
        tx.update(store.expense(b.purchaseExpenseId!), { status: 'voided', voidReason: input.reason, voidedAtMs: nowMs, voidedBy: actor.uid });
        markDayActivity(tx, store, expense.businessDate as string, day, nowMs);
      }
      tx.update(store.batch(input.batchId), { status: 'voided', voidReason: input.reason, statusBeforeVoid: b.status, updatedAtMs: nowMs });
      return { result: { id: input.batchId, status: 'voided' }, audit: { entityId: input.batchId, before: { status: b.status }, after: { status: 'voided', reason: input.reason, expenseVoided: Boolean(expense && day) } } };
    },
  });
}

// ───────────────────────── 日常开支 ─────────────────────────

/** 设置起租月份 / 员工工资启用。同步写入固定费用摊销计划，之后的日结按租金阶段分摊（已关账的不变）。 */
export async function setExpensePlan(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'rentStartMonth', 'staffEnabled']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), rentStartMonth: optMonth(o, 'rentStartMonth'), staffEnabled: bool(o, 'staffEnabled') };
  return runCommand(db, {
    type: 'setExpensePlan', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const before = await loadPlan(tx, store);
      const finance = (await tx.get(store.configFinance)).data();
      const plan: ExpensePlan = { ...before, rentStartMonth: input.rentStartMonth, staff: { ...before.staff, enabled: input.staffEnabled } };
      tx.set(store.configExpensePlan, { plan, updatedAtMs: nowMs, updatedBy: actor.uid });
      const policy: FixedCostPolicy = { ...((finance?.fixedCostPolicy as FixedCostPolicy | undefined) ?? DEFAULT_FIXED_COST), schedule: scheduleFromPlan(plan) };
      tx.set(store.configFinance, { fixedCostPolicy: policy }, { merge: true });
      return { result: { plan }, audit: { entityId: 'config/expensePlan', before: { rentStartMonth: before.rentStartMonth, staffEnabled: before.staff.enabled }, after: { rentStartMonth: plan.rentStartMonth, staffEnabled: plan.staff.enabled } } };
    },
  });
}

/** 租金 / 冰箱电费按月登记付款：同一月份只能有一笔有效付款；开档成本已付的同月租金不再收。 */
export async function recordRecurringPayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'item', 'month', 'amountSen', 'paymentSource', 'businessDate']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), item: oneOf(o, 'item', RECURRING_ITEMS), month: optMonth(o, 'month'),
    amountSen: int(o, 'amountSen', 1, MAX_SEN), paymentSource: oneOf(o, 'paymentSource', SOURCES), businessDate: optDate(o, 'businessDate'),
  };
  if (!input.month) throw bad('month 必填');
  const month = input.month;
  return runCommand(db, {
    type: 'recordRecurringPayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const { slotRef, slot } = await assertRecurringOpen(tx, store, input.item, month, businessDateOf(nowMs, config.businessDay));
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      const id = `exp-${input.operationId}`;
      tx.create(store.expense(id), {
        id, category: 'fixed_payment', description: `${month} ${input.item === 'rent' ? '档口租金' : '冰箱额外电费'}`, amountSen: input.amountSen, paidSen: input.amountSen,
        paymentSource: input.paymentSource, businessDate: date, accrualDate: date, status: 'active', correctionOf: slot?.expenseId ?? null, occurredAtMs: nowMs,
        recordedBy: actor.uid, planItem: input.item, periodMonth: month, ingredientBatchId: null, settlesExpenseId: null,
      });
      tx.set(slotRef, { item: input.item, month, expenseId: id, updatedAtMs: nowMs, history: [...((slot?.history as string[]) ?? []), id] }, { merge: true });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, businessDate: date }, audit: { entityId: id, after: { item: input.item, month, amountSen: input.amountSen } } };
    },
  });
}

/**
 * 某月租金 / 冰箱电费是否还能登记一笔付款（recordRecurringPayment 与 AI 记成本共用）：
 * 已设起租月、不早于起租、最多预付下个月、该月没有有效付款、没被开档租金覆盖、没被旧付款抵扣完。
 */
export async function assertRecurringOpen(tx: Transaction, store: StoreRefs, item: (typeof RECURRING_ITEMS)[number], month: string, today: string) {
  const plan = await loadPlan(tx, store);
  if (!plan.rentStartMonth) throw new CommandError('INVALID_TRANSITION', '请先设置起租月份');
  if (month < plan.rentStartMonth) throw bad('起租之前的月份不需要登记');
  if (month > nextMonth(monthOf(today))) throw bad('最多只能预付下个月');
  const slotRef = store.recurringSlot(item, month);
  const slot = (await tx.get(slotRef)).data();
  if (slot?.expenseId) {
    const prev = (await tx.get(store.expense(slot.expenseId))).data();
    if (prev && prev.status === 'active') throw new CommandError('PERIOD_ALREADY_PAID', `${month} 已登记过付款`, { expenseId: slot.expenseId });
  }
  const covered = item === 'rent' ? startupSummary(await loadStartup(tx, store)).rentByMonth[month] ?? 0 : 0;
  const row = monthlyPlanRows(plan, month, [], { [month]: covered }).find((r) => r.item === item)!;
  if (row.state === 'covered') throw new CommandError('COVERED_BY_STARTUP', `${month} 的租金已在开档成本中付过`);
  // 老板已把旧付款归属到这个月：已抵扣完就不能再登记，避免同月重复计费。
  const linked = slotLinkedSen(slot);
  if (linked > 0 && row.outstandingSen - linked <= 0) throw new CommandError('PERIOD_ALREADY_PAID', `${month} 已由旧付款抵扣 ${linked / 100} 令吉`);
  return { slotRef, slot };
}

function nextMonth(m: string) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

/** 煤气、杂费按实际金额；员工工资需先启用，按实际出勤天数登记（预算不会自动变成工资）。 */
export async function recordPlanExpense(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'item', 'description', 'amountSen', 'paid', 'paymentSource', 'businessDate', 'accrualDate', 'workDays']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), item: oneOf(o, 'item', ['wage', 'gas', 'misc'] as const), description: optStr(o, 'description', 120) ?? '',
    amountSen: int(o, 'amountSen', 1, MAX_SEN), paid: bool(o, 'paid'), paymentSource: oneOf(o, 'paymentSource', SOURCES),
    businessDate: optDate(o, 'businessDate'), accrualDate: optDate(o, 'accrualDate'), workDays: optInt(o, 'workDays', 1, 31),
  };
  if (input.item === 'wage' && input.workDays === null) throw bad('工资需填写出勤天数');
  return runCommand(db, {
    type: 'recordPlanExpense', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      if (input.item === 'wage' && !(await loadPlan(tx, store)).staff.enabled) throw new CommandError('STAFF_NOT_ENABLED', '员工工资尚未启用');
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      const accrual = input.accrualDate ?? date;
      if (accrual > businessDateOf(nowMs, config.businessDay)) throw bad('归属日不能是未来');
      const label = { wage: '员工工资', gas: '煤气', misc: '杂费' }[input.item];
      const id = `exp-${input.operationId}`;
      tx.create(store.expense(id), {
        id, category: 'opex', description: input.description.trim() || (input.item === 'wage' ? `${label} · ${input.workDays} 天` : label), amountSen: input.amountSen,
        paidSen: input.paid ? input.amountSen : 0, paymentSource: input.paymentSource, businessDate: date, accrualDate: accrual, status: 'active', correctionOf: null,
        occurredAtMs: nowMs, recordedBy: actor.uid, planItem: input.item, periodMonth: monthOf(accrual), ingredientBatchId: null, settlesExpenseId: null, workDays: input.workDays,
      });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, businessDate: date }, audit: { entityId: id, after: { item: input.item, amountSen: input.amountSen, paid: input.paid } } };
    },
  });
}

/** 补登付款：给未付清的支出（进货、煤气、杂费、工资）记一笔付款，按付款日进现金账；不改原记录金额。 */
export async function settleExpense(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'expenseId', 'paymentSource', 'businessDate']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), expenseId: str(o, 'expenseId', 80), paymentSource: oneOf(o, 'paymentSource', SOURCES), businessDate: optDate(o, 'businessDate') };
  return runCommand(db, {
    type: 'settleExpense', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const orig = (await tx.get(store.expense(input.expenseId))).data() as PlanExpense | undefined;
      if (!orig || orig.status !== 'active' || orig.settlesExpenseId) throw new CommandError('NOT_FOUND', '原支出不存在或已作废');
      const settled = await tx.get(store.root.collection('expenses').where('settlesExpenseId', '==', input.expenseId).where('status', '==', 'active'));
      const outstanding = orig.amountSen - orig.paidSen - settled.docs.reduce((s, d) => s + (d.data().paidSen as number), 0);
      if (outstanding <= 0) throw new CommandError('ALREADY_SETTLED', '这笔支出已付清');
      const { date, day } = await ledgerDay(tx, store, config, input.businessDate, nowMs);
      const id = `exp-${input.operationId}`;
      tx.create(store.expense(id), {
        id, category: orig.category, description: `补付款 · ${orig.description}`, amountSen: 0, paidSen: outstanding, paymentSource: input.paymentSource,
        businessDate: date, accrualDate: date, status: 'active', correctionOf: null, occurredAtMs: nowMs, recordedBy: actor.uid,
        planItem: orig.planItem ?? null, periodMonth: orig.periodMonth ?? null, ingredientBatchId: orig.ingredientBatchId ?? null, settlesExpenseId: input.expenseId,
      });
      if (orig.ingredientBatchId) tx.update(store.batch(orig.ingredientBatchId), { paid: true, updatedAtMs: nowMs });
      markDayActivity(tx, store, date, day, nowMs);
      return { result: { id, paidSen: outstanding, businessDate: date }, audit: { entityId: id, after: { settles: input.expenseId, paidSen: outstanding } } };
    },
  });
}

// ───────────────────────── 开档成本 ─────────────────────────

const GROUPS = ['rent_deposit', 'vaccine', 'kitchenware', 'training', 'supplier_debt', 'signboard', 'other'] as const;
const PAY = ['paid', 'unpaid', 'unverified'] as const;

function details(o: Raw) {
  const v = o.details;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 30) throw bad('details 最多 30 项');
  return v.map((d, i) => {
    const x = obj(d, ['label', 'amountSen'], `details[${i}]`);
    return { label: str(x, 'label', 60), amountSen: int(x, 'amountSen', 1, MAX_SEN) };
  });
}

/** 写入老板提供的开档清单。幂等：已有记录（含作废、已更正）不覆盖；重复调用不重复写入。 */
export async function seedStartupCosts(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId') };
  return runCommand(db, {
    type: 'seedStartupCosts', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const marker = (await tx.get(store.configStartup)).data();
      const snaps = await Promise.all(STARTUP_SEED.map((s) => tx.get(store.startupCost(startupSeedId(s.seedKey!)))));
      if (marker?.seededAtMs) return { result: { created: 0, skipped: STARTUP_SEED.length }, audit: { entityId: 'config/startup' } };
      let created = 0;
      STARTUP_SEED.forEach((s, i) => {
        if (snaps[i].exists) return;
        const id = startupSeedId(s.seedKey!);
        tx.create(store.startupCost(id), { ...s, id, status: 'active', correctionOf: null, paidDate: null, createdAtMs: nowMs, createdBy: actor.uid, paymentHistory: [] });
        created++;
      });
      tx.set(store.configStartup, { seededAtMs: nowMs, seededBy: actor.uid }, { merge: true });
      return { result: { created, skipped: STARTUP_SEED.length - created }, audit: { entityId: 'config/startup', after: { created } } };
    },
  });
}

function startupFields(o: Raw) {
  const amountSen = int(o, 'amountSen', 1, MAX_SEN);
  const d = details(o);
  const err = validateStartupDetails(amountSen, d);
  if (err) throw bad(err);
  return { group: oneOf(o, 'group', GROUPS), title: str(o, 'title', 60).trim(), amountSen, details: d, note: optStr(o, 'note', 200) ?? '' };
}

/** 追加开档投入：总投入与回本目标随之更新。 */
export async function addStartupCost(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'group', 'title', 'amountSen', 'details', 'note', 'paymentStatus', 'paidDate']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), ...startupFields(o), paymentStatus: oneOf(o, 'paymentStatus', PAY), paidDate: optDate(o, 'paidDate') };
  return runCommand(db, {
    type: 'addStartupCost', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const id = `startup-${input.operationId}`;
      tx.create(store.startupCost(id), {
        id, group: input.group, title: input.title, amountSen: input.amountSen, details: input.details, paymentStatus: input.paymentStatus,
        paidDate: input.paymentStatus === 'paid' ? input.paidDate : null, isDebt: input.group === 'supplier_debt', rentSen: null, depositSen: null, rentMonth: null,
        note: input.note, status: 'active', correctionOf: null, seedKey: null, createdAtMs: nowMs, createdBy: actor.uid, paymentHistory: [],
      });
      return { result: { id }, audit: { entityId: id, after: { amountSen: input.amountSen, title: input.title } } };
    },
  });
}

/** 更正：原记录作废（保留原因），另建一条更正记录关联原记录；付款状态与拆分沿用。 */
export async function correctStartupCost(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'id', 'reason', 'group', 'title', 'amountSen', 'details', 'note']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), id: str(o, 'id', 80), reason: str(o, 'reason', 200, 2), ...startupFields(o) };
  return runCommand(db, {
    type: 'correctStartupCost', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const orig = (await tx.get(store.startupCost(input.id))).data() as StartupCostDoc | undefined;
      if (!orig) throw new CommandError('NOT_FOUND', '开档项目不存在');
      if (orig.status !== 'active') throw new CommandError('INVALID_TRANSITION', '这条记录已更正或作废');
      const split = orig.rentSen !== null && orig.rentSen + (orig.depositSen ?? 0) === input.amountSen && input.group === 'rent_deposit';
      const id = `startup-${input.operationId}`;
      // 已确认属于这一项的付款：在同一事务里迁移到更正后的项目（不重置可关联额度、不留下指向作废项目的关联）。
      // 更正后的金额不能小于已关联的付款，否则请先取消部分关联。与 linkExpense / unlinkExpense 在同一文档上串行。
      const linked = (orig.linkedExpenses ?? []).filter((l) => l.status === 'active');
      const linkedSen = linked.reduce((s, l) => s + l.amountSen, 0);
      if (input.amountSen < linkedSen) throw new CommandError('LINK_REJECTED', `更正后金额小于已关联的付款 ${linkedSen / 100} 令吉，请先取消部分关联`);
      const expenseIds = [...new Set(linked.map((l) => l.expenseId))];
      const linkSnaps = expenseIds.length ? await tx.getAll(...expenseIds.map((e) => store.expenseLink(e))) : [];
      const moved = new Set(linked.map((l) => l.linkId));
      tx.update(store.startupCost(input.id), {
        status: 'voided', voidReason: input.reason, supersededBy: id, voidedAtMs: nowMs, voidedBy: actor.uid,
        linkedExpenses: (orig.linkedExpenses ?? []).map((l) => (moved.has(l.linkId) ? { ...l, status: 'migrated', migratedTo: id } : l)),
      });
      tx.create(store.startupCost(id), {
        id, group: input.group, title: input.title, amountSen: input.amountSen, details: input.details, paymentStatus: orig.paymentStatus, paidDate: orig.paidDate,
        isDebt: input.group === 'supplier_debt', rentSen: split ? orig.rentSen : null, depositSen: split ? orig.depositSen : null, rentMonth: split ? orig.rentMonth : null,
        note: input.note, status: 'active', correctionOf: input.id, seedKey: null, createdAtMs: nowMs, createdBy: actor.uid, paymentHistory: [],
        linkedExpenses: linked.map((l) => ({ ...l, migratedFrom: input.id })),
      });
      for (const snap of linkSnaps) {
        const links = (snap.data()?.links as (ExpenseLink & { startupIdHistory?: string[] })[] | undefined) ?? [];
        tx.update(snap.ref, {
          links: links.map((l) => (moved.has(l.linkId) && l.kind === 'startup' ? { ...l, startupId: id, startupIdHistory: [...(l.startupIdHistory ?? []), input.id] } : l)),
          updatedAtMs: nowMs,
        });
      }
      return {
        result: { id, migratedLinks: linked.length },
        audit: { entityId: id, before: { id: input.id, amountSen: orig.amountSen, title: orig.title }, after: { amountSen: input.amountSen, title: input.title, reason: input.reason, migratedLinks: [...moved] } },
      };
    },
  });
}

/** 付款状态：已付 / 待付 / 待核实。只改状态，不改总投入（欠账清还不再次增加投入）。 */
export async function setStartupPayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'id', 'paymentStatus', 'paidDate']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), id: str(o, 'id', 80), paymentStatus: oneOf(o, 'paymentStatus', PAY), paidDate: optDate(o, 'paidDate') };
  if (input.paymentStatus === 'paid' && !input.paidDate) throw bad('已付需要填写付款日期');
  return runCommand(db, {
    type: 'setStartupPayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      if (input.paidDate && input.paidDate > businessDateOf(nowMs, config.businessDay)) throw bad('付款日期不能是未来');
      const snap = await tx.get(store.startupCost(input.id));
      const orig = snap.data() as StartupCostDoc | undefined;
      if (!orig || orig.status !== 'active') throw new CommandError('NOT_FOUND', '开档项目不存在或已更正');
      const history = [...((snap.data()?.paymentHistory as unknown[]) ?? []), { from: orig.paymentStatus, to: input.paymentStatus, paidDate: input.paidDate, atMs: nowMs, by: actor.uid }];
      tx.update(store.startupCost(input.id), { paymentStatus: input.paymentStatus, paidDate: input.paymentStatus === 'paid' ? input.paidDate : null, paymentHistory: history });
      return { result: { id: input.id }, audit: { entityId: input.id, before: { paymentStatus: orig.paymentStatus }, after: { paymentStatus: input.paymentStatus, paidDate: input.paidDate } } };
    },
  });
}

/** 租金与押金拆分：押金单列（可退，不算营业消耗）；租金可关联月份，避免与该月月租重复计费。 */
export async function splitStartupRent(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'id', 'rentSen', 'depositSen', 'rentMonth']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), id: str(o, 'id', 80), rentSen: int(o, 'rentSen', 0, MAX_SEN), depositSen: int(o, 'depositSen', 0, MAX_SEN), rentMonth: optMonth(o, 'rentMonth') };
  return runCommand(db, {
    type: 'splitStartupRent', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const snap = await tx.get(store.startupCost(input.id));
      const orig = snap.data() as StartupCostDoc | undefined;
      if (!orig || orig.status !== 'active') throw new CommandError('NOT_FOUND', '开档项目不存在或已更正');
      if (orig.group !== 'rent_deposit') throw bad('只有租金和押金项目可以拆分');
      if (input.rentSen + input.depositSen !== orig.amountSen) throw bad('租金 + 押金必须等于该项金额');
      if (input.rentMonth && input.rentSen === 0) throw bad('没有租金部分，不能关联月份');
      if (input.rentMonth) {
        const slot = (await tx.get(store.recurringSlot('rent', input.rentMonth))).data();
        const prev = slot?.expenseId ? (await tx.get(store.expense(slot.expenseId))).data() : undefined;
        if (prev?.status === 'active') throw new CommandError('PERIOD_ALREADY_PAID', `${input.rentMonth} 的月租已另外登记付款，请先作废那笔付款`);
      }
      const history = [...((snap.data()?.splitHistory as unknown[]) ?? []), { rentSen: orig.rentSen, depositSen: orig.depositSen, rentMonth: orig.rentMonth, atMs: nowMs, by: actor.uid }];
      tx.update(store.startupCost(input.id), { rentSen: input.rentSen, depositSen: input.depositSen, rentMonth: input.rentMonth, splitHistory: history });
      return { result: { id: input.id }, audit: { entityId: input.id, before: { rentSen: orig.rentSen, depositSen: orig.depositSen, rentMonth: orig.rentMonth }, after: { rentSen: input.rentSen, depositSen: input.depositSen, rentMonth: input.rentMonth } } };
    },
  });
}

// ───────────────────────── 目标 ─────────────────────────

/** 每日 / 每月面量目标（面团粒数）。每日目标的调整保留历史。 */
export async function setSalesTarget(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'scope', 'month', 'balls']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), scope: oneOf(o, 'scope', ['daily', 'monthly'] as const), month: optMonth(o, 'month'), balls: int(o, 'balls', 1, 100_000) };
  if (input.scope === 'monthly' && !input.month) throw bad('月目标需要月份');
  return runCommand(db, {
    type: 'setSalesTarget', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const cur = { ...DEFAULT_SALES_TARGETS, ...((await tx.get(store.configGoals)).data()?.sales ?? {}) } as SalesTargets;
      const next: SalesTargets = input.scope === 'daily'
        ? { ...cur, dailyBalls: input.balls, dailyHistory: [...cur.dailyHistory, { balls: cur.dailyBalls, atMs: nowMs }].slice(-50) }
        : { ...cur, monthly: { ...cur.monthly, [input.month!]: input.balls } };
      tx.set(store.configGoals, { sales: next, updatedAtMs: nowMs }, { merge: true });
      return { result: { sales: next }, audit: { entityId: 'config/goals', before: input.scope === 'daily' ? { dailyBalls: cur.dailyBalls } : { [input.month!]: cur.monthly[input.month!] ?? null }, after: { scope: input.scope, month: input.month, balls: input.balls } } };
    },
  });
}

/** 回本完成后，老板拟定下一个目标。服务端按真实账目复核回本已完成。 */
export async function createNextGoal(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'title', 'targetSen', 'deadline', 'note']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), title: str(o, 'title', 60).trim(), targetSen: int(o, 'targetSen', 1, MAX_SEN), deadline: optDate(o, 'deadline'), note: optStr(o, 'note', 200) ?? '' };
  return runCommand(db, {
    type: 'createNextGoal', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const today = businessDateOf(nowMs, config.businessDay);
      if (input.deadline && input.deadline < today) throw bad('期限不能早于今天');
      const [payback, goals] = await Promise.all([serverPayback(tx, store, today), tx.get(store.root.collection('goals'))]);
      if (payback.state !== 'achieved') throw new CommandError('GOAL_NOT_REACHED', payback.state === 'pending' ? `回本资料待核算：${payback.pendingReasons.join('；')}` : '开档投入尚未收回，先完成第一个目标');
      if (goals.docs.some((d) => d.data().status === 'active')) throw new CommandError('INVALID_TRANSITION', '已有进行中的目标，请先完成或放弃');
      const id = `goal-${input.operationId}`;
      // 进度基线：建立时的现金回本结余；之后新增的结余才算这个目标的进度。
      tx.create(store.goal(id), {
        id, title: input.title, targetSen: input.targetSen, deadline: input.deadline, note: input.note, status: 'active', order: goals.size + 2, createdAtMs: nowMs, createdBy: actor.uid,
        baselineRecoveredSen: payback.recoveredSen, achievedAtMs: null, achievedSnapshot: null, archivedReason: null,
      });
      if (goals.empty) tx.set(store.configGoals, { paybackAchievedAtMs: nowMs, paybackAchievedSnapshot: { recoveredSen: payback.recoveredSen, targetSen: payback.targetSen } }, { merge: true });
      return { result: { id }, audit: { entityId: id, after: { title: input.title, targetSen: input.targetSen, deadline: input.deadline } } };
    },
  });
}

// ───────────────────────── 旧账与资本支出归属、成本核算范围、目标生命周期 ─────────────────────────

type SlotLink = { linkId: string; expenseId: string; amountSen: number; status: 'active' | 'cancelled' };

/**
 * 营业费用的归属会改变其归属日的经营成本：归属日未关账时写一次营业日文档，与关账在同一文档上串行
 * （关账先提交则本命令重试后读到已关账，不再标记；快照保持原样）。已关账的营业日不改快照。
 */
async function openDayOf(tx: Transaction, store: StoreRefs, e: PlanExpense) {
  if (e.category !== 'opex') return null;
  const snap = await tx.get(store.businessDay(e.accrualDate));
  const d = snap.data();
  return d && d.state !== 'open' ? null : { exists: snap.exists };
}

function slotLinkedSen(slot: Record<string, unknown> | undefined): number {
  return ((slot?.links as SlotLink[] | undefined) ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0);
}

/** 服务端回本：与前端 paybackStatus 同一口径（含老板确认的归属）。 */
async function serverPayback(tx: Transaction, store: StoreRefs, today: string) {
  const [payments, refunds, expenses, links] = await Promise.all([
    tx.get(store.root.collection('payments')), tx.get(store.root.collection('refunds')), tx.get(store.root.collection('expenses')), tx.get(store.root.collection('expenseLinks')),
  ]);
  const startup = startupSummary(await loadStartup(tx, store));
  const sum = (s: FirebaseFirestore.QuerySnapshot) => s.docs.reduce((t, d) => t + (d.data().amountSen as number), 0);
  return paybackStatus({
    startupTotalSen: startup.totalSen, receiptsSen: sum(payments), refundsSen: sum(refunds), expenses: expenses.docs.map((d) => d.data() as PlanExpense),
    plan: await loadPlan(tx, store), startupRentByMonth: startup.rentByMonth, currentMonth: monthOf(today), links: links.docs.map((d) => d.data() as ExpenseLinkDoc),
  });
}

/**
 * 确认已有支出的归属（旧版房租 / 电费付款归入某月、付款属于某开档项目、后续资本投入）。
 * 不修改原支出（已关账营业日的快照不变）、不产生新的现金流；关联记录在 expenseLinks，
 * 同时写入月份槽 / 开档项目，三处在同一事务内串行，防止重复抵扣与并发超额。
 */
export async function linkExpense(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'expenseId', 'kind', 'item', 'month', 'startupId', 'amountSen']);
  const kind = oneOf(o, 'kind', ['recurring', 'startup', 'later_capital'] as const);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), expenseId: str(o, 'expenseId', 80), kind, amountSen: int(o, 'amountSen', 1, MAX_SEN),
    item: kind === 'recurring' ? oneOf(o, 'item', RECURRING_ITEMS) : null, month: kind === 'recurring' ? optMonth(o, 'month') : null,
    startupId: kind === 'startup' ? str(o, 'startupId', 80) : null,
  };
  if (kind === 'recurring' && !input.month) throw bad('month 必填');
  return runCommand(db, {
    type: 'linkExpense', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const expense = (await tx.get(store.expense(input.expenseId))).data() as PlanExpense | undefined;
      if (!expense) throw new CommandError('NOT_FOUND', '支出不存在');
      const day = await openDayOf(tx, store, expense);
      const [settled, linkSnap] = await Promise.all([
        tx.get(store.root.collection('expenses').where('settlesExpenseId', '==', input.expenseId).where('status', '==', 'active')),
        tx.get(store.expenseLink(input.expenseId)),
      ]);
      const settledSen = settled.docs.reduce((s, d) => s + (d.data().paidSen as number), 0);
      const existing = (linkSnap.data()?.links as ExpenseLink[] | undefined) ?? [];
      const linkId = `lnk-${input.operationId}`;
      let link: NewExpenseLink;
      let monthOutstandingSen: number | undefined;
      let startupRemainingSen: number | undefined;
      let slot: Record<string, unknown> | undefined;
      let startupItem: Record<string, unknown> | undefined;
      if (input.kind === 'recurring') {
        const plan = await loadPlan(tx, store);
        if (!plan.rentStartMonth) throw new CommandError('INVALID_TRANSITION', '请先设置起租月份');
        if (input.month! < plan.rentStartMonth) throw new CommandError('LINK_REJECTED', '起租之前的月份没有月租 / 电费');
        slot = (await tx.get(store.recurringSlot(input.item!, input.month!))).data();
        const slotPayment = slot?.expenseId ? ((await tx.get(store.expense(slot.expenseId as string))).data() as PlanExpense | undefined) : undefined;
        const covered = input.item === 'rent' ? startupSummary(await loadStartup(tx, store)).rentByMonth[input.month!] ?? 0 : 0;
        const row = monthlyPlanRows(plan, input.month!, slotPayment ? [slotPayment] : [], { [input.month!]: covered }).find((r) => r.item === input.item)!;
        monthOutstandingSen = Math.max(0, row.outstandingSen - slotLinkedSen(slot));
        link = { kind: 'recurring', item: input.item!, month: input.month!, amountSen: input.amountSen };
      } else if (input.kind === 'startup') {
        startupItem = (await tx.get(store.startupCost(input.startupId!))).data();
        if (!startupItem || startupItem.status !== 'active') throw new CommandError('NOT_FOUND', '开档项目不存在或已更正');
        const linked = ((startupItem.linkedExpenses as SlotLink[] | undefined) ?? []).filter((l) => l.status === 'active').reduce((s, l) => s + l.amountSen, 0);
        startupRemainingSen = (startupItem.amountSen as number) - linked;
        link = { kind: 'startup', startupId: input.startupId!, amountSen: input.amountSen };
      } else {
        link = { kind: 'later_capital', amountSen: input.amountSen };
      }
      const err = validateExpenseLink({ expense, settledSen, existing, link, monthOutstandingSen, startupRemainingSen });
      if (err) throw new CommandError(/应付/.test(err) ? 'PERIOD_ALREADY_PAID' : 'LINK_REJECTED', err);
      const full = { ...link, linkId, status: 'active', createdAtMs: nowMs, createdBy: actor.uid } as unknown as ExpenseLink;
      if (day) markDayActivity(tx, store, expense.accrualDate, day, nowMs);
      tx.set(store.expenseLink(input.expenseId), { expenseId: input.expenseId, links: [...existing, full], updatedAtMs: nowMs });
      const ref: SlotLink = { linkId, expenseId: input.expenseId, amountSen: input.amountSen, status: 'active' };
      if (input.kind === 'recurring') {
        tx.set(store.recurringSlot(input.item!, input.month!), { item: input.item, month: input.month, links: [...((slot?.links as SlotLink[] | undefined) ?? []), ref], updatedAtMs: nowMs }, { merge: true });
      } else if (input.kind === 'startup') {
        tx.update(store.startupCost(input.startupId!), { linkedExpenses: [...((startupItem!.linkedExpenses as SlotLink[] | undefined) ?? []), ref] });
      }
      return { result: { linkId }, audit: { entityId: input.expenseId, after: full } };
    },
  });
}

/** 取消归属：只把关联改为 cancelled 并写原因，保留历史；原支出不变。 */
export async function unlinkExpense(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'expenseId', 'linkId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), expenseId: str(o, 'expenseId', 80), linkId: str(o, 'linkId', 80), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'unlinkExpense', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const doc = (await tx.get(store.expenseLink(input.expenseId))).data();
      const links = (doc?.links as ExpenseLink[] | undefined) ?? [];
      const expense = (await tx.get(store.expense(input.expenseId))).data() as PlanExpense | undefined;
      const day = expense ? await openDayOf(tx, store, expense) : null;
      const l = links.find((x) => x.linkId === input.linkId);
      if (!l) throw new CommandError('NOT_FOUND', '关联不存在');
      if (l.status !== 'active') return { result: { linkId: input.linkId, status: 'cancelled' }, audit: { entityId: input.expenseId } };
      const cancel = <T extends { linkId: string }>(xs: T[]) => xs.map((x) => (x.linkId === input.linkId ? { ...x, status: 'cancelled', cancelledAtMs: nowMs, cancelledBy: actor.uid, cancelReason: input.reason } : x));
      const slotRef = l.kind === 'recurring' ? store.recurringSlot(l.item, l.month) : null;
      const slot = slotRef ? (await tx.get(slotRef)).data() : undefined;
      const item = l.kind === 'startup' ? (await tx.get(store.startupCost(l.startupId))).data() : undefined;
      tx.set(store.expenseLink(input.expenseId), { links: cancel(links), updatedAtMs: nowMs }, { merge: true });
      if (day && expense) markDayActivity(tx, store, expense.accrualDate, day, nowMs);
      if (slotRef) tx.set(slotRef, { links: cancel((slot?.links as SlotLink[] | undefined) ?? []), updatedAtMs: nowMs }, { merge: true });
      if (l.kind === 'startup' && item) tx.update(store.startupCost(l.startupId), { linkedExpenses: cancel((item.linkedExpenses as SlotLink[] | undefined) ?? []) });
      return { result: { linkId: input.linkId, status: 'cancelled' }, audit: { entityId: input.expenseId, before: l, after: { status: 'cancelled', reason: input.reason } } };
    },
  });
}

/** 老板确认成本核算范围（必需食材）。实际启用过的食材在计算时自动纳入，不必在此勾选。 */
export async function setCostCoverage(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'ingredientIds']);
  if (!Array.isArray(o.ingredientIds) || o.ingredientIds.length > 100 || o.ingredientIds.some((x) => typeof x !== 'string' || x.length > 80)) throw bad('ingredientIds 必须是最多 100 个字符串');
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), ingredientIds: [...new Set(o.ingredientIds as string[])].sort() };
  return runCommand(db, {
    type: 'setCostCoverage', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      for (const id of input.ingredientIds) await ingredientFor(tx, store, id);
      const before = (await tx.get(store.configCostCoverage)).data();
      const coverage: CostCoverage = { requiredIngredientIds: input.ingredientIds, confirmedAtMs: nowMs };
      tx.set(store.configCostCoverage, { coverage, updatedBy: actor.uid, history: [...((before?.history as unknown[]) ?? []), { ...(before?.coverage ?? {}), replacedAtMs: nowMs }].slice(-30) });
      return { result: { coverage }, audit: { entityId: 'config/costCoverage', before: before?.coverage ?? null, after: coverage } };
    },
  });
}

/** 目标完成：服务端按同一口径复核进度达标（回本资料待核算时不能确认）。 */
export async function completeGoal(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'goalId']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), goalId: str(o, 'goalId', 80) };
  return runCommand(db, {
    type: 'completeGoal', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const config = await loadStoreConfig(tx, store);
      const goal = (await tx.get(store.goal(input.goalId))).data() as GoalDoc | undefined;
      if (!goal) throw new CommandError('NOT_FOUND', '目标不存在');
      if (goal.status !== 'active') throw new CommandError('INVALID_TRANSITION', '目标不在进行中');
      const payback = await serverPayback(tx, store, businessDateOf(nowMs, config.businessDay));
      if (payback.state === 'pending') throw new CommandError('GOAL_NOT_REACHED', `资料待核算：${payback.pendingReasons.join('；')}`);
      const p = goalProgress(goal, payback.recoveredSen);
      if (!p.reached) throw new CommandError('GOAL_NOT_REACHED', '目标进度尚未达到');
      const snapshot = { progressSen: p.progressSen, recoveredSen: payback.recoveredSen };
      tx.update(store.goal(input.goalId), { status: 'achieved', achievedAtMs: nowMs, achievedSnapshot: snapshot });
      return { result: { id: input.goalId, ...snapshot }, audit: { entityId: input.goalId, before: { status: 'active' }, after: { status: 'achieved', ...snapshot } } };
    },
  });
}

/** 放弃 / 改订目标：标为 archived 并写原因，记录保留；之后可以拟定新目标。 */
export async function archiveGoal(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'goalId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), goalId: str(o, 'goalId', 80), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'archiveGoal', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const goal = (await tx.get(store.goal(input.goalId))).data() as GoalDoc | undefined;
      if (!goal) throw new CommandError('NOT_FOUND', '目标不存在');
      if (goal.status !== 'active') throw new CommandError('INVALID_TRANSITION', '目标不在进行中');
      tx.update(store.goal(input.goalId), { status: 'archived', archivedReason: input.reason, archivedAtMs: nowMs });
      return { result: { id: input.goalId }, audit: { entityId: input.goalId, before: { status: 'active' }, after: { status: 'archived', reason: input.reason } } };
    },
  });
}
