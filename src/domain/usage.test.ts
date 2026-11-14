/**
 * 每天用料（经营改版）：面团粒数按面种 × 大小，云吞、叉烧扣掉净面和「不要叉烧」，加料只算它带的云吞 / 叉烧，取消的单不算。
 * 材料成本 = 用量 × 当前单位成本，加起来要和下单时的理论成本一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1, unitCostUnits } from './bom';
import { computeTotals } from './cart';
import { defaultConfig, LineConfig, linePortions, normalizeConfig, NOTE_NO_CHAR_SIEW } from './lineItem';
import { MENU_V1 as menu, ServiceMode } from './menu';
import { ballsText } from './costing';
import { bowlMargins, materialCost, materialUsage, UsageItem, UsageOrder } from './usage';

const cfg = (kind: LineConfig['productKind'], patch: Partial<LineConfig> = {}): LineConfig =>
  normalizeConfig(menu, { ...defaultConfig(menu, kind, kind === 'dry_noodle' ? 'red' : kind === 'dry_wanton' ? 'black' : null), ...patch });

/** 和服务器写订单行一样：配置 + 数量 + 单份半粒数 / 云吞数 + 行金额。 */
const item = (c: LineConfig, quantity = 1, serviceMode: ServiceMode = 'dine_in'): UsageItem => {
  const p = linePortions(menu, c);
  const totals = computeTotals(menu, BOM_V1, { serviceMode, lines: [{ lineId: 'L1', config: c, quantity, serviceMode }] });
  return { ...c, quantity, serviceMode, noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount, lineTotalSen: totals.totalSen };
};
const order = (items: UsageItem[], fulfillmentStatus = 'served'): UsageOrder => ({ fulfillmentStatus, items });

test('面团粒数：小 1、中 1½、大 2，按面种 × 大小分格', () => {
  const u = materialUsage([
    order([item(cfg('dry_noodle', { size: 'small' }), 2), item(cfg('dry_noodle', { size: 'medium', noodleType: 'mee_poh' }))]),
    order([item(cfg('soup_noodle', { size: 'large' }))]),
  ]);
  assert.equal(u.noodleHalf, 2 * 2 + 3 + 4);
  assert.equal(ballsText(u.noodleHalf), '5½');
  assert.deepEqual(u.noodle.thin_egg.small, { bowls: 2, half: 4 });
  assert.deepEqual(u.noodle.mee_poh.medium, { bowls: 1, half: 3 });
  assert.deepEqual(u.noodle.thin_egg.large, { bowls: 1, half: 4 });
  assert.deepEqual(u.noodleHalfByType, { thin_egg: 8, mee_poh: 3 });
  assert.equal(u.noodleBowls, 4);
  assert.equal(u.bowls, 4);
});

test('云吞：面碗 4 粒、净面 0 粒、云吞 10 / 15 粒、加云吞 3 粒；分来源加起来等于总数', () => {
  const u = materialUsage([order([
    item(cfg('dry_noodle'), 2),
    item(cfg('dry_noodle', { isKosong: true })),
    item(cfg('wanton_soup', { size: 'w10' })),
    item(cfg('dry_wanton', { size: 'w15', addOns: ['wanton_3'] })),
  ])]);
  assert.equal(u.wanton.fromNoodle, 8);
  assert.equal(u.wanton.noodleBowls, 2);
  assert.equal(u.wanton.fromWanton10, 10);
  assert.equal(u.wanton.fromWanton15, 15);
  assert.equal(u.wanton.extraPacks, 1);
  assert.equal(u.wanton.extraCount, 3);
  assert.equal(u.wanton.total, 8 + 10 + 15 + 3);
  assert.equal(u.wanton.fromNoodle + u.wanton.fromWanton10 + u.wanton.fromWanton15 + u.wanton.extraCount, u.wanton.total);
  assert.equal(u.kosongBowls, 1);
});

test('叉烧：面碗 1 份，净面和「不要叉烧」不放，加叉烧另算', () => {
  const u = materialUsage([order([
    item(cfg('dry_noodle'), 3),
    item(cfg('soup_noodle', { addOns: ['char_siew'] })),
    item(cfg('dry_noodle', { isKosong: true })),
    item(cfg('dry_noodle', { note: NOTE_NO_CHAR_SIEW })),
  ])]);
  assert.equal(u.charSiew.fromNoodle, 4);
  assert.equal(u.charSiew.noodleBowls, 4);
  assert.equal(u.charSiew.extra, 1);
  assert.equal(u.charSiew.total, 5);
  assert.equal(u.noCharSiewBowls, 1);
  // 不要叉烧的碗云吞照放
  assert.equal(u.wanton.fromNoodle, 4 * 5);
});

test('下单后加料不算一碗，只算它带的云吞和叉烧；取消的单不算', () => {
  const extra = cfg('extra', { addOns: ['char_siew', 'wanton_3'] });
  const u = materialUsage([
    order([item(cfg('dry_noodle'))]),
    order([item(extra)]),
    order([item(cfg('dry_noodle', { size: 'large' }), 5)], 'cancelled'),
  ]);
  assert.equal(u.orders, 2);
  assert.equal(u.bowls, 1);
  assert.equal(u.noodleHalf, 2);
  assert.equal(u.wanton.total, 4 + 3);
  assert.equal(u.charSiew.total, 1 + 1);
  assert.equal(u.takeawayBowls, 0);
});

test('打包、酱料、按餐品入口排行', () => {
  const u = materialUsage([order([
    item(cfg('dry_noodle', { sauce: 'black' }), 2, 'takeaway'),
    item(cfg('dry_noodle', { sauce: 'red' }), 1),
    item(cfg('dry_wanton', { sauce: 'red' }), 1, 'takeaway'),
  ])]);
  assert.equal(u.takeawayBowls, 3);
  assert.deepEqual(u.bySauce, { black: 2, white: 0, red: 2 });
  assert.deepEqual(u.byDish.map((d) => [d.label, d.bowls, d.sen]), [['黑酱面', 2, 1400], ['干捞云吞', 1, 700], ['红酱面', 1, 700]]);
});

test('旧订单行没有半粒数 / 云吞数时按菜单补算', () => {
  const c = cfg('soup_noodle', { size: 'medium' });
  const u = materialUsage([order([{ ...c, quantity: 2 }])]);
  assert.equal(u.noodleHalf, 6);
  assert.equal(u.wanton.total, 8);
  assert.equal(u.charSiew.total, 2);
});

test('材料成本按用量 × 单位成本，合计等于下单时的理论成本（含打包）', () => {
  const lines: { c: LineConfig; q: number; m: ServiceMode }[] = [
    { c: cfg('dry_noodle', { size: 'medium', addOns: ['char_siew'] }), q: 2, m: 'takeaway' },
    { c: cfg('soup_noodle', { size: 'small', noodleType: 'mee_poh' }), q: 1, m: 'dine_in' },
    { c: cfg('wanton_soup', { size: 'w15' }), q: 1, m: 'takeaway' },
    { c: cfg('dry_wanton', { size: 'w10', addOns: ['wanton_3'] }), q: 1, m: 'dine_in' },
    { c: cfg('dry_noodle', { isKosong: true }), q: 1, m: 'dine_in' },
  ];
  const u = materialUsage([order(lines.map((l) => item(l.c, l.q, l.m)))]);
  const { lines: cost, totalUnits } = materialCost(u, BOM_V1);
  const expected = lines.reduce((s, l) => s + computeTotals(menu, BOM_V1, { serviceMode: l.m, lines: [{ lineId: 'L1', config: l.c, quantity: l.q, serviceMode: l.m }] }).totalCostUnits, 0);
  assert.equal(totalUnits, expected);
  assert.equal(cost.find((l) => l.key === 'packaging')!.qty, 3);
  assert.equal(cost.find((l) => l.key === 'thin_egg')!.unitCostUnits, 850);
});

test('每碗赚多少：卖价与单位成本，净面和加料也列出', () => {
  const rows = bowlMargins(menu, BOM_V1);
  const small = rows.find((r) => r.group === 'dry_noodle' && r.label === '小')!;
  assert.equal(small.priceSen, 700);
  assert.equal(small.costUnits, unitCostUnits(menu, BOM_V1, cfg('dry_noodle', { size: 'small' })));
  assert.equal(rows.filter((r) => r.group === 'kosong').length, 3);
  const cs = rows.find((r) => r.label === '加叉烧')!;
  assert.equal(cs.costUnits, BOM_V1.charSiewPortion);
  assert.equal(rows.find((r) => r.label === '加云吞3粒')!.costUnits, 3 * BOM_V1.wanton);
});
