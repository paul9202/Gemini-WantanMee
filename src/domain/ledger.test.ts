/** 账本 → 日结与报表（04 §5 固定样本、F04、F06、作废支出、产品结构、CSV）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1, closeFigures, csvClose, csvExpenses, csvOrders, DEFAULT_FIXED_COST, describeDiff, dishRanking, LedgerDocs, OrderReportRow, productMix, receiptsTrend, wastageCostUnits } from './index';

const D = '2026-10-22';
const docs = (): LedgerDocs => ({
  payments: [
    { id: 'p1', orderId: 'o1', businessDate: D, method: 'cash', amountSen: 8000, occurredAtMs: 1 },
    { id: 'p2', orderId: 'o2', businessDate: D, method: 'qr_manual', amountSen: 4000, occurredAtMs: 2 },
  ],
  refunds: [{ id: 'r1', orderId: 'o1', businessDate: D, method: 'cash', amountSen: 1000, occurredAtMs: 3, reason: '顾客离开' }],
  costEvents: [{ id: 'c1', orderId: 'o1', businessDate: D, costUnits: 35000, kind: 'allocate' }],
  wastage: [
    { id: 'w1', businessDate: D, costUnits: 2000, alreadyAllocated: false, noodleHalfUnits: 2, wantonCount: 0, charSiewPortions: 0, reason: 'dropped', note: '', linkedOrderId: null, status: 'active', occurredAtMs: 4 },
    { id: 'w2', businessDate: D, costUnits: 9999, alreadyAllocated: true, noodleHalfUnits: 3, wantonCount: 3, charSiewPortions: 1, reason: 'other', note: '取消单', linkedOrderId: 'o9', status: 'active', occurredAtMs: 5 },
    { id: 'w3', businessDate: D, costUnits: 88888, alreadyAllocated: false, noodleHalfUnits: 9, wantonCount: 0, charSiewPortions: 0, reason: 'other', note: '录错', linkedOrderId: null, status: 'voided', occurredAtMs: 6 },
  ],
  expenses: [
    { id: 'e1', category: 'opex', description: '煤气', amountSen: 500, paidSen: 500, paymentSource: 'drawer', businessDate: D, accrualDate: D, status: 'active', occurredAtMs: 7, correctionOf: null },
    { id: 'e2', category: 'purchase', description: '面球', amountSen: 5000, paidSen: 5000, paymentSource: 'drawer', businessDate: D, accrualDate: D, status: 'active', occurredAtMs: 8, correctionOf: null },
    { id: 'e3', category: 'purchase', description: '录错金额', amountSen: 50000, paidSen: 50000, paymentSource: 'drawer', businessDate: D, accrualDate: D, status: 'voided', occurredAtMs: 9, correctionOf: null },
  ],
  cashMovements: [{ id: 'f', businessDate: D, type: 'opening_float', amountSen: 10000, occurredAtMs: 0 }],
});

test('固定样本：估算利润 3897、经营现金净流入 5500、钱箱应有 11500；已分配损耗与作废记录不扣', () => {
  const f = closeFigures(docs(), { businessDate: D, countedCashSen: 11300, qrBankConfirmedSen: 4000 }, DEFAULT_FIXED_COST);
  assert.equal(f.summary.estimatedProfitSen, 3897);
  assert.equal(f.summary.cash.operatingNetInflowSen, 5500);
  assert.equal(f.expectedCashSen, 11500);
  assert.equal(f.cashDiffSen, -200);
  assert.equal(describeDiff(f.cashDiffSen), '实际比应有少 RM2.00');
  assert.equal(f.qrLedgerNetSen, 4000);
  assert.equal(f.qrDiffSen, 0);
  assert.equal(f.summary.wastageAlreadyAllocatedCount, 1);
});

test('损耗成本按 BOM：1 面球 + 3 云吞 + 1 叉烧 = 850+660+1200', () => {
  assert.equal(wastageCostUnits(BOM_V1, { noodleHalfUnits: 2, wantonCount: 3, charSiewPortions: 1 }), 2710);
});

const order = (patch: Partial<OrderReportRow>): OrderReportRow => ({
  id: 'o', receiptNumber: '261022-001', businessDate: D, tokenNumber: 1, serviceMode: 'dine_in', source: 'online', fulfillmentStatus: 'served',
  paymentState: 'paid', paymentMethod: 'cash', totalSen: 900, acceptedAtEffectiveMs: 0, servedAtMs: 300_000, timeQuality: 'server',
  items: [{ productKind: 'dry_noodle', sauce: 'black', noodleType: 'thin_egg', isKosong: false, quantity: 2, nameZh: '黑酱面 · 中' }], ...patch,
});

test('产品结构只算已出餐份数（退款但已出餐仍算），酱料与面种分开', () => {
  const m = productMix([
    order({}),
    order({ id: 'b', paymentState: 'refunded', items: [{ productKind: 'soup_noodle', sauce: null, noodleType: 'mee_poh', isKosong: false, quantity: 1, nameZh: '云吞汤面 · 小' }] }),
    order({ id: 'c', fulfillmentStatus: 'cancelled' }),
  ]);
  assert.equal(m.portionsServed, 3);
  assert.deepEqual(m.byProduct.map((x) => [x.label, x.portions]), [['干捞面', 2], ['云吞汤面', 1]]);
  assert.deepEqual(m.bySauce.map((x) => [x.label, x.portions]), [['黑酱', 2]]);
  assert.deepEqual(m.byNoodle.map((x) => [x.label, x.portions]), [['细面', 2], ['面薄', 1]]);
});

test('F12 导出：UTF-8 BOM、时区、金额单位、公式注入防护', () => {
  const o = csvOrders([order({ items: [{ productKind: 'dry_noodle', sauce: 'black', noodleType: 'thin_egg', isKosong: false, quantity: 1, nameZh: '黑酱面', note: '=cmd|calc' }] })], 'Asia/Kuala_Lumpur');
  assert.ok(o.startsWith('﻿营业日,票号'));
  assert.ok(o.includes('(Asia/Kuala_Lumpur)'));
  assert.ok(o.includes('金额_sen'));
  const e = csvExpenses([{ ...docs().expenses[0], description: '+SUM(A1)' }], 'Asia/Kuala_Lumpur');
  assert.ok(e.includes("'+SUM(A1)"));
  const c = csvClose(closeFigures(docs(), { businessDate: D, countedCashSen: 11300, qrBankConfirmedSen: 4000 }, DEFAULT_FIXED_COST), 1, '少了两块，已记录');
  assert.ok(c.includes('实际比应有少 RM2.00'));
});

test('畅销品按 6 张入口排行：干捞面分酱料，净面计入原餐品，未出餐不计', () => {
  const r = dishRanking([
    order({}),
    order({ id: 'k', items: [{ productKind: 'dry_noodle', sauce: 'black', noodleType: 'mee_poh', isKosong: true, quantity: 1, nameZh: '净面 · 黑酱面 · 小' }] }),
    order({ id: 'r', items: [{ productKind: 'dry_noodle', sauce: 'red', noodleType: 'thin_egg', isKosong: false, quantity: 1, nameZh: '红酱面 · 小' }] }),
    order({ id: 'x', fulfillmentStatus: 'queued', items: [{ productKind: 'wanton_soup', sauce: null, noodleType: null, isKosong: false, quantity: 5, nameZh: '云吞汤 · 10粒' }] }),
  ]);
  assert.deepEqual(r.map((x) => [x.label, x.portions, x.photoId]), [['黑酱面', 3, 'dish.dry_noodle.black'], ['红酱面', 1, 'dish.dry_noodle.red']]);
});

test('收款走势：单日按门店时区整点（含退款、补齐空档），多日按营业日补零', () => {
  const at = (h: number, m = 0) => Date.UTC(2026, 9, 22, h - 8, m); // 吉隆坡 UTC+8
  const pays = [
    { id: 'a', orderId: 'o', businessDate: D, method: 'cash' as const, amountSen: 700, occurredAtMs: at(7, 10) },
    { id: 'b', orderId: 'o', businessDate: D, method: 'cash' as const, amountSen: 900, occurredAtMs: at(7, 55) },
    { id: 'c', orderId: 'o', businessDate: D, method: 'qr_manual' as const, amountSen: 1100, occurredAtMs: at(9, 5) },
  ];
  const refunds = [{ id: 'r', orderId: 'o', businessDate: D, method: 'cash' as const, amountSen: 700, occurredAtMs: at(9, 30), reason: 'x' }];
  const day = receiptsTrend(pays, refunds, { start: D, endExclusive: '2026-10-23' }, 'Asia/Kuala_Lumpur');
  assert.deepEqual(day.map((b) => [b.label, b.netSen]), [['07:00', 1600], ['08:00', 0], ['09:00', 400]]);
  const week = receiptsTrend(pays, refunds, { start: '2026-10-21', endExclusive: '2026-10-24' }, 'Asia/Kuala_Lumpur');
  assert.deepEqual(week.map((b) => [b.label, b.netSen]), [['10-21', 0], ['10-22', 2000], ['10-23', 0]]);
  assert.deepEqual(receiptsTrend([], [], { start: D, endExclusive: '2026-10-23' }, 'Asia/Kuala_Lumpur'), []);
});
