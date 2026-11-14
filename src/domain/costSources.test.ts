/**
 * 成本来源与剩余：确认价钱变成 BOM 修改、收据推算单价、剩余从起点算、明天要多少、小结只能用算好的数字。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1 } from './bom';
import { applyBomChanges } from './catalog';
import {
  bomChangesFor, bomValueOf, buildSummaryFacts, CostSourcesDoc, DayUsage, EMPTY_COST_SOURCES, expectedUsage, normalizeUnitCost, numbersIn, plainSummary,
  receiptPrices, StockBatch, stockEstimates, summaryNumbers,
} from './costSources';
import { addDays } from './businessDay';
import { defaultConfig, linePortions, normalizeConfig } from './lineItem';
import { MENU_V1 as menu } from './menu';
import { materialUsage, UsageItem } from './usage';

const noodles = (n: number, size: 'small' | 'medium' | 'large' = 'small', noodleType: 'thin_egg' | 'mee_poh' = 'thin_egg'): UsageItem => {
  const c = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'red'), size, noodleType });
  const p = linePortions(menu, c);
  return { ...c, quantity: n, noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount, lineTotalSen: 700 * n };
};
const day = (date: string, items: UsageItem[]): DayUsage => ({ date, usage: materialUsage([{ fulfillmentStatus: 'served', items }]) });
const batch = (p: Partial<StockBatch>): StockBatch => ({ id: 'b1', ingredientId: 'ing-thin-noodle', quantity: 200, unit: '粒', costSen: 17_000, purchasedDate: '2026-11-12', status: 'stocked', createdAtMs: Date.UTC(2026, 10, 12, 2), ...p });

test('确认价钱 → BOM 修改：面团按整粒（偶数），底料两种餐品一起改，并去掉待校准', () => {
  const c = bomChangesFor([{ key: 'mee_poh', unitCostUnits: 901 }, { key: 'soup_base', unitCostUnits: 600 }, { key: 'wanton', unitCostUnits: 240 }]);
  assert.deepEqual(c.noodleBall, { mee_poh: 902 });
  assert.deepEqual(c.base, { soup_noodle: 600, wanton_soup: 600 });
  assert.equal(c.wanton, 240);
  assert.deepEqual(c.calibrated, ['noodleHalfBall.mee_poh', 'base.soup_noodle']);
  const r = applyBomChanges(BOM_V1, c, 'bom-test');
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(bomValueOf(r.bom, 'mee_poh'), 902);
    assert.equal(bomValueOf(r.bom, 'soup_base'), 600);
    assert.deepEqual(r.bom.pendingCalibration, ['scallion_lard_extra']);
  }
  assert.equal(normalizeUnitCost('thin_egg', 851.4), 852);
  assert.equal(normalizeUnitCost('char_siew', 1296.4), 1296);
});

test('收据价：面团按粒；叉烧按 kg × 每份克数；云吞按肉碎 kg ÷ 每公斤粒数 + 云吞皮', () => {
  const sources: CostSourcesDoc = { ...EMPTY_COST_SOURCES, conversions: { charSiewGramsPerPortion: { value: 25, kind: 'owner', basis: '', atMs: 0 } } };
  const prices = receiptPrices([
    batch({ id: 'old', quantity: 100, costSen: 8_000, purchasedDate: '2026-11-01' }),
    batch({ id: 'new', quantity: 220, costSen: 18_700, purchasedDate: '2026-11-12' }),
    batch({ id: 'kgnoodle', ingredientId: 'ing-mee-poh', quantity: 5, unit: 'kg' }),
    batch({ id: 'cs', ingredientId: 'ing-char-siew', quantity: 2, unit: 'kg', costSen: 9_600 }),
    batch({ id: 'pork', ingredientId: 'ing-minced-pork', quantity: 4, unit: 'kg', costSen: 7_600 }),
    batch({ id: 'skin', ingredientId: 'ing-wanton-skin', quantity: 2, unit: 'kg', costSen: 1_200 }),
    batch({ id: 'void', ingredientId: 'ing-char-siew', quantity: 1, unit: 'kg', costSen: 100, status: 'voided', purchasedDate: '2026-11-13' }),
  ], sources);
  const by = Object.fromEntries(prices.map((p) => [p.key, p]));
  assert.equal(by.thin_egg.unitCostUnits, 850);
  assert.equal(by.thin_egg.batchId, 'new');
  assert.equal(by.mee_poh, undefined, '面团按 kg 记的不能换成每粒价');
  assert.equal(by.char_siew.unitCostUnits, 1200); // RM48/kg × 25 g
  // 肉碎 RM19/kg ÷ 100 粒 = 0.19；云吞皮 RM6/kg ÷ 300 张 = 0.02
  assert.equal(by.wanton.unitCostUnits, 210);
  assert.match(by.wanton.basis, /云吞皮/);
});

test('剩余：没点过数就从近 30 天第一次进货算起；点过数就从点数算，之后的进货和用量才算', () => {
  const days = [
    day('2026-11-12', [noodles(20)]), day('2026-11-13', [noodles(30)]), day('2026-11-14', [noodles(10, 'large')]),
  ];
  const batches = [batch({ quantity: 100, purchasedDate: '2026-11-12' })];
  const [s] = stockEstimates({ batches, counts: [], days, today: '2026-11-14', sources: null });
  assert.equal(s.remaining, 100 - 20 - 30 - 20);
  assert.match(s.anchorText, /11\/12 进货算起/);
  const counted = stockEstimates({
    batches: [...batches, batch({ id: 'b2', quantity: 50, purchasedDate: '2026-11-14', createdAtMs: Date.UTC(2026, 10, 14, 1) })],
    counts: [{ id: 'c1', ingredientId: 'ing-thin-noodle', quantity: 12, unit: '粒', businessDate: '2026-11-13', atMs: Date.UTC(2026, 10, 13, 8) }],
    days, today: '2026-11-14', sources: null,
  })[0];
  assert.equal(counted.remaining, 12 + 50 - 20);
  assert.match(counted.anchorText, /11\/13 收档点过 12/);
});

test('剩余：肉碎按每公斤粒数换算；单位对不上就提示，不乱估', () => {
  const days = [day('2026-11-14', [noodles(25)])]; // 100 粒云吞
  const est = stockEstimates({
    batches: [batch({ ingredientId: 'ing-minced-pork', quantity: 2, unit: 'kg', purchasedDate: '2026-11-14' }), batch({ id: 'x', ingredientId: 'ing-mee-poh', quantity: 3, unit: 'kg' })],
    counts: [], days, today: '2026-11-14', sources: null,
  });
  const pork = est.find((e) => e.ingredientId === 'ing-minced-pork')!;
  assert.equal(pork.remaining, 1);
  assert.equal(pork.unit, 'kg');
  const mp = est.find((e) => e.ingredientId === 'ing-mee-poh')!;
  assert.match(mp.unitIssue ?? '', /按粒记/);
  assert.equal(mp.status, null);
});

test('明天要多少：前三周同一天平均；不够就用近 7 天营业日平均；不够明天标 short', () => {
  const sat = '2026-11-14';
  const days = [
    day(addDays(sat, -20), [noodles(40)]), day(addDays(sat, -13), [noodles(60)]), day(addDays(sat, -6), [noodles(50)]),
    day(addDays(sat, -1), [noodles(10)]), day(sat, [noodles(10)]),
  ];
  assert.equal(expectedUsage(days, addDays(sat, 1), (u) => u.noodleHalf / 2), 50);
  assert.equal(expectedUsage([day(addDays(sat, -1), [noodles(10)]), day(sat, [noodles(20)])], addDays(sat, 1), (u) => u.noodleHalf / 2), 15);
  const [s] = stockEstimates({ batches: [batch({ quantity: 200, purchasedDate: addDays(sat, -20) })], counts: [], days, today: sat, sources: null });
  assert.equal(s.remaining, 200 - 170);
  assert.equal(s.tomorrowNeed, 50);
  assert.equal(s.status, 'short');
});

test('小结：数字只来自算好的结果；白话小结也只用这些数字', () => {
  const usage = materialUsage([{ fulfillmentStatus: 'served', items: [noodles(3), noodles(2, 'medium')] }]);
  const f = buildSummaryFacts({
    date: '2026-11-14', usage, revenueSen: 3_900, lastWeek: { usage: materialUsage([{ fulfillmentStatus: 'served', items: [noodles(2)] }]), revenueSen: 1_400 },
    hourly: [{ hour: 8, sen: 2_500 }, { hour: 9, sen: 1_400 }], days: [day('2026-11-07', [noodles(4)]), day('2026-10-31', [noodles(6)])], stock: [], ballsTarget: 50,
  });
  assert.equal(f.balls, '6');
  assert.equal(f.tomorrow.weekday, '周日');
  assert.equal(f.lastWeekBowls, 2);
  assert.equal(f.peakHour?.hour, 8);
  const allowed = summaryNumbers(f);
  for (const line of plainSummary(f)) for (const n of numbersIn(line)) assert.ok(allowed.has(n), `${n} 不在允许的数字里：${line}`);
  assert.deepEqual(numbersIn('卖了 1,234.50 和 59½ 粒'), ['1234.50', '59½']);
});
