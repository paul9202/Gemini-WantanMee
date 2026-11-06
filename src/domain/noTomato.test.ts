/**
 * 「不要番茄酱」：用备注字段的固定值表示。只有红酱能选，价钱不变，收银、后厨、收据都看得到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addLine, emptyCart } from './cart';
import { buildKitchenTicket, summarizeKitchen } from './kitchen';
import {
  allowsNoTomato, defaultConfig, hasNoTomato, LineConfig, lineMergeKey, normalizeConfig, NOTE_NO_TOMATO, parseLineConfig, unitPriceSen,
} from './lineItem';
import { MENU_V1 as menu } from './menu';
import { linePictograms } from './pictograms';
import { buildReceipt, ReceiptSource } from './receipt';

const red = (patch: Partial<LineConfig> = {}): LineConfig => ({ ...defaultConfig(menu, 'dry_noodle', 'red'), ...patch });

test('固定值不能改字：旧订单靠它识别', () => {
  assert.equal(NOTE_NO_TOMATO, '不要番茄酱');
});

test('只有红酱能选：干捞面和干捞云吞的红酱可以，黑酱、白酱和汤品不行', () => {
  assert.equal(allowsNoTomato(red()), true);
  assert.equal(allowsNoTomato(defaultConfig(menu, 'dry_wanton', 'red')), true);
  assert.equal(allowsNoTomato(defaultConfig(menu, 'dry_noodle', 'black')), false);
  assert.equal(allowsNoTomato(defaultConfig(menu, 'dry_noodle', 'white')), false);
  assert.equal(allowsNoTomato(defaultConfig(menu, 'soup_noodle')), false);
});

test('换成黑酱或汤品时清除，换回红酱不恢复；其他备注不受影响', () => {
  const on = normalizeConfig(menu, red({ note: NOTE_NO_TOMATO }));
  assert.equal(hasNoTomato(on), true);
  const black = normalizeConfig(menu, { ...on, sauce: 'black' });
  assert.equal(black.note, '');
  assert.equal(normalizeConfig(menu, { ...black, sauce: 'red' }).note, '');
  assert.equal(normalizeConfig(menu, { ...on, productKind: 'soup_noodle' }).note, '');
  assert.equal(normalizeConfig(menu, { ...on, sauce: 'black', note: '分开装' }).note, '分开装');
});

test('服务器接受这个备注，价钱不变', () => {
  const cfg = red({ note: NOTE_NO_TOMATO });
  assert.equal(parseLineConfig(menu, cfg).ok, true);
  assert.equal(unitPriceSen(menu, cfg), unitPriceSen(menu, red()));
});

test('两碗红酱，一碗不要番茄酱：购物车分开两行，不合并', () => {
  assert.notEqual(lineMergeKey(red({ note: NOTE_NO_TOMATO })), lineMergeKey(red()));
  let cart = addLine(menu, emptyCart('dine_in'), red(), 'a');
  cart = addLine(menu, cart, red({ note: NOTE_NO_TOMATO }), 'b');
  cart = addLine(menu, cart, red({ note: NOTE_NO_TOMATO }), 'c');
  assert.deepEqual(cart.lines.map((l) => l.quantity), [1, 2]);
});

test('图卡：强调显示，净面和不辣同时选也都在', () => {
  const ids = (c: LineConfig) => linePictograms(menu, c, 'dine_in').filter((p) => p.emphasized).map((p) => p.id);
  assert.ok(!ids(red()).includes('sauce:no_tomato'));
  const both = ids(red({ note: NOTE_NO_TOMATO, isKosong: true, spice: 'none' }));
  for (const id of ['sauce:no_tomato', 'kosong:on', 'spice:none'] as const) assert.ok(both.includes(id), id);
});

test('后厨：厨单带上这个要求，合计数出几份', () => {
  const ticket = {
    ...buildKitchenTicket(menu, {
      orderId: 'o', tokenNumber: 7, serviceMode: 'dine_in', kitchenRouting: 'digital', fulfillmentStatus: 'preparing', kitchenCancelRequested: false,
      acceptedAtEffectiveMs: 0, startedAtMs: 0, startedSource: 'auto', servedAtMs: null, timeQuality: 'server', businessDate: '2026-11-06', version: 1,
      lines: [
        { lineId: 'a', config: red({ note: NOTE_NO_TOMATO }), quantity: 2, serviceMode: 'dine_in' },
        { lineId: 'b', config: red(), quantity: 1, serviceMode: 'dine_in' },
      ],
    }),
  };
  assert.equal(ticket.lines[0].note, NOTE_NO_TOMATO);
  assert.ok(ticket.lines[0].pictograms.some((p) => p.id === 'sauce:no_tomato'));
  const { active } = summarizeKitchen([ticket]);
  assert.equal(active.noTomato, 2);
  assert.equal(active.sauce.red, 3, '不要番茄酱的还算在红酱里');
});

test('收据写在要求那一行', () => {
  const src: ReceiptSource = {
    storeName: '豪云吞面', receiptNumber: '261106-001', offlineReceiptNumber: null, tokenNumber: 7, serviceMode: 'dine_in', source: 'online', acceptedAtMs: 0,
    timeQuality: 'server', fulfillmentStatus: 'preparing', servedAtMs: null, paymentState: 'unpaid', paymentMethod: null, tenderedSen: null, changeSen: null, synced: true,
    lines: [{ config: red({ note: NOTE_NO_TOMATO }), quantity: 1, unitPriceSen: 700, serviceMode: 'dine_in' }], totalSen: 700,
  };
  const rows = buildReceipt(menu, src, { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' }).rows;
  assert.ok(rows.some((r) => r.left.includes('不要番茄酱')));
});
