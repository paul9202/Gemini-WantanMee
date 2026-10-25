/**
 * 2026-10-25 复核问题的回归测试：
 * 1. 食材未录全不能显示经营利润（成本覆盖 / 完整性）。
 * 2. 旧版已付房租需老板确认归属，不能一边扣已付、一边再算未付。
 * 3. 资本支出不算经营支出；关联开档项目的投入不能既是目标又被扣一次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BatchDoc, coverageInRange, DEFAULT_EXPENSE_PLAN, DEFAULT_FIXED_COST, ExpenseLinkDoc, ExpensePlan, paybackStatus, PlanExpense, validateExpenseLink,
  zonedLocalToMs, DAY_MS, classifyExpenses, monthlyPlanRows, goalProgress, ledgerEvents, summarizePeriod,
} from '../../../domain';
import { rangeFigures } from './model';
import type { FinanceData } from './data';

const TZ = 'Asia/Kuala_Lumpur';
const policy = { timeZone: TZ, cutoverMinutes: 240 };
const t = (local: string) => zonedLocalToMs(local, TZ)!;
const DAY = { start: '2026-10-25', endExclusive: '2026-10-26' };
const NOW = t('2026-10-27T12:00');

const batch = (p: Partial<BatchDoc>): BatchDoc => ({
  id: 'b', ingredientId: 'ing-salt', ingredientName: '盐', category: 'seasoning', quantity: 1, unit: '包', costSen: 100, origin: 'existing',
  purchaseExpenseId: null, purchasedDate: null, paid: null, status: 'finished', startedAtMs: t('2026-10-24T04:00'), endedAtMs: t('2026-10-27T04:00'),
  wastageQuantity: null, endNote: '', note: '', createdAtMs: 0, updatedAtMs: 0, ...p,
});

function finance(p: Partial<FinanceData>): FinanceData {
  return {
    plan: DEFAULT_EXPENSE_PLAN, sales: { unit: 'dough_ball', dailyBalls: 50, monthly: {}, dailyHistory: [] }, goalsConfig: {}, startupSeeded: true,
    fixedPolicy: DEFAULT_FIXED_COST, ingredients: [], batches: [], startup: [], goals: [], expenses: [], refunds: [], orders: [], costEvents: [], wastage: [],
    recentStart: '2026-10-19', payments: [{ id: 'p', orderId: 'o', businessDate: '2026-10-25', method: 'unspecified', amountSen: 10_000, occurredAtMs: 0 }],
    links: [], coverage: { requiredIngredientIds: [], confirmedAtMs: null }, ...p,
  } as FinanceData;
}

// ───────────── 1. 食材覆盖 ─────────────

test('复现 1：只录了一批 RM1 的盐，不能给出 RM69.97 的经营利润', () => {
  const f = rangeFigures(finance({ batches: [batch({})] }), DAY, policy, NOW);
  assert.equal(f.profitSen, null, '未证实成本完整，利润必须是待核算');
});

test('覆盖：未确认核算范围 → unconfirmed；确认后缺食材 / 区间缺口 / 成本未知 / 仍在用 → incomplete；全部覆盖才 complete', () => {
  const day = { startMs: t('2026-10-25T04:00'), endMs: t('2026-10-26T04:00') };
  const noodle = (p: Partial<BatchDoc>) => batch({ id: `n-${Math.random()}`, ingredientId: 'ing-thin-noodle', ingredientName: '细面', category: 'noodle', costSen: 9_600, ...p });
  const pork = (p: Partial<BatchDoc>) => batch({ id: `p-${Math.random()}`, ingredientId: 'ing-minced-pork', ingredientName: '肉碎', category: 'wonton', costSen: 5_000, ...p });
  const confirmed = { requiredIngredientIds: ['ing-thin-noodle', 'ing-minced-pork'], confirmedAtMs: 1 };

  const unconfirmed = coverageInRange([noodle({}), pork({})], { requiredIngredientIds: confirmed.requiredIngredientIds, confirmedAtMs: null }, day.startMs, day.endMs, NOW);
  assert.equal(unconfirmed.state, 'unconfirmed');

  const missing = coverageInRange([noodle({})], confirmed, day.startMs, day.endMs, NOW);
  assert.equal(missing.state, 'incomplete');
  assert.equal(missing.required.find((r) => r.ingredientId === 'ing-minced-pork')!.state, 'missing');

  // 实际启用过的食材（盐）自动纳入：盐只覆盖到 10/25 12:00 → 缺口。
  const gap = coverageInRange([noodle({}), pork({}), batch({ endedAtMs: t('2026-10-25T12:00') })], confirmed, day.startMs, day.endMs, NOW);
  assert.equal(gap.required.find((r) => r.ingredientId === 'ing-salt')!.state, 'gap');
  assert.equal(gap.state, 'incomplete');

  const unknown = coverageInRange([noodle({ costSen: null }), pork({})], confirmed, day.startMs, day.endMs, NOW);
  assert.equal(unknown.required.find((r) => r.ingredientId === 'ing-thin-noodle')!.state, 'cost_unknown');
  assert.equal(unknown.state, 'incomplete');

  const running = coverageInRange([noodle({ status: 'in_use', endedAtMs: null }), pork({})], confirmed, day.startMs, day.endMs, NOW);
  assert.equal(running.required.find((r) => r.ingredientId === 'ing-thin-noodle')!.state, 'running');

  // 两批首尾相接（换批）视为连续覆盖。
  const chained = coverageInRange([
    noodle({ endedAtMs: t('2026-10-25T15:00') }), noodle({ startedAtMs: t('2026-10-25T15:00') }), pork({}),
  ], confirmed, day.startMs, day.endMs, NOW);
  assert.equal(chained.state, 'complete');
  // 作废批次不算覆盖。
  assert.equal(coverageInRange([noodle({ status: 'voided' }), pork({})], confirmed, day.startMs, day.endMs, NOW).state, 'incomplete');

  const f = rangeFigures(finance({ batches: [noodle({}), pork({})], coverage: confirmed }), DAY, policy, NOW);
  assert.notEqual(f.profitSen, null, '核算范围已确认且全部覆盖 → 给出周期平均分摊口径的利润');
  assert.equal(f.coverage.state, 'complete');
});

// ───────────── 2. 旧版房租 ─────────────

const plan: ExpensePlan = { ...DEFAULT_EXPENSE_PLAN, rentStartMonth: '2026-10' };
const exp = (p: Partial<PlanExpense>): PlanExpense => ({
  id: 'x', category: 'opex', description: '', amountSen: 0, paidSen: 0, businessDate: '2026-10-05', accrualDate: '2026-10-05', status: 'active', ...p,
});
const legacyRent = exp({ id: 'legacy-rent', category: 'fixed_payment', description: '本月房租', amountSen: 80_000, paidSen: 80_000 });
const fridge = exp({ id: 'fridge', category: 'fixed_payment', planItem: 'fridge_power', periodMonth: '2026-10', amountSen: 10_000, paidSen: 10_000 });
const base = { startupTotalSen: 509_092, receiptsSen: 600_000, refundsSen: 0, plan, startupRentByMonth: {}, currentMonth: '2026-10' };
const link = (expenseId: string, l: ExpenseLinkDoc['links'][number]): ExpenseLinkDoc => ({ expenseId, links: [l] });

test('复现 2：旧版已付房租未确认归属时，不能既扣已付又算未付并声称已核实', () => {
  const r = paybackStatus({ ...base, expenses: [legacyRent, fridge] });
  assert.equal(r.state, 'pending', '有未确认归属的旧付款 → 待核算');
  assert.match(r.pendingReasons.join(), /旧版|归属/);
});

test('旧版房租确认归属到 2026-10 租金后：结余 RM5,100，月租不再算未付；不产生第二笔现金流', () => {
  const links = [link('legacy-rent', { linkId: 'l1', kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 80_000, status: 'active' })];
  const r = paybackStatus({ ...base, expenses: [legacyRent, fridge], links });
  assert.equal(r.paidOperatingSen, 90_000);
  assert.equal(r.unpaidOperatingSen, 0);
  assert.equal(r.recoveredSen, 510_000);
  assert.equal(r.state, 'achieved');
  const row = monthlyPlanRows(plan, '2026-10', [legacyRent, fridge], {}, links).find((x) => x.item === 'rent')!;
  assert.deepEqual([row.paidSen, row.outstandingSen, row.state], [80_000, 0, 'paid']);
  // 取消关联 → 回到待核算。
  const cancelled = [link('legacy-rent', { linkId: 'l1', kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 80_000, status: 'cancelled' })];
  assert.equal(paybackStatus({ ...base, expenses: [legacyRent, fridge], links: cancelled }).state, 'pending');
});

test('部分抵扣：旧付款 RM500 归入十月租金，十月仍欠 RM300', () => {
  const partial = exp({ id: 'legacy-part', category: 'fixed_payment', amountSen: 50_000, paidSen: 50_000 });
  const links = [link('legacy-part', { linkId: 'l', kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 50_000, status: 'active' })];
  const row = monthlyPlanRows(plan, '2026-10', [partial, fridge], {}, links).find((x) => x.item === 'rent')!;
  assert.deepEqual([row.paidSen, row.outstandingSen], [50_000, 30_000]);
  const r = paybackStatus({ ...base, receiptsSen: 550_000, expenses: [partial, fridge], links });
  assert.equal(r.unpaidOperatingSen, 30_000);
  assert.equal(r.state, 'in_progress');
});

test('归属校验：超过付款金额、同月重复、超过当月应付、开档项目超额都拒绝', () => {
  const ctx = { expense: legacyRent, settledSen: 0, existing: [] as ExpenseLinkDoc['links'] };
  assert.equal(validateExpenseLink({ ...ctx, link: { kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 80_000 }, monthOutstandingSen: 80_000 }), null);
  assert.match(validateExpenseLink({ ...ctx, link: { kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 90_000 }, monthOutstandingSen: 100_000 })!, /超过/);
  assert.match(validateExpenseLink({
    ...ctx, existing: [{ linkId: 'a', kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 10_000, status: 'active' }],
    link: { kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 10_000 }, monthOutstandingSen: 70_000,
  })!, /已关联/);
  assert.match(validateExpenseLink({ ...ctx, link: { kind: 'recurring', item: 'rent', month: '2026-10', amountSen: 80_000 }, monthOutstandingSen: 0 })!, /应付/);
  assert.match(validateExpenseLink({ ...ctx, link: { kind: 'startup', startupId: 's', amountSen: 80_000 }, startupRemainingSen: 50_000 })!, /开档/);
  assert.match(validateExpenseLink({ expense: { ...legacyRent, ingredientBatchId: 'b' }, settledSen: 0, existing: [], link: { kind: 'later_capital', amountSen: 1 } })!, /进货|不能/);
  assert.match(validateExpenseLink({ ...ctx, link: { kind: 'later_capital', amountSen: 1 } })!, /资本/);
});

// ───────────── 3. 资本支出 ─────────────

const capital = exp({ id: 'cap', category: 'capital', description: '冰箱', amountSen: 100_000, paidSen: 100_000 });
const startupCovered = { ...base, startupRentByMonth: { '2026-10': 80_000 } };

test('复现 3：已付资本支出不计入已付经营支出（RM5,900 不应变成 RM4,900）；未分类时提示待确认', () => {
  const before = paybackStatus({ ...startupCovered, expenses: [fridge] });
  assert.equal(before.recoveredSen, 590_000);
  const r = paybackStatus({ ...startupCovered, expenses: [fridge, capital] });
  assert.equal(r.recoveredSen, 590_000);
  assert.equal(r.state, 'pending');
  assert.match(r.pendingReasons.join(), /资本/);
});

test('资本支出分类：关联开档项目（已在目标内）或后续资本投入，都不扣经营；未付资本也不算未付经营；现金总额不变', () => {
  const asStartup = [link('cap', { linkId: 'c', kind: 'startup', startupId: 'startup-seed-kitchenware', amountSen: 100_000, status: 'active' })];
  const r1 = paybackStatus({ ...startupCovered, expenses: [fridge, capital], links: asStartup });
  assert.deepEqual([r1.recoveredSen, r1.state, r1.laterCapitalSen], [590_000, 'achieved', 0]);
  const asLater = [link('cap', { linkId: 'c', kind: 'later_capital', amountSen: 100_000, status: 'active' })];
  const r2 = paybackStatus({ ...startupCovered, expenses: [fridge, capital], links: asLater });
  assert.deepEqual([r2.recoveredSen, r2.laterCapitalSen], [590_000, 100_000]);
  const unpaidCap = exp({ id: 'cap2', category: 'capital', amountSen: 50_000, paidSen: 0 });
  const r3 = paybackStatus({ ...startupCovered, expenses: [fridge, unpaidCap], links: [link('cap2', { linkId: 'x', kind: 'later_capital', amountSen: 50_000, status: 'active' })] });
  assert.equal(r3.unpaidOperatingSen, 0);
  const c = classifyExpenses([fridge, capital], asStartup);
  assert.equal(c.totalPaidSen, 110_000, '现金总支出保留真实付款');
  assert.equal(c.startupLinkedSen, 100_000);
});

test('经营费用若关联到开档项目（例如开档租金当时按旧版固定费用记过），也不再按经营支出扣', () => {
  const links = [link('legacy-rent', { linkId: 's', kind: 'startup', startupId: 'startup-seed-rent-deposit', amountSen: 80_000, status: 'active' })];
  const r = paybackStatus({ ...startupCovered, expenses: [legacyRent, fridge], links });
  assert.equal(r.paidOperatingSen, 10_000);
  assert.equal(r.state, 'achieved');
});

test('下一目标进度：自建立起新增的现金回本结余', () => {
  assert.equal(goalProgress({ baselineRecoveredSen: 510_000, targetSen: 100_000 }, 560_000).progressSen, 50_000);
  assert.equal(goalProgress({ baselineRecoveredSen: 510_000, targetSen: 100_000 }, 620_000).reached, true);
  assert.equal(goalProgress({ baselineRecoveredSen: 510_000, targetSen: 100_000 }, 500_000).progressSen, -10_000);
});

// ───────────── 复核 2：旧版 opex 归属后不再按营业费用扣 ─────────────

const legacyOpex = exp({ id: 'legacy-opex', category: 'opex', description: '房租（旧版记成营业费用）', amountSen: 80_000, paidSen: 80_000, businessDate: '2026-10-25', accrualDate: '2026-10-25' });
const rentLink = (amountSen: number, status: 'active' | 'cancelled' = 'active'): ExpenseLinkDoc =>
  ({ expenseId: 'legacy-opex', links: [{ linkId: 'l', kind: 'recurring', item: 'rent', month: '2026-10', amountSen, status }] });

test('复现：RM800 旧版 opex 归属十月租金后，杂费不再显示 RM800，经营利润不再同时扣 opex 和固定费用摊销', () => {
  const rows = (links: ExpenseLinkDoc[]) => Object.fromEntries(monthlyPlanRows(plan, '2026-10', [legacyOpex], {}, links).map((r) => [r.item, r]));
  const full = rows([rentLink(80_000)]);
  assert.deepEqual([full.rent.paidSen, full.misc.actualSen, full.misc.paidSen], [80_000, 0, 0]);
  const partial = rows([rentLink(50_000)]);
  assert.deepEqual([partial.rent.paidSen, partial.misc.actualSen, partial.misc.paidSen], [50_000, 30_000, 30_000], '部分关联：剩余 RM300 仍是杂费');
  const cancelled = rows([rentLink(80_000, 'cancelled')]);
  assert.deepEqual([cancelled.rent.paidSen, cancelled.misc.actualSen], [0, 80_000], '取消关联：恢复为杂费');

  const fig = (links: ExpenseLinkDoc[]) => rangeFigures(finance({ expenses: [legacyOpex as never], links, fixedPolicy: { mode: 'calendar_day', monthlySen: 90_000, schedule: { rentStartMonth: '2026-10', rentPhases: plan.rentPhases, extraMonthlySen: 10_000 } } }), DAY, policy, NOW);
  assert.equal(fig([rentLink(80_000)]).opexSen, 0);
  assert.equal(fig([rentLink(50_000)]).opexSen, 30_000);
  assert.equal(fig([rentLink(80_000, 'cancelled')]).opexSen, 80_000);
  assert.equal(fig([rentLink(80_000)]).paidOutSen, 80_000, '现金流水不变');
  // 关联到开档项目的 opex 同样不是营业费用。
  assert.equal(fig([{ expenseId: 'legacy-opex', links: [{ linkId: 's', kind: 'startup', startupId: 'x', amountSen: 80_000, status: 'active' }] }]).opexSen, 0);
});

test('日结口径（summarizePeriod / ledgerEvents）同样扣除已归属的部分，现金视角不变', () => {
  const docs = (expenseLinks: ExpenseLinkDoc[]) => ({ payments: [], refunds: [], costEvents: [], wastage: [], cashMovements: [], expenses: [{ ...legacyOpex, paymentSource: 'bank', occurredAtMs: 0, correctionOf: null }] as never, expenseLinks });
  const s = (links: ExpenseLinkDoc[]) => summarizePeriod(ledgerEvents(docs(links)), DAY, DEFAULT_FIXED_COST);
  assert.deepEqual([s([rentLink(80_000)]).otherOpexSen, s([rentLink(80_000)]).cash.opexPaidSen], [0, 80_000]);
  assert.equal(s([rentLink(50_000)]).otherOpexSen, 30_000);
  assert.equal(s([rentLink(80_000, 'cancelled')]).otherOpexSen, 80_000);
  assert.equal(s([]).otherOpexSen, 80_000, '没有归属资料时与原来一致');
});
