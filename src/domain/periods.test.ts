/** 最近 7 天 / 近 30 天：开档前不算、日均按营业天数、和前一段比（完整比总额，不完整比日均）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FixedCostPolicy, LedgerEvent } from './finance';
import { firstBusinessDay, periodFigures, periodRange } from './periods';

const fixed: FixedCostPolicy = { mode: 'calendar_day', monthlySen: 30_000 }; // 11 月每天 RM10
const pay = (businessDate: string, amountSen: number): LedgerEvent => ({ kind: 'payment', id: `p-${businessDate}-${amountSen}`, orderId: 'o', businessDate, method: 'unspecified', amountSen });
const cost = (businessDate: string, costUnits: number): LedgerEvent => ({ kind: 'cost_allocation', id: `c-${businessDate}`, orderId: 'o', businessDate, costUnits });
const bowl = (businessDate: string, fulfillmentStatus = 'served') => ({
  businessDate, fulfillmentStatus,
  items: [{ productKind: 'dry_noodle', size: 'small', quantity: 1, noodleHalfUnits: 2, wantonCount: 4, lineTotalSen: 900, sauce: 'black', noodleType: 'thin_egg' }],
}) as never;

test('区间：开档前的日子截掉，整段在开档前返回 null', () => {
  assert.deepEqual(periodRange('2026-11-14', 7, '2026-11-01'), { range: { start: '2026-11-08', endExclusive: '2026-11-15' }, clipped: false });
  assert.deepEqual(periodRange('2026-11-14', 30, '2026-11-05'), { range: { start: '2026-11-05', endExclusive: '2026-11-15' }, clipped: true });
  assert.equal(periodRange('2026-11-04', 7, '2026-11-05'), null);
  assert.equal(firstBusinessDay(['2026-11-07', '2026-11-05', '']), '2026-11-05');
  assert.equal(firstBusinessDay([]), null);
});

test('近 7 天：收入、利润（租金每天都摊）、日均按营业天数、最好的一天', () => {
  const events = [pay('2026-11-10', 30_000), pay('2026-11-12', 50_000), cost('2026-11-12', 100_000), pay('2026-11-12', 10_000)];
  const orders = [bowl('2026-11-10'), bowl('2026-11-12'), bowl('2026-11-12'), bowl('2026-11-12', 'cancelled')];
  const p = periodFigures({ events, orders, end: '2026-11-14', days: 7, firstDay: '2026-11-01', fixed })!;
  assert.equal(p.days.length, 7);
  assert.equal(p.netSen, 90_000);
  assert.equal(p.openDays, 2);
  assert.equal(p.avgNetSen, 45_000);
  assert.equal(p.best?.date, '2026-11-12');
  assert.equal(p.best?.netSen, 60_000);
  // 90000 − 理论成本 RM100（100000 × 0.1 sen）− 7 天租金 RM70
  assert.equal(p.profitSen, 90_000 - 10_000 - 7_000);
  assert.equal(p.orders, 3);
  assert.equal(p.bowls, 3);
  assert.equal(p.noodleHalf, 6);
  assert.equal(p.topDish?.bowls, 3);
  assert.equal(p.compare, null, '前 7 天没有生意就不比');
});

test('和前一段比：前 7 天完整比总额；刚开档不完整时比日均', () => {
  const events = [pay('2026-11-03', 20_000), pay('2026-11-04', 20_000), pay('2026-11-10', 30_000), pay('2026-11-11', 30_000)];
  const full = periodFigures({ events, orders: [], end: '2026-11-14', days: 7, firstDay: '2026-10-01', fixed })!;
  assert.deepEqual(full.compare, { kind: 'total', deltaSen: 20_000, baseSen: 40_000 });
  const young = periodFigures({ events, orders: [], end: '2026-11-14', days: 7, firstDay: '2026-11-03', fixed })!;
  assert.deepEqual(young.compare, { kind: 'avg', deltaSen: 10_000, baseSen: 20_000 });
});

test('近 30 天开档不到 30 天：只算开档以来，标记 clipped，不和前一段比', () => {
  const events = [pay('2026-11-05', 10_000), pay('2026-11-14', 10_000)];
  const p = periodFigures({ events, orders: [], end: '2026-11-14', days: 30, firstDay: '2026-11-05', fixed })!;
  assert.equal(p.clipped, true);
  assert.equal(p.days.length, 10);
  assert.equal(p.profitSen, 20_000 - 10 * 1_000);
  assert.equal(p.compare, null);
});
