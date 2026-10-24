/** 同一单部分堂食、部分打包（店里吃完再打包带走，一次结账）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, BOM_V1, buildKitchenTicket, buildReceipt, cartServiceMode, computeTotals, defaultConfig, emptyCart, kitchenLineMode,
  MENU_V1, normalizeConfig, orderServiceMode, resolveLines, setLineQuantity, setLineServiceMode, setServiceMode, updateLineConfig,
} from './index';

const menu = MENU_V1;
const black = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'black'), size: 'medium' });
const soup = defaultConfig(menu, 'wanton_soup');

test('MX01 新加餐品按页头默认方式；同配置不同方式分成两行，不合并', () => {
  let cart = addLine(menu, emptyCart('dine_in'), black, 'a');
  cart = setLineServiceMode(cart, 'a', 'takeaway');
  // 页头仍是堂食：再点一碗同样的面 → 新的一行堂食，不并进打包那行
  assert.equal(cart.serviceMode, 'dine_in');
  cart = addLine(menu, cart, black, 'b');
  assert.deepEqual(cart.lines.map((l) => [l.lineId, l.serviceMode, l.quantity]), [['a', 'takeaway', 1], ['b', 'dine_in', 1]]);
  assert.equal(cartServiceMode(cart), 'mixed');
  // 再点一碗：并入同方式的那行
  cart = addLine(menu, cart, black, 'c');
  assert.deepEqual(cart.lines.map((l) => [l.lineId, l.quantity]), [['a', 1], ['b', 2]]);
});

test('MX02 单行切换方式：与同配置同方式的行合并；编辑配置也只在同方式内合并', () => {
  let cart = addLine(menu, emptyCart(), black, 'a', 2);
  cart = addLine(menu, setLineServiceMode(cart, 'a', 'takeaway'), black, 'b');
  cart = setLineServiceMode(cart, 'b', 'takeaway');
  assert.deepEqual(cart.lines.map((l) => [l.lineId, l.serviceMode, l.quantity]), [['a', 'takeaway', 3]]);
  cart = addLine(menu, cart, soup, 's');
  const edited = updateLineConfig(menu, cart, 's', black);
  assert.deepEqual(edited.lines.map((l) => [l.lineId, l.serviceMode, l.quantity]), [['a', 'takeaway', 3], ['s', 'dine_in', 1]]);
});

test('MX03 页头切换：未混合时整单一起换；已混合时只改之后新加的默认，不覆盖逐行选择', () => {
  let cart = addLine(menu, addLine(menu, emptyCart(), black, 'a'), soup, 's');
  cart = setServiceMode(cart, 'takeaway');
  assert.deepEqual(cart.lines.map((l) => l.serviceMode), ['takeaway', 'takeaway']);
  cart = setLineServiceMode(cart, 's', 'dine_in');
  cart = setServiceMode(cart, 'dine_in');
  assert.equal(cart.serviceMode, 'dine_in');
  assert.deepEqual(cart.lines.map((l) => l.serviceMode), ['takeaway', 'dine_in']);
  // 删到只剩一种方式后，页头又能整单切换
  cart = setLineQuantity(cart, 's', 0);
  assert.deepEqual(setServiceMode(cart, 'dine_in').lines.map((l) => l.serviceMode), ['dine_in']);
});

test('MX04 包装成本只算打包的份数；售价不变', () => {
  let cart = addLine(menu, emptyCart(), black, 'a', 2);
  cart = addLine(menu, cart, soup, 's', 3);
  cart = setLineServiceMode(cart, 'a', 'takeaway');
  const t = computeTotals(menu, BOM_V1, cart);
  assert.equal(t.takeawayPortionCount, 2);
  assert.equal(t.packagingCostUnits, 2 * BOM_V1.packagingPerPortion);
  assert.equal(t.totalSen, computeTotals(menu, BOM_V1, setServiceMode(cart, 'dine_in')).totalSen);
});

test('MX05 整单就餐方式；旧数据的行没有方式时按整单补齐', () => {
  assert.equal(orderServiceMode([]), 'dine_in');
  assert.equal(orderServiceMode([], 'takeaway'), 'takeaway');
  assert.equal(orderServiceMode(['takeaway', 'takeaway']), 'takeaway');
  assert.equal(orderServiceMode(['dine_in', 'takeaway']), 'mixed');
  const legacy = resolveLines([{ lineId: 'a', config: black, quantity: 1 }, { lineId: 'b', config: black, quantity: 1, serviceMode: 'dine_in' as const }], 'takeaway');
  assert.deepEqual(legacy.map((l) => l.serviceMode), ['takeaway', 'dine_in']);
});

test('MX06 厨单：整单标堂食+打包，逐行带方式；打包干捞行才有不附送清汤；旧厨单按整单', () => {
  const t = buildKitchenTicket(menu, {
    orderId: 'o', tokenNumber: 7, serviceMode: 'dine_in', kitchenRouting: 'digital', fulfillmentStatus: 'preparing', kitchenCancelRequested: false,
    acceptedAtEffectiveMs: 0, startedAtMs: 0, startedSource: 'auto', servedAtMs: null, timeQuality: 'server', businessDate: '2026-10-24', version: 1,
    lines: [{ lineId: 'a', config: black, quantity: 1 }, { lineId: 'b', config: black, quantity: 2, serviceMode: 'takeaway' }],
  });
  assert.equal(t.serviceMode, 'mixed');
  assert.deepEqual(t.lines.map((l) => kitchenLineMode(t, l)), ['dine_in', 'takeaway']);
  assert.ok(!t.lines[0].pictograms.some((p) => p.id === 'takeaway:no_side_soup'));
  assert.ok(t.lines[1].pictograms.some((p) => p.id === 'takeaway:no_side_soup'));
  assert.equal(kitchenLineMode({ serviceMode: 'takeaway' }, {}), 'takeaway');
});

test('MX07 收据：抬头堂食+打包，每行标出堂食 / 打包；单一方式的单不逐行标', () => {
  const base = {
    storeName: '豪云吞面', receiptNumber: '261024-001', offlineReceiptNumber: null, tokenNumber: 7, source: 'online' as const,
    acceptedAtMs: 0, timeQuality: 'server' as const, fulfillmentStatus: 'served' as const, servedAtMs: 60_000, paymentState: 'paid' as const,
    totalSen: 2700, paymentMethod: 'unspecified' as const, tenderedSen: null, changeSen: null, synced: true,
  };
  const rows = (d: ReturnType<typeof buildReceipt>) => d.rows.map((r) => `${r.left}|${r.right ?? ''}`);
  const mixed = rows(buildReceipt(menu, {
    ...base, serviceMode: 'mixed',
    lines: [{ config: black, quantity: 1, unitPriceSen: 900, serviceMode: 'dine_in' }, { config: black, quantity: 2, unitPriceSen: 900, serviceMode: 'takeaway' }],
  }, { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' }));
  assert.ok(mixed.includes('餐牌 7|堂食+打包'));
  const details = mixed.filter((r) => r.startsWith('  '));
  assert.ok(details[0].startsWith('  堂食'));
  assert.ok(details[1].startsWith('  打包') && details[1].includes('不附送清汤'));
  const single = rows(buildReceipt(menu, { ...base, serviceMode: 'takeaway', lines: [{ config: black, quantity: 1, unitPriceSen: 900 }] }, { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' }));
  assert.ok(single.includes('餐牌 7|打包'));
  assert.ok(!single.some((r) => r.startsWith('  打包')));
});
