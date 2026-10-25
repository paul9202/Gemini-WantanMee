/**
 * 2026-10-25 收支改版 Emulator 测试：开档清单幂等导入、按月固定费用防重复、开档租金覆盖、
 * 食材批次（首次录入不记支出、进货只记一次、换批、两批同时使用、作废）、补付款、工资启用、回本后才能拟定新目标、越权。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, cleanupClients, countDocs, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { businessDateOf, monthOf, STARTUP_SEED } from '../../src/domain';
import { linkExpense } from '../src/commands/costing';

after(cleanupClients);

const doc = (f: StoreFixture, p: string) => admin().doc(`stores/${f.storeId}/${p}`).get().then((s) => s.data());
const cmd = (f: StoreFixture, extra: Record<string, unknown>) => ({ storeId: f.storeId, operationId: uuid(), ...extra });
const thisMonth = () => monthOf(businessDateOf(Date.now()));

test('开档初始清单：幂等导入，合计 RM5,090.92；重复导入、同 operationId 重放都不重复写；更正保留原记录；欠账清还不改总额', async () => {
  const f = await setupStore();
  const op = uuid();
  const r1 = await f.owner.call<{ created: number }>('seedStartupCosts', { storeId: f.storeId, operationId: op });
  assert.equal(r1.created, 6);
  const replay = await f.owner.call<{ created: number; replayed: boolean }>('seedStartupCosts', { storeId: f.storeId, operationId: op });
  assert.deepEqual([replay.created, replay.replayed], [6, true]);
  const r2 = await f.owner.call<{ created: number }>('seedStartupCosts', cmd(f, {}));
  assert.equal(r2.created, 0);
  const all = (await admin().collection(`stores/${f.storeId}/startupCosts`).get()).docs.map((d) => d.data());
  assert.equal(all.length, 6);
  assert.equal(all.reduce((s, d) => s + d.amountSen, 0), STARTUP_SEED.reduce((s, x) => s + x.amountSen, 0));
  assert.equal(all.reduce((s, d) => s + d.amountSen, 0), 509_092);
  assert.deepEqual(all.filter((d) => d.paymentStatus === 'paid').length, 0, '除欠账外付款待核实，不假设已付');

  // 更正：原记录作废并保留，新记录关联原记录；之后再导入也不会把原记录恢复。
  const vaccine = all.find((d) => d.seedKey === 'vaccine')!;
  const corr = await f.owner.call<{ id: string }>('correctStartupCost', cmd(f, { id: vaccine.id, reason: '实际是 RM120', group: 'vaccine', title: '疫苗', amountSen: 12_000, details: [], note: '' }));
  assert.equal((await doc(f, `startupCosts/${vaccine.id}`))!.status, 'voided');
  assert.equal((await doc(f, `startupCosts/${corr.id}`))!.correctionOf, vaccine.id);
  await f.owner.call('seedStartupCosts', cmd(f, {}));
  assert.equal((await doc(f, `startupCosts/${vaccine.id}`))!.status, 'voided', '导入不覆盖已有真实记录');
  assert.equal(await f.owner.code('correctStartupCost', cmd(f, { id: vaccine.id, reason: '再改', group: 'vaccine', title: '疫苗', amountSen: 1, details: [], note: '' })), 'INVALID_TRANSITION');
  // 明细合计必须等于金额。
  assert.equal(await f.owner.code('addStartupCost', cmd(f, { group: 'other', title: 'x', amountSen: 1000, details: [{ label: 'a', amountSen: 999 }], note: '', paymentStatus: 'paid', paidDate: null })), 'INVALID_ARGUMENT');

  // 欠账清还：只改状态。
  const debt = all.find((d) => d.isDebt)!;
  assert.equal(await f.owner.code('setStartupPayment', cmd(f, { id: debt.id, paymentStatus: 'paid', paidDate: null })), 'INVALID_ARGUMENT', '已付需要日期');
  await f.owner.call('setStartupPayment', cmd(f, { id: debt.id, paymentStatus: 'paid', paidDate: businessDateOf(Date.now()) }));
  const after = (await admin().collection(`stores/${f.storeId}/startupCosts`).where('status', '==', 'active').get()).docs.map((d) => d.data());
  assert.equal(after.reduce((s, d) => s + d.amountSen, 0), 509_092 + 2_000, '只多了更正的 RM20');
  assert.equal(await countDocs(f.storeId, 'expenses'), 0, '开档成本不进日常支出账');
  assert.equal(await f.cashier.code('seedStartupCosts', cmd(f, {})), 'FORBIDDEN');
});

test('固定费用：每月只能登记一笔；作废后可重记；开档已付的同月租金不再收；起租计划同步到日结摊销', async () => {
  const f = await setupStore();
  const m = thisMonth();
  assert.equal(await f.owner.code('recordRecurringPayment', cmd(f, { item: 'rent', month: m, amountSen: 80_000, paymentSource: 'bank' })), 'INVALID_TRANSITION', '未设起租月');
  await f.owner.call('setExpensePlan', cmd(f, { rentStartMonth: m, staffEnabled: false }));
  const fin = await doc(f, 'config/finance');
  assert.equal(fin!.fixedCostPolicy.schedule.rentStartMonth, m);
  const fridge = await f.owner.call<{ id: string }>('recordRecurringPayment', cmd(f, { item: 'fridge_power', month: m, amountSen: 10_000, paymentSource: 'bank' }));
  assert.equal(await f.owner.code('recordRecurringPayment', cmd(f, { item: 'fridge_power', month: m, amountSen: 10_000, paymentSource: 'drawer' })), 'PERIOD_ALREADY_PAID');
  await f.owner.call('voidLedgerEntry', cmd(f, { kind: 'expense', id: fridge.id, reason: '来源记错' }));
  await f.owner.call('recordRecurringPayment', cmd(f, { item: 'fridge_power', month: m, amountSen: 10_000, paymentSource: 'drawer' }));
  assert.equal(await countDocs(f.storeId, 'expenses', 'status', 'active'), 1);

  // 开档租金拆分并关联本月、已付 → 本月月租不再收。
  await f.owner.call('seedStartupCosts', cmd(f, {}));
  const rentId = 'startup-seed-rent-deposit';
  assert.equal(await f.owner.code('splitStartupRent', cmd(f, { id: rentId, rentSen: 80_000, depositSen: 20_000, rentMonth: m })), 'INVALID_ARGUMENT', '合计不等');
  await f.owner.call('splitStartupRent', cmd(f, { id: rentId, rentSen: 80_000, depositSen: 30_000, rentMonth: m }));
  await f.owner.call('setStartupPayment', cmd(f, { id: rentId, paymentStatus: 'paid', paidDate: businessDateOf(Date.now()) }));
  assert.equal(await f.owner.code('recordRecurringPayment', cmd(f, { item: 'rent', month: m, amountSen: 80_000, paymentSource: 'bank' })), 'COVERED_BY_STARTUP');
});

test('食材批次：首次录入不记支出；进货只记一次；启用库存不再记支出；换批需确认旧批；两批同时使用；作废连同进货支出', async () => {
  const f = await setupStore();
  const now = Date.now();
  const existing = await f.owner.call<{ id: string; status: string }>('recordExistingBatch', cmd(f, { ingredientId: 'ing-tomato-sauce', quantity: 5, unit: '瓶', costSen: null, startedAtMs: now - 7 * 86_400_000, note: '' }));
  assert.equal(existing.status, 'in_use');
  assert.equal(await countDocs(f.storeId, 'expenses'), 0, '首次录入不生成采购支出');
  assert.equal(await f.owner.code('recordExistingBatch', cmd(f, { ingredientId: 'ing-nope', quantity: 1, unit: 'kg', costSen: 100, startedAtMs: null, note: '' })), 'NOT_FOUND');
  assert.equal(await f.owner.code('recordExistingBatch', cmd(f, { ingredientId: 'ing-salt', quantity: 1, unit: 'kg', costSen: 100, startedAtMs: now + 86_400_000, note: '' })), 'INVALID_ARGUMENT', '不能是未来时间');
  assert.equal(await f.owner.code('recordExistingBatch', cmd(f, { ingredientId: 'ing-salt', quantity: 1.23456, unit: 'kg', costSen: 100, startedAtMs: null, note: '' })), 'INVALID_ARGUMENT');

  const pOp = uuid();
  const purchase = { storeId: f.storeId, operationId: pOp, ingredientId: 'ing-tomato-sauce', quantity: 5, unit: '瓶', amountSen: 4_200, purchasedDate: null, paid: false, paymentSource: 'drawer', note: '' };
  const p = await f.owner.call<{ id: string; expenseId: string }>('recordIngredientPurchase', purchase);
  await f.owner.call('recordIngredientPurchase', purchase); // 重放
  assert.equal(await countDocs(f.storeId, 'expenses'), 1, '同一次进货只记一笔支出');
  assert.equal((await doc(f, `ingredientBatches/${p.id}`))!.status, 'stocked', '进货不自动启用、不结束旧批');
  assert.equal((await doc(f, `ingredientBatches/${existing.id}`))!.status, 'in_use');

  // 换批必须明确处理在用的旧批。
  assert.equal(await f.owner.code('startBatch', cmd(f, { batchId: p.id, startedAtMs: now, previous: [] })), 'BATCH_STATE');
  // 选择「继续用」→ 两批同时使用。
  await f.owner.call('startBatch', cmd(f, { batchId: p.id, startedAtMs: now - 60_000, previous: [{ batchId: existing.id, action: 'continue', endedAtMs: null }] }));
  assert.equal((await doc(f, `ingredientBatches/${existing.id}`))!.status, 'in_use');
  assert.equal((await doc(f, `ingredientBatches/${p.id}`))!.status, 'in_use');
  assert.equal(await countDocs(f.storeId, 'expenses'), 1, '启用已登记采购的库存，不重复记支出');
  assert.equal(await f.owner.code('startBatch', cmd(f, { batchId: p.id, startedAtMs: now, previous: [] })), 'BATCH_STATE', '已在用的批次不能再启用');

  // 旧批用完：结束时间必须晚于开始。
  assert.equal(await f.owner.code('finishBatch', cmd(f, { batchId: existing.id, endedAtMs: now - 30 * 86_400_000, wastageQuantity: null, endNote: '' })), 'BATCH_STATE');
  await f.owner.call('finishBatch', cmd(f, { batchId: existing.id, endedAtMs: now, wastageQuantity: 0.5, endNote: '底部结块' }));
  const done = (await doc(f, `ingredientBatches/${existing.id}`))!;
  assert.deepEqual([done.status, done.wastageQuantity], ['finished', 0.5]);
  await f.owner.call('setBatchCost', cmd(f, { batchId: existing.id, costSen: 4_200, reason: '' }));
  assert.equal(await f.owner.code('setBatchCost', cmd(f, { batchId: existing.id, costSen: 4_000, reason: '' })), 'REASON_REQUIRED', '更正已有成本要写原因');
  assert.equal(await f.owner.code('setBatchCost', cmd(f, { batchId: p.id, costSen: 1, reason: '改价' })), 'LINKED_TO_BATCH', '进货批次成本来自支出');

  // 进货支出不能单独作废；补付款只能一次。
  assert.equal(await f.owner.code('voidLedgerEntry', cmd(f, { kind: 'expense', id: p.expenseId, reason: '录错' })), 'LINKED_TO_BATCH');
  const settle = await f.owner.call<{ paidSen: number }>('settleExpense', cmd(f, { expenseId: p.expenseId, paymentSource: 'bank' }));
  assert.equal(settle.paidSen, 4_200);
  assert.equal(await f.owner.code('settleExpense', cmd(f, { expenseId: p.expenseId, paymentSource: 'bank' })), 'ALREADY_SETTLED');
  assert.equal(await f.owner.code('voidBatch', cmd(f, { batchId: p.id, reason: '录错' })), 'ALREADY_SETTLED', '已补付款的进货要先作废补付款');

  // 作废另一批进货：支出一并作废，不硬删除。
  const p2 = await f.owner.call<{ id: string; expenseId: string }>('recordIngredientPurchase', cmd(f, { ingredientId: 'ing-salt', quantity: 2, unit: '包', amountSen: 300, purchasedDate: null, paid: true, paymentSource: 'drawer', note: '' }));
  await f.owner.call('voidBatch', cmd(f, { batchId: p2.id, reason: '重复录入' }));
  assert.equal((await doc(f, `expenses/${p2.expenseId}`))!.status, 'voided');
  assert.equal((await doc(f, `ingredientBatches/${p2.id}`))!.status, 'voided');
  assert.equal(await f.cashier.code('recordIngredientPurchase', cmd(f, { ingredientId: 'ing-salt', quantity: 1, unit: '包', amountSen: 1, purchasedDate: null, paid: true, paymentSource: 'drawer', note: '' })), 'FORBIDDEN');
});

test('日常开支与目标：工资须启用；煤气按实际；面量目标保留历史；未回本不能拟定下一目标；自定义食材不重名', async () => {
  const f = await setupStore();
  assert.equal(await f.owner.code('recordPlanExpense', cmd(f, { item: 'wage', amountSen: 6_000, paid: true, paymentSource: 'drawer', workDays: 1 })), 'STAFF_NOT_ENABLED');
  await f.owner.call('setExpensePlan', cmd(f, { rentStartMonth: null, staffEnabled: true }));
  await f.owner.call('recordPlanExpense', cmd(f, { item: 'wage', amountSen: 6_000, paid: true, paymentSource: 'drawer', workDays: 1 }));
  await f.owner.call('recordPlanExpense', cmd(f, { item: 'gas', amountSen: 3_200, paid: true, paymentSource: 'drawer' }));
  const ex = (await admin().collection(`stores/${f.storeId}/expenses`).get()).docs.map((d) => d.data());
  assert.deepEqual(ex.map((e) => [e.planItem, e.category]).sort(), [['gas', 'opex'], ['wage', 'opex']]);

  await f.owner.call('setSalesTarget', cmd(f, { scope: 'daily', balls: 100 }));
  await f.owner.call('setSalesTarget', cmd(f, { scope: 'monthly', month: thisMonth(), balls: 2_000 }));
  const goals = (await doc(f, 'config/goals'))!.sales;
  assert.deepEqual([goals.dailyBalls, goals.dailyHistory[0].balls, goals.monthly[thisMonth()]], [100, 50, 2_000]);
  assert.equal(await f.owner.code('createNextGoal', cmd(f, { title: '备用金', targetSen: 100_000 })), 'GOAL_NOT_REACHED');

  await f.owner.call('addIngredient', cmd(f, { category: 'other', name: '打包袋', unit: '包' }));
  assert.equal(await f.owner.code('addIngredient', cmd(f, { category: 'other', name: '打包袋', unit: '包' })), 'INVALID_ARGUMENT');
  assert.equal(await f.owner.code('addIngredient', cmd(f, { category: 'seasoning', name: '蚝油', unit: '瓶' })), 'INVALID_ARGUMENT', '与预置同名');
});

// ───────────── 复核问题：旧账归属、资本分类、目标生命周期 ─────────────

const today = () => businessDateOf(Date.now());
const nextMonthOf = (m: string) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

test('旧版房租：已关账营业日的付款可确认归属到月份（原支出与日结快照不变、不新增现金流）；重复 / 超额 / 并发都只成功一次；取消后可重新关联', async () => {
  const f = await setupStore();
  const m = thisMonth();
  await f.owner.call('setExpensePlan', cmd(f, { rentStartMonth: m, staffEnabled: false }));
  const legacy = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'fixed_payment', description: '本月房租', amountSen: 80_000, paid: true, paymentSource: 'bank' }));
  const legacy2 = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'fixed_payment', description: '房租（另一笔）', amountSen: 80_000, paid: true, paymentSource: 'bank' }));
  await f.owner.call('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: today(), acknowledgeExceptions: true, exceptionReason: '测试关账' });
  const reportBefore = JSON.stringify(await doc(f, `dailyReports/${today()}`));
  const expBefore = JSON.stringify(await doc(f, `expenses/${legacy.id}`));
  assert.equal(await f.owner.code('voidLedgerEntry', cmd(f, { kind: 'expense', id: legacy.id, reason: '想重记' })), 'DAY_CLOSED', '已关账不能作废重记');

  // 并发：两笔旧付款同时归入同月租金（应付 RM800），只能成功一笔。
  // 在测试进程里直接并发执行同一段事务代码：Functions Emulator 通常把同一函数的调用排队执行，测不到真正的事务竞争；
  // 内存紧张时它又可能并行起工作进程并崩溃，返回没有 reasonCode 的 internal / deadline-exceeded。那是基础设施错误，不是业务结果。
  const codes = await Promise.all([legacy, legacy2].map((e) => linkExpense(admin(), f.owner.uid, cmd(f, { expenseId: e.id, kind: 'recurring', item: 'rent', month: m, amountSen: 80_000 }))
    .then(() => 'OK', (err) => err?.reasonCode ?? `非业务错误（${err?.code ?? ''} ${String(err?.message ?? err).slice(0, 80)}）`)));
  assert.deepEqual([...codes].sort(), ['OK', 'PERIOD_ALREADY_PAID'], `并发结果 ${codes}`);
  const winner = codes[0] === 'OK' ? legacy : legacy2;
  const slot = await doc(f, `recurringSlots/rent-${m}`);
  const slotActive = ((slot?.links ?? []) as { status: string; amountSen: number; expenseId: string }[]).filter((l) => l.status === 'active');
  assert.deepEqual(slotActive.map((l) => [l.expenseId, l.amountSen]), [[winner.id, 80_000]], '月份槽只有胜出那笔，金额不超过应付');
  const activeLinks = (await admin().collection(`stores/${f.storeId}/expenseLinks`).get()).docs.flatMap((d) => d.data().links).filter((l: { status: string }) => l.status === 'active');
  assert.equal(activeLinks.length, 1, '只有一条有效归属');
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: winner.id, kind: 'recurring', item: 'rent', month: m, amountSen: 1 })), 'LINK_REJECTED', '同一付款重复关联同月');
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: winner.id, kind: 'recurring', item: 'fridge_power', month: m, amountSen: 10_000 })), 'LINK_REJECTED', '已全额关联，没有剩余');

  assert.equal(JSON.stringify(await doc(f, `dailyReports/${today()}`)), reportBefore, '日结快照不变');
  if (winner === legacy) assert.equal(JSON.stringify(await doc(f, `expenses/${legacy.id}`)), expBefore, '原支出不变');
  assert.equal(await countDocs(f.storeId, 'expenses'), 2, '没有新增支出 / 现金流');
  assert.equal(await f.owner.code('recordRecurringPayment', cmd(f, { item: 'rent', month: m, amountSen: 80_000, paymentSource: 'bank', businessDate: null })), 'PERIOD_ALREADY_PAID');

  // 取消关联（保留记录）→ 另一笔可以归入该月。
  const linkDoc = await doc(f, `expenseLinks/${winner.id}`);
  await f.owner.call('unlinkExpense', cmd(f, { expenseId: winner.id, linkId: linkDoc!.links[0].linkId, reason: '其实是上个月的' }));
  assert.equal((await doc(f, `expenseLinks/${winner.id}`))!.links[0].status, 'cancelled');
  const other = winner === legacy ? legacy2 : legacy;
  await f.owner.call('linkExpense', cmd(f, { expenseId: other.id, kind: 'recurring', item: 'rent', month: m, amountSen: 50_000 }));
  // 部分抵扣：剩 RM300，超额拒绝。
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: winner.id, kind: 'recurring', item: 'rent', month: m, amountSen: 40_000 })), 'PERIOD_ALREADY_PAID');
  await f.owner.call('linkExpense', cmd(f, { expenseId: winner.id, kind: 'recurring', item: 'rent', month: m, amountSen: 30_000 }));
  assert.equal(await f.cashier.code('linkExpense', cmd(f, { expenseId: winner.id, kind: 'later_capital', amountSen: 1 })), 'FORBIDDEN');
});

test('资本支出：可关联开档项目或标为后续投入；同一投入不能超额关联到开档清单；未分类时不能拟定下一目标', async () => {
  const f = await setupStore();
  await f.owner.call('seedStartupCosts', cmd(f, {}));
  const cap = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'capital', description: '炉具', amountSen: 300_000, paid: true, paymentSource: 'owner' }));
  const cap2 = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'capital', description: '厨具第 2 笔（重复记过）', amountSen: 209_400, paid: true, paymentSource: 'owner' }));
  assert.equal(await f.owner.code('createNextGoal', cmd(f, { title: 'x', targetSen: 1 })), 'GOAL_NOT_REACHED');
  await f.owner.call('linkExpense', cmd(f, { expenseId: cap.id, kind: 'startup', startupId: 'startup-seed-kitchenware', amountSen: 200_000 }));
  // 厨具杂货 RM3,044.40 只剩 RM1,044.40 可关联 → cap2 的 RM2,094 超额。
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: cap2.id, kind: 'startup', startupId: 'startup-seed-kitchenware', amountSen: 209_400 })), 'LINK_REJECTED');
  // 同一笔不能超过自身金额：cap 剩 RM1,000。
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: cap.id, kind: 'later_capital', amountSen: 100_001 })), 'LINK_REJECTED');
  await f.owner.call('linkExpense', cmd(f, { expenseId: cap.id, kind: 'later_capital', amountSen: 100_000 }));
  // 非资本支出不能标为资本投入。
  const gas = await f.owner.call<{ id: string }>('recordPlanExpense', cmd(f, { item: 'gas', amountSen: 3_000, paid: true, paymentSource: 'drawer' }));
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: gas.id, kind: 'later_capital', amountSen: 3_000 })), 'LINK_REJECTED');
  const kit = await doc(f, 'startupCosts/startup-seed-kitchenware');
  assert.equal(kit!.amountSen, 304_440, '关联不改开档金额');
  assert.equal(kit!.linkedExpenses.length, 1);
  assert.equal(await f.owner.code('voidLedgerEntry', cmd(f, { kind: 'expense', id: cap.id, reason: '录错' })), 'LINK_REJECTED', '已归属的支出要先取消归属');
});

test('目标生命周期：回本后拟定下一目标（记录基线）→ 未达标不能完成 → 达标完成 → 再拟定 → 放弃', async () => {
  const f = await setupStore();
  // 起租月设在下个月：本月没有到期的固定费用；开档投入只有 RM1，便于用两单达成。
  await f.owner.call('setExpensePlan', cmd(f, { rentStartMonth: nextMonthOf(thisMonth()), staffEnabled: false }));
  await f.owner.call('addStartupCost', cmd(f, { group: 'other', title: '测试', amountSen: 100, details: [], note: '', paymentStatus: 'paid', paidDate: today() }));
  await placeOrder(f, { tokenNumber: 1, paid: true });
  const g = await f.owner.call<{ id: string }>('createNextGoal', cmd(f, { title: '备用金', targetSen: 500 }));
  assert.equal((await doc(f, `goals/${g.id}`))!.baselineRecoveredSen, 700);
  assert.equal(await f.owner.code('createNextGoal', cmd(f, { title: '另一个', targetSen: 1 })), 'INVALID_TRANSITION', '同时只有一个进行中');
  assert.equal(await f.owner.code('completeGoal', cmd(f, { goalId: g.id })), 'GOAL_NOT_REACHED');
  await placeOrder(f, { tokenNumber: 2, paid: true });
  const done = await f.owner.call<{ progressSen: number }>('completeGoal', cmd(f, { goalId: g.id }));
  assert.equal(done.progressSen, 700);
  assert.equal((await doc(f, `goals/${g.id}`))!.status, 'achieved');
  const g2 = await f.owner.call<{ id: string }>('createNextGoal', cmd(f, { title: '新设备', targetSen: 100_000 }));
  assert.equal((await doc(f, `goals/${g2.id}`))!.baselineRecoveredSen, 1_400);
  await f.owner.call('archiveGoal', cmd(f, { goalId: g2.id, reason: '改为先存备用金' }));
  assert.equal((await doc(f, `goals/${g2.id}`))!.status, 'archived');
  assert.equal(await f.owner.code('completeGoal', cmd(f, { goalId: g2.id })), 'INVALID_TRANSITION');
});

test('成本核算范围：只能选存在的食材；记录确认时间与历史', async () => {
  const f = await setupStore();
  assert.equal(await f.owner.code('setCostCoverage', cmd(f, { ingredientIds: ['ing-nope'] })), 'NOT_FOUND');
  await f.owner.call('setCostCoverage', cmd(f, { ingredientIds: ['ing-thin-noodle', 'ing-minced-pork'] }));
  await f.owner.call('setCostCoverage', cmd(f, { ingredientIds: ['ing-thin-noodle'] }));
  const c = await doc(f, 'config/costCoverage');
  assert.deepEqual(c!.coverage.requiredIngredientIds, ['ing-thin-noodle']);
  assert.ok(c!.coverage.confirmedAtMs > 0);
  assert.equal(c!.history.length, 2);
});

// ───────────── 复核 2：旧版 opex 归属后的日结口径；更正开档项目时迁移关联 ─────────────

test('旧版营业费用归属到月租 / 电费 / 开档项目：日结只扣剩余部分（全部、部分、取消）；现金付款不变', async () => {
  const f = await setupStore();
  await f.owner.call('setExpensePlan', cmd(f, { rentStartMonth: thisMonth(), staffEnabled: false }));
  await f.owner.call('seedStartupCosts', cmd(f, {}));
  const opex = (description: string, amountSen: number) => f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'opex', description, amountSen, paid: true, paymentSource: 'bank' }));
  const a = await opex('房租（旧版记成营业费用）', 80_000);
  const b = await opex('电费 + 杂项', 50_000);
  const c = await opex('招牌订金（记错类别）', 10_000);
  await f.owner.call('linkExpense', cmd(f, { expenseId: a.id, kind: 'recurring', item: 'rent', month: thisMonth(), amountSen: 80_000 }));
  await f.owner.call('linkExpense', cmd(f, { expenseId: b.id, kind: 'recurring', item: 'fridge_power', month: thisMonth(), amountSen: 10_000 }));
  const cl = await f.owner.call<{ linkId: string }>('linkExpense', cmd(f, { expenseId: c.id, kind: 'startup', startupId: 'startup-seed-signboard', amountSen: 10_000 }));
  await f.owner.call('unlinkExpense', cmd(f, { expenseId: c.id, linkId: cl.linkId, reason: '其实是杂费' }));
  const closed = await f.owner.call<{ figures: any }>('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: today(), acknowledgeExceptions: true, exceptionReason: '测试关账' });
  // a 全部归属 → 0；b 部分归属 → 40,000；c 取消归属 → 10,000。
  assert.equal(closed.figures.summary.otherOpexSen, 50_000);
  assert.equal(closed.figures.summary.cash.opexPaidSen, 140_000, '现金视角仍按实际付款');
  // 已关账后再归属：快照不变。
  const before = JSON.stringify(await doc(f, `dailyReports/${today()}`));
  await f.owner.call('linkExpense', cmd(f, { expenseId: c.id, kind: 'startup', startupId: 'startup-seed-signboard', amountSen: 10_000 }));
  assert.equal(JSON.stringify(await doc(f, `dailyReports/${today()}`)), before);
});

test('更正开档项目：已有付款关联在同一事务迁移；金额不能低于已关联；额度不重置；取消关联指向新项目；与关联并发不留悬空记录', async () => {
  const f = await setupStore();
  await f.owner.call('seedStartupCosts', cmd(f, {}));
  const cap = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'capital', description: '炉具', amountSen: 200_000, paid: true, paymentSource: 'owner' }));
  const cap2 = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'capital', description: '锅具', amountSen: 100_000, paid: true, paymentSource: 'owner' }));
  const l1 = await f.owner.call<{ linkId: string }>('linkExpense', cmd(f, { expenseId: cap.id, kind: 'startup', startupId: 'startup-seed-kitchenware', amountSen: 200_000 }));
  const fields = { group: 'kitchenware', title: '厨具和杂货', details: [], note: '' };
  assert.equal(await f.owner.code('correctStartupCost', cmd(f, { id: 'startup-seed-kitchenware', reason: '金额减少', amountSen: 150_000, ...fields })), 'LINK_REJECTED', '低于已关联 RM2,000');
  const corr = await f.owner.call<{ id: string; migratedLinks: number }>('correctStartupCost', cmd(f, { id: 'startup-seed-kitchenware', reason: '实际少了一笔', amountSen: 250_000, ...fields }));
  assert.equal(corr.migratedLinks, 1);
  const oldItem = (await doc(f, 'startupCosts/startup-seed-kitchenware'))!;
  const newItem = (await doc(f, `startupCosts/${corr.id}`))!;
  assert.deepEqual([oldItem.status, oldItem.linkedExpenses[0].status, oldItem.linkedExpenses[0].migratedTo], ['voided', 'migrated', corr.id]);
  assert.deepEqual(newItem.linkedExpenses.map((l: any) => [l.linkId, l.status, l.amountSen]), [[l1.linkId, 'active', 200_000]]);
  const linkDoc = (await doc(f, `expenseLinks/${cap.id}`))!;
  assert.deepEqual([linkDoc.links[0].startupId, linkDoc.links[0].startupIdHistory], [corr.id, ['startup-seed-kitchenware']]);
  // 额度没有重置：新项目 RM2,500 已用 RM2,000，只剩 RM500。
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: cap2.id, kind: 'startup', startupId: corr.id, amountSen: 60_000 })), 'LINK_REJECTED');
  assert.equal(await f.owner.code('linkExpense', cmd(f, { expenseId: cap2.id, kind: 'startup', startupId: 'startup-seed-kitchenware', amountSen: 1 })), 'NOT_FOUND', '不能再关联到已作废的旧项目');
  await f.owner.call('linkExpense', cmd(f, { expenseId: cap2.id, kind: 'startup', startupId: corr.id, amountSen: 50_000 }));
  // 取消关联更新的是新项目。
  await f.owner.call('unlinkExpense', cmd(f, { expenseId: cap.id, linkId: l1.linkId, reason: '其实是后续投入' }));
  assert.equal((await doc(f, `startupCosts/${corr.id}`))!.linkedExpenses.find((l: any) => l.linkId === l1.linkId).status, 'cancelled');

  // 并发：更正与关联同时提交，结果必须一致——没有任何有效关联指向已作废的项目，新项目的镜像与 expenseLinks 一致。
  const cap3 = await f.owner.call<{ id: string }>('recordExpense', cmd(f, { category: 'capital', description: '招牌灯', amountSen: 10_000, paid: true, paymentSource: 'owner' }));
  const [c1, c2] = await Promise.all([
    f.owner.code('correctStartupCost', cmd(f, { id: 'startup-seed-signboard', reason: '并发更正', amountSen: 46_000, group: 'signboard', title: '广告牌', details: [], note: '' })),
    f.owner.code('linkExpense', cmd(f, { expenseId: cap3.id, kind: 'startup', startupId: 'startup-seed-signboard', amountSen: 10_000 })),
  ]);
  assert.equal(c1, 'OK');
  assert.ok(c2 === 'OK' || c2 === 'NOT_FOUND', `关联结果 ${c2}`);
  const items = (await admin().collection(`stores/${f.storeId}/startupCosts`).get()).docs.map((d) => d.data());
  const allLinks = (await admin().collection(`stores/${f.storeId}/expenseLinks`).get()).docs.flatMap((d) => d.data().links.map((l: any) => ({ ...l, expenseId: d.id })));
  for (const l of allLinks.filter((x: any) => x.status === 'active' && x.kind === 'startup')) {
    const item = items.find((i) => i.id === l.startupId)!;
    assert.equal(item.status, 'active', `关联 ${l.linkId} 指向作废项目`);
    assert.ok(item.linkedExpenses.some((m: any) => m.linkId === l.linkId && m.status === 'active'), '镜像缺失');
  }
  for (const i of items.filter((x) => x.status === 'active')) {
    const mirror = (i.linkedExpenses ?? []).filter((m: any) => m.status === 'active').reduce((s: number, m: any) => s + m.amountSen, 0);
    assert.ok(mirror <= i.amountSen, '关联不超额');
    assert.equal(mirror, allLinks.filter((l: any) => l.status === 'active' && l.startupId === i.id).reduce((s: number, l: any) => s + l.amountSen, 0));
  }
});
