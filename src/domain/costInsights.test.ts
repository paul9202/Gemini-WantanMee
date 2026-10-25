import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedAmounts, buildCostStats, compareRangeOf, normalizeQuantity, StatsBatch, StatsExpense, StatsPurchaseDetail, statsDigest } from './costInsights';
import type { ExpenseLinkDoc } from './costing';

const OCT = { start: '2026-10-01', endExclusive: '2026-10-26' };
const e = (id: string, patch: Partial<StatsExpense>): StatsExpense => ({ id, category: 'purchase', description: id, amountSen: 1000, paidSen: 1000, businessDate: '2026-10-10', status: 'active', ...patch });
const stats = (expenses: StatsExpense[], extra: { links?: ExpenseLinkDoc[]; batches?: StatsBatch[]; purchaseDetails?: StatsPurchaseDetail[]; range?: typeof OCT } = {}) =>
  buildCostStats({ expenses, links: extra.links ?? [], batches: extra.batches ?? [], purchaseDetails: extra.purchaseDetails ?? [], range: extra.range ?? OCT });

test('同一笔采购：收据凭证、支出、库存批次不重复统计；作废排除；赊账计入发生额，付清只改付款维度', () => {
  const batch: StatsBatch = { id: 'b1', ingredientId: 'ing-scallion', ingredientName: '葱', category: 'topping', quantity: 1, unit: 'kg', purchaseExpenseId: 'x1', status: 'stocked' };
  const s = stats([
    e('x1', { ingredientBatchId: 'b1', costCategory: 'topping' }),
    e('x2', { amountSen: 3200, paidSen: 0, costCategory: 'wonton' }),
    e('x3', { amountSen: 5000, status: 'voided' }),
    e('pay-x2', { amountSen: 0, paidSen: 3200, settlesExpenseId: 'x2', businessDate: '2026-10-20' }),
  ], { batches: [batch] });
  assert.equal(s.current.totalSen, 4200);
  assert.equal(s.current.paidSen, 4200, '补付款让 x2 变成已付，但不增加开销');
  assert.equal(s.current.recordCount, 2);
  assert.deepEqual(s.current.byBucket.map((b) => [b.bucket, b.sen]), [['wonton', 3200], ['topping', 1000]]);
  assert.equal(s.outstanding.totalSen, 0);
});

test('月租不重复：开档已关联的部分与资本支出单列，不算日常开销；旧营业费用无项目归杂费', () => {
  const links: ExpenseLinkDoc[] = [{ expenseId: 'old', links: [{ linkId: 'l', kind: 'startup', startupId: 's', amountSen: 30_000, status: 'active' }] }];
  const s = stats([
    e('rent', { category: 'fixed_payment', planItem: 'rent', amountSen: 80_000, paidSen: 80_000 }),
    e('old', { category: 'opex', amountSen: 50_000, paidSen: 50_000 }),
    e('cap', { category: 'capital', amountSen: 99_000, paidSen: 99_000 }),
  ], { links });
  assert.equal(s.current.totalSen, 100_000);
  assert.deepEqual(s.current.byBucket.map((b) => [b.bucket, b.sen]), [['rent', 80_000], ['misc', 20_000]]);
  assert.deepEqual(s.excluded, { capitalSen: 99_000, startupLinkedSen: 30_000, laterCapitalSen: 0 });
});

test('对比区间：月初起 25 天对比上月前 25 天；短月取到月底；任意区间对比前面等长天数', () => {
  assert.deepEqual(compareRangeOf(OCT), { start: '2026-09-01', endExclusive: '2026-09-26' });
  assert.deepEqual(compareRangeOf({ start: '2026-03-01', endExclusive: '2026-04-01' }), { start: '2026-02-01', endExclusive: '2026-03-01' });
  assert.deepEqual(compareRangeOf({ start: '2026-10-10', endExclusive: '2026-10-17' }), { start: '2026-10-03', endExclusive: '2026-10-10' });
  const s = stats([], { range: { start: '2026-03-01', endExclusive: '2026-04-01' } });
  assert.equal(s.coverage.sameLength, false);
  assert.ok(s.coverage.notes.some((n) => /天数不同/.test(n)));
});

test('单价：kg 与 g 可换算比较；瓶与 kg 不比较；没有数量只说采购金额', () => {
  assert.deepEqual(normalizeQuantity(500, 'g'), { base: 'kg', quantity: 0.5 });
  const b = (id: string, qty: number, unit: string, ingredientId = 'ing-minced-pork'): StatsBatch => ({ id, ingredientId, ingredientName: '肉碎', category: 'wonton', quantity: qty, unit, purchaseExpenseId: null, status: 'stocked' });
  const s = stats([
    e('now', { amountSen: 3000, ingredientBatchId: 'b-now', costCategory: 'wonton' }),
    e('before', { amountSen: 1400, businessDate: '2026-09-05', ingredientBatchId: 'b-before', costCategory: 'wonton' }),
    e('sauce-now', { amountSen: 900, ingredientBatchId: 'b-s1', costCategory: 'seasoning' }),
    e('sauce-before', { amountSen: 800, businessDate: '2026-09-05', ingredientBatchId: 'b-s2', costCategory: 'seasoning' }),
    e('noqty', { amountSen: 500, costCategory: 'topping' }),
  ], { batches: [b('b-now', 2, 'kg'), b('b-before', 1000, 'g'), b('b-s1', 1, '瓶', 'ing-oyster-sauce'), b('b-s2', 0.5, 'kg', 'ing-oyster-sauce')] });
  assert.deepEqual(s.unitPrices.map((u) => [u.ingredientId, u.unit, u.currentPerUnitSen, u.previousPerUnitSen]), [['ing-minced-pork', 'kg', 1500, 1400]]);
  assert.equal(s.coverage.foodRecords, 3);
  assert.equal(s.coverage.foodWithQuantity, 2);
  assert.ok(s.coverage.notes.some((n) => /没有数量/.test(n)));
});

test('没有记录：零除安全、空统计；可引用金额包含差额；摘要随付款 / 作废 / 归属变化而变', async () => {
  const empty = stats([]);
  assert.deepEqual([empty.current.totalSen, empty.current.byBucket.length, empty.evidence.length, empty.unitPrices.length], [0, 0, 0, 0]);
  const base = [e('a', { amountSen: 3200, paidSen: 0, costCategory: 'wonton' }), e('b', { amountSen: 1000, businessDate: '2026-09-02', costCategory: 'wonton' })];
  const s1 = stats(base);
  const allowed = allowedAmounts(s1);
  for (const n of [3200, 1000, 2200]) assert.ok(allowed.has(n), String(n));
  const d1 = await statsDigest(s1);
  assert.equal(await statsDigest(stats(base)), d1, '同样的账目同样的摘要');
  const paid = await statsDigest(stats([...base, e('p', { amountSen: 0, paidSen: 3200, settlesExpenseId: 'a', businessDate: '2026-10-20' })]));
  const voided = await statsDigest(stats([{ ...base[0], status: 'voided' }, base[1]]));
  const linked = await statsDigest(stats(base, { links: [{ expenseId: 'a', links: [{ linkId: 'x', kind: 'later_capital', amountSen: 100, status: 'active' }] }] }));
  assert.equal(new Set([d1, paid, voided, linked]).size, 4);
});

test('补过用量的待补采购：用量与库存只算一次，不重复', () => {
  const pd: StatsPurchaseDetail = { id: 'pd', expenseId: 'x', ingredientId: 'ing-scallion', name: '葱', quantity: 1, unit: 'kg', usageState: 'stocked' };
  const batch: StatsBatch = { id: 'b', ingredientId: 'ing-scallion', ingredientName: '葱', category: 'topping', quantity: 1, unit: 'kg', purchaseExpenseId: 'x', status: 'stocked' };
  const s = stats([e('x', { ingredientBatchId: 'b', costCategory: 'topping', purchaseDetailId: 'pd' })], { batches: [batch], purchaseDetails: [pd] });
  assert.equal(s.current.totalSen, 1000);
  assert.equal(s.coverage.pendingUsage, 0);
  assert.equal(s.coverage.foodWithQuantity, 1);
});
