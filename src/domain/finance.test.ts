/** 04 §5 财务、日期与精度：F01–F12（领域层部分）及固定样本。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocateMonthlyFixedCost, businessDateOf, DateRange, describeDrawerDifference, escapeCsvCell, expectedCashDrawer,
  estimateWaitRange, fixedCostForDate, formatRM, isDateString, LedgerEvent, lastNDays, parseRMInput, paybackProgress,
  previousRange, ratioOrNull, serviceStats, ServiceSampleSource, speedBucket, summarizePeriod, toCsv, kitchenUrgency,
  isOnTime, costUnitsToSen,
} from './index';

const DAY = '2026-10-22';
const one: DateRange = { start: DAY, endExclusive: '2026-10-23' };

/** 固定样本（04 §5）。 */
const sample: LedgerEvent[] = [
  { kind: 'cash_movement', id: 'f', businessDate: DAY, type: 'opening_float', amountSen: 10000 },
  { kind: 'payment', id: 'p1', orderId: 'o1', businessDate: DAY, method: 'cash', amountSen: 8000 },
  { kind: 'payment', id: 'p2', orderId: 'o2', businessDate: DAY, method: 'qr_manual', amountSen: 4000 },
  { kind: 'refund', id: 'r1', orderId: 'o1', businessDate: DAY, method: 'cash', amountSen: 1000 },
  { kind: 'cost_allocation', id: 'c1', orderId: 'o1', businessDate: DAY, costUnits: 35000 },
  { kind: 'wastage', id: 'w1', businessDate: DAY, costUnits: 2000, alreadyAllocated: false, noodleHalfUnits: 2, wantonCount: 0 },
  { kind: 'expense', id: 'e1', category: 'opex', businessDate: DAY, accrualDate: DAY, amountSen: 500, paidSen: 500, paidFromDrawer: true },
  { kind: 'expense', id: 'e2', category: 'purchase', businessDate: DAY, accrualDate: DAY, amountSen: 5000, paidSen: 5000, paidFromDrawer: true },
];

test('固定样本：净收 11000；估算利润 3897 = RM38.97（当日摊销 2903）', () => {
  // 2026-10 有 31 天，10-22 属于后 24 天 → 2903
  assert.equal(fixedCostForDate({ mode: 'calendar_day', monthlySen: 90000 }, DAY), 2903);
  const s = summarizePeriod(sample, one);
  assert.equal(s.netReceiptsSen, 11000);
  assert.equal(s.estimatedProfitSen, 3897);
  assert.equal(formatRM(s.estimatedProfitSen), 'RM38.97');
});

test('固定样本：经营现金净流入 5500；钱箱应有 11500；进货不进入经营利润', () => {
  const s = summarizePeriod(sample, one);
  assert.equal(s.cash.operatingNetInflowSen, 5500);
  assert.equal(expectedCashDrawer(sample, DAY), 11500);
  assert.deepEqual(describeDrawerDifference(11300, 11500), { diffSen: -200, kind: 'short' });
});

test('F01 改变报表周期：损耗/费用/订单按各自营业日筛选，不扣其他日期损耗', () => {
  const other: LedgerEvent[] = [
    ...sample,
    { kind: 'wastage', id: 'w-old', businessDate: '2026-10-01', costUnits: 99990, alreadyAllocated: false, noodleHalfUnits: 1, wantonCount: 0 },
    { kind: 'payment', id: 'p-old', orderId: 'x', businessDate: '2026-10-21', method: 'cash', amountSen: 700 },
  ];
  assert.equal(summarizePeriod(other, one).estimatedProfitSen, 3897);
  const week = summarizePeriod(other, lastNDays(DAY, 7));
  assert.equal(week.wastageCostUnits, 2000);
  assert.equal(week.receipts.totalSen, 12700);
});

test('F02 31 天月份固定费用：前 7 天 2904，后 24 天 2903，合计 90000', () => {
  const days = allocateMonthlyFixedCost(90000, 2026, 10);
  assert.equal(days.length, 31);
  assert.deepEqual(days.slice(0, 7), Array(7).fill(2904));
  assert.deepEqual(days.slice(7), Array(24).fill(2903));
  assert.equal(days.reduce((a, b) => a + b, 0), 90000);
  for (const [y, m] of [[2026, 2], [2028, 2], [2026, 4]]) {
    assert.equal(allocateMonthlyFixedCost(90000, y, m).reduce((a, b) => a + b, 0), 90000);
  }
});

test('F04 取消报废再登记损耗：同一份 BOM 不重复扣，仍可见数量', () => {
  const events: LedgerEvent[] = [
    { kind: 'payment', id: 'p', orderId: 'o', businessDate: DAY, method: 'cash', amountSen: 900 },
    { kind: 'cost_allocation', id: 'c', orderId: 'o', businessDate: DAY, costUnits: 3635 },
    { kind: 'wastage', id: 'w', businessDate: DAY, costUnits: 3635, alreadyAllocated: true, noodleHalfUnits: 3, wantonCount: 3 },
  ];
  const s = summarizePeriod(events, one);
  assert.equal(s.wastageCostUnits, 0);
  assert.equal(s.wastageAlreadyAllocatedCount, 1);
  assert.equal(s.allocatedCostUnits, 3635);
});

test('F03 待做取消成本反转：分配与反转相抵', () => {
  const events: LedgerEvent[] = [
    { kind: 'cost_allocation', id: 'c', orderId: 'o', businessDate: DAY, costUnits: 3635 },
    { kind: 'cost_allocation', id: 'c-rev', orderId: 'o', businessDate: DAY, costUnits: -3635 },
  ];
  assert.equal(summarizePeriod(events, one).allocatedCostUnits, 0);
});

test('F05 次日退款：减退款日净收，原销售日不变', () => {
  const events: LedgerEvent[] = [
    { kind: 'payment', id: 'p', orderId: 'o', businessDate: DAY, method: 'qr_manual', amountSen: 900 },
    { kind: 'refund', id: 'r', orderId: 'o', businessDate: '2026-10-23', method: 'qr_manual', amountSen: 900 },
  ];
  assert.equal(summarizePeriod(events, one).netReceiptsSen, 900);
  assert.equal(summarizePeriod(events, { start: '2026-10-23', endExclusive: '2026-10-24' }).netReceiptsSen, -900);
});

test('F06 同月付房租：现金流扣付款，经营只扣摊销', () => {
  const events: LedgerEvent[] = [
    { kind: 'expense', id: 'rent', category: 'fixed_payment', businessDate: DAY, accrualDate: '2026-10-01', amountSen: 90000, paidSen: 90000, paidFromDrawer: false },
  ];
  const s = summarizePeriod(events, one);
  assert.equal(s.cash.operatingNetInflowSen, -90000);
  assert.equal(s.estimatedProfitSen, -2903, '只扣当日摊销');
  assert.equal(s.otherOpexSen, 0);
  const month = summarizePeriod(events, { start: '2026-10-01', endExclusive: '2026-11-01' });
  assert.equal(month.estimatedProfitSen, -90000, '整月摊销恰好 90000，不再加一次房租');
});

test('F07 0 单 / 0 对比期 / 0 资本 / 亏损：比率为 null，不吞亏损，无演示期初', () => {
  const s = summarizePeriod([], one);
  assert.equal(s.netReceiptsSen, 0);
  assert.equal(s.estimatedProfitSen, -2903);
  assert.equal(ratioOrNull(5, 0), null);
  assert.equal(serviceStats([]).onTimeRate, null);
  assert.equal(serviceStats([]).avgMs, null);
  const loss = paybackProgress({ initialCapitalSen: 550000, openingBalanceSen: 0, cumulativeProfitSen: -10000 });
  assert.equal(loss.ratio, -10000 / 550000);
  assert.equal(loss.barRatio, 0);
  assert.equal(loss.remainingSen, 560000);
  assert.equal(loss.cumulativeResultSen, -10000);
  const over = paybackProgress({ initialCapitalSen: 550000, openingBalanceSen: 0, cumulativeProfitSen: 600000 });
  assert.ok(over.ratio! > 1);
  assert.equal(over.barRatio, 1);
  assert.equal(over.remainingSen, 0);
  assert.equal(paybackProgress({ initialCapitalSen: 0, openingBalanceSen: 0, cumulativeProfitSen: 1 }).applicable, false);
  assert.deepEqual(previousRange(lastNDays(DAY, 7)), { start: '2026-10-09', endExclusive: '2026-10-16' });
});

test('F08 479999/480000/719999/720000ms：正常/偏慢/偏慢/超时；达标只含第一项', () => {
  const xs = [479_999, 480_000, 719_999, 720_000];
  assert.deepEqual(xs.map(kitchenUrgency), ['normal', 'warning', 'warning', 'overdue']);
  assert.deepEqual(xs.map(speedBucket), ['normal', 'slow', 'slow', 'overdue']);
  assert.deepEqual(xs.map(isOnTime), [true, false, false, false]);
});

test('F09 239999/240000ms：极速/正常', () => {
  assert.deepEqual([239_999, 240_000].map(speedBucket), ['lightning', 'normal']);
});

test('F10 有效耗时 3/5/7/9 分：平均 6、中位 6、P90 9、达标 75%；排除无效与未核对离线样本', () => {
  const m = 60_000;
  const mk = (id: string, min: number, extra: Partial<ServiceSampleSource> = {}): ServiceSampleSource => ({
    orderId: id, serviceMode: 'dine_in', fulfillmentStatus: 'served', acceptedAtEffectiveMs: 0, servedAtMs: min * m, timeQuality: 'server', ...extra,
  });
  const stats = serviceStats([
    mk('a', 3), mk('b', 5), mk('c', 7), mk('d', 9, { serviceMode: 'takeaway' }),
    mk('off', 1, { timeQuality: 'device_estimated' }),
    mk('nos', 1, { servedAtMs: null }),
    mk('can', 1, { fulfillmentStatus: 'cancelled' }),
    mk('rev', 11, { timeQuality: 'reviewed' }),
  ]);
  // 复核过的离线样本应计入：5 个样本
  assert.equal(stats.count, 5);
  assert.equal(stats.excluded, 2);
  const core = serviceStats([mk('a', 3), mk('b', 5), mk('c', 7), mk('d', 9, { serviceMode: 'takeaway' })]);
  assert.equal(core.avgMs, 6 * m);
  assert.equal(core.medianMs, 6 * m);
  assert.equal(core.p90Ms, 9 * m);
  assert.equal(core.onTimeRate, 0.75);
  assert.deepEqual(core.distribution, { lightning: 1, normal: 2, slow: 1, overdue: 0 });
  assert.deepEqual(core.takeaway, { count: 1, avgMs: 9 * m });
});

test('预计等待：样本不足用 c=2；阻塞时不估计', () => {
  assert.deepEqual(estimateWaitRange({ servedAtMsRecent: [], openOrders: 3, blocked: false }), { minMinutes: 6, maxMinutes: 11, algorithm: 'wait-v1' });
  assert.deepEqual(estimateWaitRange({ servedAtMsRecent: [], openOrders: 0, blocked: false }), { minMinutes: 2, maxMinutes: 4, algorithm: 'wait-v1' });
  assert.equal(estimateWaitRange({ servedAtMsRecent: [], openOrders: 3, blocked: true }), null);
  // 间隔 10 分钟 → c 限制为 5
  const served = Array.from({ length: 8 }, (_, i) => i * 600_000);
  assert.deepEqual(estimateWaitRange({ servedAtMsRecent: served, openOrders: 2, blocked: false }), { minMinutes: 9, maxMinutes: 16, algorithm: 'wait-v1' });
});

test('营业日：切点 04:00（Asia/Kuala_Lumpur）', () => {
  // 2026-10-23 03:59 MYT = 2026-10-22 19:59 UTC
  assert.equal(businessDateOf(Date.UTC(2026, 9, 22, 19, 59)), '2026-10-22');
  assert.equal(businessDateOf(Date.UTC(2026, 9, 22, 20, 0)), '2026-10-23');
  assert.equal(businessDateOf(Date.UTC(2026, 9, 31, 19, 59)), '2026-10-31', '月末跨日');
  assert.equal(businessDateOf(Date.UTC(2026, 11, 31, 18, 0)), '2026-12-31', '跨年 02:00');
  assert.ok(isDateString('2026-02-28'));
  assert.ok(!isDateString('2026-02-30'));
});

test('F12 CSV：UTF-8 BOM、中文、逗号、换行、引号、公式注入防护', () => {
  const csv = toCsv([
    ['订单', '备注', '金额sen'],
    ['O-1', '少辣, 走青', 900],
    ['O-2', '第一行\n第二行', -150],
    ['O-3', '=HYPERLINK("http://x")', 0],
    ['O-4', '+1', null],
    ['O-5', '@SUM(A1)', 1],
    ['O-6', '-2+3', 2],
  ]);
  assert.ok(csv.startsWith('﻿订单,备注,金额sen\r\n'));
  assert.ok(csv.includes('O-1,"少辣, 走青",900'));
  assert.ok(csv.includes('"第一行\n第二行",-150'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://x"")"`));
  assert.ok(csv.includes("O-4,'+1,"));
  assert.ok(csv.includes("'@SUM(A1)"));
  assert.ok(csv.includes("'-2+3,2"));
  assert.equal(escapeCsvCell(-150), '-150', '数字列不被当公式改写');
});

test('金额：half-up 舍入与输入解析', () => {
  assert.equal(costUnitsToSen(3635), 364);
  assert.equal(costUnitsToSen(3634), 363);
  assert.equal(costUnitsToSen(-15), -2);
  assert.equal(formatRM(1600), 'RM16.00');
  assert.equal(formatRM(-150), '-RM1.50');
  assert.equal(formatRM(550000), 'RM5,500.00');
  assert.equal(parseRMInput('20'), 2000);
  assert.equal(parseRMInput('RM 16.5'), 1650);
  assert.equal(parseRMInput('1.234'), null);
  assert.equal(parseRMInput('-5'), null);
});
