import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateReceiptAmounts, buildCostPostingPlan, CostDraftLine, EditedCostDraft, extractionToEdited, matchIngredient, validateCostDraft,
} from './aiCost';
import { BUILT_IN_INGREDIENTS } from './costing';

const line = (lineId: string, patch: Partial<CostDraftLine> = {}): CostDraftLine => ({
  lineId, name: `项目${lineId}`, category: 'topping', grossSen: 1000, quantity: null, unit: null, note: '', ingredientId: null,
  payment: 'inherit', includeInBusiness: true, excludeReason: null, periodMonth: null, workDays: null, ...patch,
});

const draft = (patch: Partial<EditedCostDraft> = {}): EditedCostDraft => ({
  purchaseDate: '2026-10-25', currency: 'MYR', payment: 'paid', paymentSource: 'unspecified', supplier: null, receiptNumber: null,
  discountSen: 0, taxSen: 0, printedTotalSen: null, difference: null, lines: [line('l1')], ...patch,
});

const codes = (d: EditedCostDraft) => validateCostDraft(d, { today: '2026-10-25' }).issues.map((i) => i.code);

test('折扣按毛额最大余数法分摊：[1000,3200,1200] 减 200 → [963,3081,1156]，合计 5200', () => {
  const out = allocateReceiptAmounts([{ lineId: 'a', grossSen: 1000 }, { lineId: 'b', grossSen: 3200 }, { lineId: 'c', grossSen: 1200 }], 200, 0);
  assert.deepEqual(out.map((x) => x.netSen), [963, 3081, 1156]);
  assert.equal(out.reduce((s, x) => s + x.netSen, 0), 5200);
  assert.deepEqual(out.map((x) => x.discountSen), [37, 119, 44]);
});

test('余数相同按 lineId 稳定排序；税费另外分摊；所有结果都是整数 sen', () => {
  const out = allocateReceiptAmounts([{ lineId: 'b', grossSen: 100 }, { lineId: 'a', grossSen: 100 }, { lineId: 'c', grossSen: 100 }], 1, 2);
  assert.deepEqual(out.map((x) => [x.lineId, x.discountSen, x.taxSen]), [['b', 0, 1], ['a', 1, 1], ['c', 0, 0]]);
  for (const x of out) assert.ok(Number.isSafeInteger(x.netSen));
  assert.throws(() => allocateReceiptAmounts([{ lineId: 'a', grossSen: 100 }], 101, 0), /折扣/);
});

test('收据 5400 折 200 → 5200：父收据不是额外支出；排除私人行后营业合计 4237，其他行净额不变、排除原因必填', () => {
  const lines = [line('l1', { grossSen: 1000, name: '洗发水' }), line('l2', { grossSen: 3200, category: 'wonton' }), line('l3', { grossSen: 1200, category: 'seasoning' })];
  const base = draft({ lines, discountSen: 200, printedTotalSen: 5200 });
  const plan = buildCostPostingPlan(base, { today: '2026-10-25' });
  assert.equal(plan.lines.length, 3, '只有三行明细，没有收据合计那一笔');
  assert.equal(plan.totals.businessTotalSen, 5200);
  assert.equal(plan.totals.computedTotalSen, 5200);

  const missingReason = draft({ lines: [{ ...lines[0], includeInBusiness: false }, lines[1], lines[2]], discountSen: 200, printedTotalSen: 5200 });
  assert.ok(codes(missingReason).includes('exclude_reason_required'));
  const excluded = draft({ lines: [{ ...lines[0], includeInBusiness: false, excludeReason: '私人用品' }, lines[1], lines[2]], discountSen: 200, printedTotalSen: 5200 });
  const p2 = buildCostPostingPlan(excluded, { today: '2026-10-25' });
  assert.equal(p2.totals.businessTotalSen, 4237);
  assert.deepEqual(p2.lines.map((l) => l.netSen), [3081, 1156], '其他行不多摊私人行的折扣');
  assert.deepEqual(p2.excluded.map((l) => [l.lineId, l.netSen, l.reason]), [['l1', 963, '私人用品']]);
  assert.equal(p2.totals.computedTotalSen, 5200, '收据核对仍按整张收据');
});

test('付款 100、找零 48 不是成本：只看明细、折扣与税费', () => {
  const d = draft({ lines: [line('l1', { grossSen: 1000 }), line('l2', { grossSen: 3200 }), line('l3', { grossSen: 1200 })], discountSen: 200, printedTotalSen: 5200 });
  const plan = buildCostPostingPlan(d, { today: '2026-10-25' });
  assert.equal(plan.lines.reduce((s, l) => s + l.netSen, 0), 5200);
});

test('数量可空；缺数量不阻止保存，也不伪造数量 1', () => {
  const plan = buildCostPostingPlan(draft({ lines: [line('l1', { name: '葱', grossSen: 1000 })] }), { today: '2026-10-25' });
  assert.equal(plan.lines[0].quantity, null);
  assert.equal(plan.lines[0].unit, null);
  assert.equal(plan.lines[0].stock, false, '没有数量就不建库存批次');
  const withQty = buildCostPostingPlan(draft({ lines: [line('l1', { name: '葱', quantity: 1, unit: 'kg', ingredientId: 'ing-scallion' })] }), { today: '2026-10-25' });
  assert.equal(withQty.lines[0].stock, true);
  assert.ok(codes(draft({ lines: [line('l1', { quantity: 1, unit: null })] })).includes('unit_required'));
  assert.ok(codes(draft({ lines: [line('l1', { quantity: 1.23456, unit: 'kg' })] })).includes('quantity_invalid'));
});

test('混合付款：行级覆盖全单；未知付款不能入账；unknown 不等于 unpaid', () => {
  const d = draft({ payment: 'unknown', lines: [line('l1', { category: 'wonton', payment: 'unpaid' }), line('l2', { category: 'gas', payment: 'paid' })] });
  const plan = buildCostPostingPlan(d, { today: '2026-10-25' });
  assert.deepEqual(plan.lines.map((l) => [l.kind, l.paid]), [['purchase', false], ['opex', true]]);
  const unknown = draft({ payment: 'unknown', lines: [line('l1', { payment: 'paid' }), line('l2')] });
  assert.deepEqual(validateCostDraft(unknown, { today: '2026-10-25' }).issues.filter((i) => i.code === 'payment_unknown').map((i) => i.lineId), ['l2']);
  assert.throws(() => buildCostPostingPlan(unknown, { today: '2026-10-25' }), /付款/);
});

test('未分类、缺金额、非法金额、重复行、空明细、超 50 行、未来日期、外币都被拦下', () => {
  assert.ok(codes(draft({ lines: [line('l1', { category: 'unknown' })] })).includes('category_required'));
  assert.ok(codes(draft({ lines: [line('l1', { grossSen: null })] })).includes('amount_required'));
  for (const bad of [Number.NaN, -100, 10.5, 0]) assert.ok(codes(draft({ lines: [line('l1', { grossSen: bad })] })).includes('amount_invalid'), String(bad));
  assert.ok(codes(draft({ lines: [line('l1'), line('l1')] })).includes('duplicate_line_id'));
  assert.ok(codes(draft({ lines: [] })).includes('no_lines'));
  assert.ok(codes(draft({ lines: Array.from({ length: 51 }, (_, i) => line(`l${i}`)) })).includes('too_many_lines'));
  assert.ok(codes(draft({ purchaseDate: '2026-10-26' })).includes('date_future'));
  assert.ok(codes(draft({ currency: 'CNY' })).includes('currency_unsupported'));
  assert.ok(codes(draft({ lines: [line('l1', { name: '  ' })] })).includes('name_required'));
});

test('折扣超过小计、负税费拒绝；全部折完净额 0 只留草稿', () => {
  assert.ok(codes(draft({ discountSen: 1001 })).includes('discount_exceeds'));
  assert.ok(codes(draft({ taxSen: -1 })).includes('amount_invalid'));
  const zero = draft({ lines: [line('l1', { grossSen: 1000 })], discountSen: 1000 });
  assert.ok(codes(zero).includes('nothing_to_post'));
  const partial = draft({ lines: [line('l1', { grossSen: 1 }), line('l2', { grossSen: 999 })], discountSen: 999 });
  const plan = buildCostPostingPlan(partial, { today: '2026-10-25' });
  assert.ok(plan.lines.every((l) => l.netSen > 0), '零净额行不生成支出');
  assert.deepEqual(plan.zeroLines.map((l) => l.lineId), ['l1']);
});

test('收据差额：未说明不能保存；说明后采用；之后再改金额，原确认失效；原收据总额不改', () => {
  const base = draft({ lines: [line('l1', { grossSen: 1000 }), line('l2', { grossSen: 3500 }), line('l3', { grossSen: 1200 })], discountSen: 200, printedTotalSen: 5200 });
  const v = validateCostDraft(base, { today: '2026-10-25' });
  assert.equal(v.totals.differenceSen, 300);
  assert.ok(v.issues.some((i) => i.code === 'difference_unconfirmed'));
  const accepted = { ...base, difference: { acceptedTotalSen: 5500, reason: '肉碎实际多买了一些' } };
  assert.deepEqual(codes(accepted), []);
  const changed = { ...accepted, lines: accepted.lines.map((l) => (l.lineId === 'l2' ? { ...l, grossSen: 3600 } : l)) };
  assert.ok(codes(changed).includes('difference_unconfirmed'));
  assert.equal(buildCostPostingPlan(accepted, { today: '2026-10-25' }).totals.printedTotalSen, 5200);
});

test('月租与电费需归属月份且必须已付；工资需出勤天数', () => {
  assert.ok(codes(draft({ lines: [line('l1', { category: 'rent' })] })).includes('period_month_required'));
  assert.ok(codes(draft({ payment: 'unpaid', lines: [line('l1', { category: 'rent', periodMonth: '2026-10' })] })).includes('recurring_must_be_paid'));
  assert.ok(codes(draft({ lines: [line('l1', { category: 'wage' })] })).includes('work_days_required'));
  const plan = buildCostPostingPlan(draft({ lines: [line('l1', { category: 'rent', periodMonth: '2026-10' }), line('l2', { category: 'wage', workDays: 3 })] }), { today: '2026-10-25' });
  assert.deepEqual(plan.lines.map((l) => [l.kind, l.planItem, l.periodMonth]), [['fixed_payment', 'rent', '2026-10'], ['opex', 'wage', null]]);
});

test('模型提取 → 可编辑草稿：缺日期用营业日；缺付款为待确认；不自动排除；外币保留提示', () => {
  const e = extractionToEdited({
    purchaseDate: null, currency: 'MYR', payment: 'unknown', paymentSource: null, supplier: null, receiptNumber: null,
    discountSen: 0, taxSen: 0, printedTotalSen: null,
    lines: [{ name: '葱', category: 'topping', amountSen: 1000, quantity: null, unit: null, payment: null, evidence: '葱10块', personalSuggested: false, periodMonth: null }],
    warnings: [],
  }, { defaultDate: '2026-10-25', ingredients: BUILT_IN_INGREDIENTS });
  assert.equal(e.purchaseDate, '2026-10-25');
  assert.equal(e.payment, 'unknown');
  assert.equal(e.paymentSource, 'unspecified');
  assert.equal(e.lines[0].ingredientId, 'ing-scallion');
  assert.equal(e.lines[0].quantity, null);
  assert.equal(e.lines[0].includeInBusiness, true);
  assert.equal(matchIngredient('肉碎', BUILT_IN_INGREDIENTS), 'ing-minced-pork');
  assert.equal(matchIngredient('新鲜的东西', BUILT_IN_INGREDIENTS), null);
});

test('付款来源「未说明」不算钱箱现金：钱箱应有不扣这笔', async () => {
  const { ledgerEvents } = await import('./ledger');
  const { expectedCashDrawer } = await import('./finance');
  const base = { category: 'purchase' as const, description: '葱', amountSen: 1000, paidSen: 1000, businessDate: '2026-10-25', accrualDate: '2026-10-25', status: 'active' as const, occurredAtMs: 1, correctionOf: null };
  const events = ledgerEvents({ payments: [], refunds: [], costEvents: [], wastage: [], cashMovements: [], expenses: [{ ...base, id: 'a', paymentSource: 'unspecified' }, { ...base, id: 'b', paymentSource: 'drawer' }] });
  assert.deepEqual(events.map((e) => e.kind === 'expense' && e.paidFromDrawer), [false, true]);
  assert.equal(expectedCashDrawer(events, '2026-10-25'), -1000);
});
