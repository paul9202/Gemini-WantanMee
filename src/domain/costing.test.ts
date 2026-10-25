/** 2026-10-25 收支改版：批次状态、金额口径、租金阶段、目标与重复记账防护（领域层部分）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BatchDoc, batchPeriod, ballsText, businessRangeMs, consumptionInRange, DAY_MS, DEFAULT_EXPENSE_PLAN, doughHalfUnits, ExpensePlan,
  fixedCostForDate, fixedMonthlyForMonth, monthlyFixedSen, monthlyPlanRows, msToZonedLocal, nextDailyTarget, paybackStatus, PlanExpense,
  rentForMonth, rentMonthIndex, scheduleFromPlan, STARTUP_SEED, StartupCostDoc, startupSummary, suggestedMonthlyBalls, unpaidExpenses,
  validateStartBatch, validateStartupDetails, zonedLocalToMs,
} from './index';

const TZ = 'Asia/Kuala_Lumpur';
const t = (local: string) => zonedLocalToMs(local, TZ)!;

const batch = (p: Partial<BatchDoc>): BatchDoc => ({
  id: 'b', ingredientId: 'ing-tomato-sauce', ingredientName: '番茄酱', category: 'seasoning', quantity: 5, unit: 'L', costSen: 4200, origin: 'purchase',
  purchaseExpenseId: 'e', purchasedDate: '2026-10-17', paid: true, status: 'finished', startedAtMs: t('2026-10-18T07:00'), endedAtMs: t('2026-10-25T07:00'),
  wastageQuantity: null, endNote: '', note: '', createdAtMs: 0, updatedAtMs: 0, ...p,
});

test('门店时区：本地时间与毫秒互转（UTC+8）', () => {
  assert.equal(t('2026-10-25T07:00'), Date.UTC(2026, 9, 24, 23, 0));
  assert.equal(msToZonedLocal(t('2026-10-25T07:00'), TZ), '2026-10-25T07:00');
  assert.equal(zonedLocalToMs('2026-02-30T07:00', TZ), null);
  const r = businessRangeMs({ start: '2026-10-25', endExclusive: '2026-10-26' }, { timeZone: TZ, cutoverMinutes: 240 });
  assert.equal(r.endMs - r.startMs, DAY_MS);
  assert.equal(msToZonedLocal(r.startMs, TZ), '2026-10-25T04:00');
});

test('批次周期：用完且成本已知才有平均每日成本；使用中 / 库存 / 成本待补都不给', () => {
  const done = batchPeriod(batch({}));
  assert.equal(done.state, 'complete');
  assert.equal(done.days, 7);
  assert.equal(done.avgDailySen, 600, 'RM42 ÷ 7 天 = RM6/天');
  assert.deepEqual(batchPeriod(batch({ status: 'in_use', endedAtMs: null })).avgDailySen, null);
  assert.equal(batchPeriod(batch({ status: 'in_use', endedAtMs: null }), t('2026-10-20T07:00')).days, 2);
  assert.equal(batchPeriod(batch({ status: 'stocked', startedAtMs: null, endedAtMs: null })).state, 'not_started');
  const pending = batchPeriod(batch({ costSen: null, origin: 'existing' }));
  assert.deepEqual([pending.state, pending.avgDailySen, pending.costPending], ['complete', null, true]);
});

test('区间消耗：按起止时间平均摊入，使用中与成本待补只计待核算；作废与库存批次不计', () => {
  const now = t('2026-10-26T12:00');
  const day = (d: string) => ({ startMs: t(`${d}T04:00`), endMs: t(`${d}T04:00`) + DAY_MS });
  const batches = [
    batch({ id: 'a' }),
    batch({ id: 'b', status: 'in_use', endedAtMs: null, startedAtMs: t('2026-10-25T07:00') }),
    batch({ id: 'c', status: 'voided' }),
    batch({ id: 'd', status: 'stocked', startedAtMs: null, endedAtMs: null }),
    batch({ id: 'e', costSen: null, origin: 'existing' }),
  ];
  const r = day('2026-10-20');
  const c = consumptionInRange(batches, r.startMs, r.endMs, now);
  assert.deepEqual(c, { costSen: 600, completeBatches: 1, pendingBatches: 1 }, '10/20 整天落在 a、e 内；e 成本待补');
  const c25 = consumptionInRange(batches, day('2026-10-25').startMs, day('2026-10-25').endMs, now);
  // a 在 10/25 04:00–07:00 只占 3 小时：4200 × 3/168 = 75
  assert.equal(c25.costSen, 75);
  assert.equal(c25.pendingBatches, 2);
});

test('换批校验：只能启用库存批；旧批须在用、同食材、结束晚于开始；可选择继续用（两批同时使用）', () => {
  const next = { status: 'stocked' as const, ingredientId: 'x' };
  const old = { status: 'in_use' as const, ingredientId: 'x', startedAtMs: 1000 };
  assert.equal(validateStartBatch(next, 5000, [{ batch: old, action: 'finished', endedAtMs: null }]), null);
  assert.equal(validateStartBatch(next, 5000, [{ batch: old, action: 'continue', endedAtMs: null }]), null);
  assert.match(validateStartBatch({ ...next, status: 'in_use' }, 5000, [])!, /库存/);
  assert.match(validateStartBatch(next, 5000, [{ batch: { ...old, ingredientId: 'y' }, action: 'finished', endedAtMs: null }])!, /同一种/);
  assert.match(validateStartBatch(next, 5000, [{ batch: { ...old, status: 'finished' }, action: 'finished', endedAtMs: null }])!, /不在使用/);
  assert.match(validateStartBatch(next, 500, [{ batch: old, action: 'finished', endedAtMs: null }])!, /晚于/);
});

test('租金阶段：前三个月 RM800，第 4 个月起 RM1,000；起租前 0；未设置为 null', () => {
  const plan: ExpensePlan = { ...DEFAULT_EXPENSE_PLAN, rentStartMonth: '2026-10' };
  assert.equal(rentForMonth(DEFAULT_EXPENSE_PLAN, '2026-10'), null);
  assert.equal(rentForMonth(plan, '2026-09'), 0);
  assert.deepEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-06'].map((m) => rentForMonth(plan, m)), [80_000, 80_000, 80_000, 100_000, 100_000]);
  assert.equal(rentMonthIndex(plan, '2027-01'), 4);
  assert.equal(fixedMonthlyForMonth(plan, '2026-10'), 90_000);
  assert.equal(fixedMonthlyForMonth(plan, '2027-01'), 110_000);
  // 日结摊销同一口径。
  const policy = { mode: 'calendar_day' as const, monthlySen: 90_000, schedule: scheduleFromPlan(plan) };
  assert.equal(monthlyFixedSen(policy, 2027, 1), 110_000);
  assert.equal(monthlyFixedSen(policy, 2026, 9), 0);
  assert.equal(fixedCostForDate(policy, '2027-01-01'), 3549, '110000 / 31 天，余数从月初 +1');
  assert.equal(monthlyFixedSen({ mode: 'calendar_day', monthlySen: 90_000 }, 2027, 1), 90_000, '未设置计划沿用旧额');
});

const exp = (p: Partial<PlanExpense>): PlanExpense => ({
  id: 'x', category: 'opex', description: '', amountSen: 0, paidSen: 0, businessDate: '2026-10-25', accrualDate: '2026-10-25', status: 'active', ...p,
});

test('日常开支：预算、应付、已付分开；开档已付的同月租金抵扣；工资未启用不计；作废不计', () => {
  const plan: ExpensePlan = { ...DEFAULT_EXPENSE_PLAN, rentStartMonth: '2026-10' };
  const expenses = [
    exp({ id: 'r', category: 'fixed_payment', planItem: 'rent', periodMonth: '2026-11', amountSen: 80_000, paidSen: 80_000 }),
    exp({ id: 'r-void', category: 'fixed_payment', planItem: 'rent', periodMonth: '2026-11', amountSen: 80_000, paidSen: 80_000, status: 'voided' }),
    exp({ id: 'g', planItem: 'gas', amountSen: 3_200, paidSen: 3_200, accrualDate: '2026-10-12' }),
    exp({ id: 'm', planItem: 'misc', amountSen: 2_000, paidSen: 0, accrualDate: '2026-10-20' }),
    exp({ id: 'm-pay', planItem: 'misc', amountSen: 0, paidSen: 2_000, settlesExpenseId: 'm' }),
    exp({ id: 'legacy', description: '旧版营业费用', amountSen: 500, paidSen: 500 }),
  ];
  const oct = Object.fromEntries(monthlyPlanRows(plan, '2026-10', expenses, { '2026-10': 80_000 }).map((r) => [r.item, r]));
  assert.equal(oct.rent.state, 'covered');
  assert.deepEqual([oct.rent.budgetSen, oct.rent.dueSen, oct.rent.outstandingSen], [80_000, 0, 0]);
  assert.deepEqual([oct.fridge_power.dueSen, oct.fridge_power.outstandingSen, oct.fridge_power.state], [10_000, 10_000, 'due']);
  assert.equal(oct.gas.actualSen, 3_200);
  assert.deepEqual([oct.misc.actualSen, oct.misc.paidSen, oct.misc.outstandingSen], [2_500, 2_500, 0], '补付款后付清；旧版营业费用归入杂费');
  assert.equal(oct.wage.state, 'disabled');
  const nov = Object.fromEntries(monthlyPlanRows(plan, '2026-11', expenses, { '2026-10': 80_000 }).map((r) => [r.item, r]));
  assert.deepEqual([nov.rent.state, nov.rent.paidSen], ['paid', 80_000], '作废的重复付款不计');
  assert.deepEqual(unpaidExpenses(expenses).map((x) => x.expense.id), []);
});

test('开档成本：初始清单合计 RM5,090.92；厨具杂货 7 笔合计；欠账已含总投入，清还不增加投入', () => {
  const items: StartupCostDoc[] = STARTUP_SEED.map((s, i) => ({ ...s, id: `s${i}`, createdAtMs: 0, status: 'active', correctionOf: null, paidDate: null }));
  const sum = startupSummary(items);
  assert.equal(sum.totalSen, 509_092);
  assert.equal(sum.count, 6);
  assert.equal(sum.paidSen, 0, '除欠账外付款待核实，不假设已付');
  assert.equal(sum.unpaidSen, 33_652);
  assert.equal(sum.unverifiedSen, 509_092 - 33_652);
  assert.equal(validateStartupDetails(304_440, items.find((i) => i.group === 'kitchenware')!.details), null);
  assert.match(validateStartupDetails(100, [{ amountSen: 99 }])!, /不一致/);
  const paid = startupSummary(items.map((i) => (i.isDebt ? { ...i, paymentStatus: 'paid' as const } : i)));
  assert.equal(paid.totalSen, 509_092, '欠账清还后总投入不变');
  assert.equal(paid.unpaidSen, 0);
  // 拆分租金押金并关联月份：只有已付的开档租金抵扣月租。
  const split = items.map((i) => (i.group === 'rent_deposit' ? { ...i, rentSen: 80_000, depositSen: 30_000, rentMonth: '2026-10' } : i));
  assert.deepEqual(startupSummary(split).rentByMonth, {});
  const splitPaid = startupSummary(split.map((i) => (i.group === 'rent_deposit' ? { ...i, paymentStatus: 'paid' as const } : i)));
  assert.deepEqual([splitPaid.rentByMonth, splitPaid.depositSen, splitPaid.unsplitRentDepositSen], [{ '2026-10': 80_000 }, 30_000, 0]);
  // 更正后的原记录作废不计。
  assert.equal(startupSummary([...items, { ...items[1], id: 'v', status: 'voided' }]).totalSen, 509_092);
});

test('回本：只用真实账目；进货付款不与消耗重复；开档投入不算支出；到期未付的固定费用要扣；资料不足为待核算', () => {
  const plan: ExpensePlan = { ...DEFAULT_EXPENSE_PLAN, rentStartMonth: '2026-10' };
  const base = { startupTotalSen: 509_092, receiptsSen: 300_000, refundsSen: 10_000, plan, startupRentByMonth: { '2026-10': 80_000 }, currentMonth: '2026-10' };
  const expenses = [
    exp({ id: 'p', category: 'purchase', amountSen: 9_600, paidSen: 9_600, ingredientBatchId: 'b1' }),
    exp({ id: 'p2', category: 'purchase', amountSen: 5_000, paidSen: 0, ingredientBatchId: 'b2' }),
    exp({ id: 'g', planItem: 'gas', amountSen: 3_200, paidSen: 3_200 }),
  ];
  const r = paybackStatus({ ...base, expenses });
  assert.equal(r.receiptsNetSen, 290_000);
  assert.equal(r.paidOperatingSen, 12_800);
  // 未付进货 5,000 + 10 月冰箱电费 10,000（租金已由开档覆盖）
  assert.equal(r.unpaidOperatingSen, 15_000);
  assert.equal(r.recoveredSen, 262_200);
  assert.equal(r.state, 'in_progress');
  assert.equal(r.remainingSen, 509_092 - 262_200);
  const none = paybackStatus({ ...base, plan: DEFAULT_EXPENSE_PLAN, expenses });
  assert.equal(none.state, 'pending');
  assert.match(none.pendingReasons.join(), /起租/);
  assert.equal(paybackStatus({ ...base, startupTotalSen: 0, expenses }).state, 'pending');
  assert.equal(paybackStatus({ ...base, receiptsSen: 800_000, expenses }).state, 'achieved');
});

test('销量按面团粒数：小 1、中 1½、大 2，云吞汤不计，取消单不计', () => {
  const orders = [
    { businessDate: '2026-10-25', fulfillmentStatus: 'served', items: [{ noodleHalfUnits: 2, quantity: 2 }, { noodleHalfUnits: 3, quantity: 1 }, { noodleHalfUnits: 0, quantity: 3 }] },
    { businessDate: '2026-10-25', fulfillmentStatus: 'cancelled', items: [{ noodleHalfUnits: 4, quantity: 1 }] },
    { businessDate: '2026-10-25', fulfillmentStatus: 'queued', items: [{ noodleHalfUnits: 4, quantity: 1 }] },
  ];
  assert.equal(doughHalfUnits(orders), 11);
  assert.equal(ballsText(11), '5½');
  assert.equal(ballsText(100), '50');
  assert.equal(suggestedMonthlyBalls(50, '2026-11'), 1500);
  assert.deepEqual([nextDailyTarget(50), nextDailyTarget(100)], [100, 150]);
});
