/**
 * 「不要叉烧」：和「不要番茄酱」一样用备注的固定值表示，云吞照放、价钱不变，只有干捞面和汤面能选。
 * 一碗可以同时有几个固定要求，用「、」按固定顺序连起来。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1, unitCostUnits } from './bom';
import { addLine, emptyCart } from './cart';
import { extraNote } from './extras';
import { buildKitchenTicket, summarizeKitchen } from './kitchen';
import {
  allowsNoCharSiew, defaultConfig, hasNoCharSiew, hasNoTomato, LineConfig, lineMergeKey, linePortions, normalizeConfig,
  NOTE_NO_CHAR_SIEW, NOTE_NO_TOMATO, noteFreeText, noteTokens, parseLineConfig, unitPriceSen, withNoteToken,
} from './lineItem';
import { MENU_V1 as menu } from './menu';
import { linePictograms, notePictogramIds } from './pictograms';
import { buildReceipt, ReceiptSource } from './receipt';

const red = (patch: Partial<LineConfig> = {}): LineConfig => ({ ...defaultConfig(menu, 'dry_noodle', 'red'), ...patch });
const BOTH = `${NOTE_NO_TOMATO}、${NOTE_NO_CHAR_SIEW}`;

test('固定值不能改字：旧订单靠它识别', () => {
  assert.equal(NOTE_NO_CHAR_SIEW, '不要叉烧');
  assert.equal(BOTH, '不要番茄酱、不要叉烧');
});

test('备注拆成固定要求：整句都是固定要求才算；加料的「给 …」和手写备注不算', () => {
  assert.deepEqual(noteTokens(''), []);
  assert.deepEqual(noteTokens(NOTE_NO_TOMATO), [NOTE_NO_TOMATO], '旧订单的单个「不要番茄酱」照样认得');
  assert.deepEqual(noteTokens(BOTH), [NOTE_NO_TOMATO, NOTE_NO_CHAR_SIEW]);
  assert.deepEqual(noteTokens(`${NOTE_NO_CHAR_SIEW}、${NOTE_NO_TOMATO}`), [NOTE_NO_TOMATO, NOTE_NO_CHAR_SIEW]);
  assert.deepEqual(noteTokens('给 红酱面 · 中 · 细面 · 辣 · 不要叉烧'), []);
  assert.deepEqual(noteTokens('不要叉烧、少面'), []);
  assert.equal(noteFreeText(BOTH), '');
  assert.equal(noteFreeText('给 红酱面 · 中'), '给 红酱面 · 中');
  assert.equal(hasNoTomato({ note: BOTH }), true, '两个都选时，不要番茄酱也要认得');
  assert.equal(hasNoCharSiew({ note: BOTH }), true);
  assert.equal(hasNoCharSiew({ note: '给 红酱面 · 不要叉烧' }), false);
});

test('打开 / 关闭一个要求不动另一个，按固定顺序写', () => {
  assert.equal(withNoteToken('', NOTE_NO_CHAR_SIEW, true), NOTE_NO_CHAR_SIEW);
  assert.equal(withNoteToken(NOTE_NO_CHAR_SIEW, NOTE_NO_TOMATO, true), BOTH);
  assert.equal(withNoteToken(BOTH, NOTE_NO_TOMATO, false), NOTE_NO_CHAR_SIEW);
  assert.equal(withNoteToken(BOTH, NOTE_NO_CHAR_SIEW, false), NOTE_NO_TOMATO);
  assert.equal(withNoteToken(NOTE_NO_TOMATO, NOTE_NO_TOMATO, true), NOTE_NO_TOMATO);
});

test('只有干捞面、汤面（不是净面）能选', () => {
  assert.equal(allowsNoCharSiew(menu, red()), true);
  assert.equal(allowsNoCharSiew(menu, defaultConfig(menu, 'soup_noodle')), true);
  for (const size of ['small', 'medium', 'large'] as const) assert.equal(allowsNoCharSiew(menu, red({ size })), true, size);
  assert.equal(allowsNoCharSiew(menu, red({ isKosong: true })), false);
  assert.equal(allowsNoCharSiew(menu, defaultConfig(menu, 'dry_wanton')), false);
  assert.equal(allowsNoCharSiew(menu, defaultConfig(menu, 'wanton_soup')), false);
});

test('规范化：换成净面 / 云吞类时清除；换酱只清不要番茄酱；顺序统一', () => {
  const both = normalizeConfig(menu, red({ note: `${NOTE_NO_CHAR_SIEW}、${NOTE_NO_TOMATO}` }));
  assert.equal(both.note, BOTH, '顺序统一');
  assert.equal(normalizeConfig(menu, { ...both, sauce: 'black' }).note, NOTE_NO_CHAR_SIEW, '黑酱没有番茄酱，不要叉烧留着');
  assert.equal(normalizeConfig(menu, { ...both, isKosong: true }).note, NOTE_NO_TOMATO, '净面本来就没叉烧');
  assert.equal(normalizeConfig(menu, { ...both, productKind: 'dry_wanton', sauce: 'red' }).note, NOTE_NO_TOMATO);
  assert.equal(normalizeConfig(menu, { ...both, productKind: 'wanton_soup' }).note, '');
  assert.equal(normalizeConfig(menu, { ...both, productKind: 'soup_noodle' }).note, NOTE_NO_CHAR_SIEW);
  assert.equal(normalizeConfig(menu, red({ note: '给 红酱面 · 不要叉烧' })).note, '给 红酱面 · 不要叉烧', '其他备注原样保留');
});

test('和「加叉烧」二选一：两个都有时以加叉烧为准', () => {
  const cfg = normalizeConfig(menu, red({ note: BOTH, addOns: ['char_siew'] }));
  assert.equal(cfg.note, NOTE_NO_TOMATO);
  assert.deepEqual(cfg.addOns, ['char_siew']);
  assert.equal(normalizeConfig(menu, red({ note: NOTE_NO_CHAR_SIEW, addOns: ['wanton_3'] })).note, NOTE_NO_CHAR_SIEW, '加云吞可以');
});

test('价钱不变；服务器接受；云吞照放、叉烧 0、成本少一份叉烧', () => {
  for (const base of [red({ size: 'medium' }), defaultConfig(menu, 'soup_noodle')]) {
    const cfg = { ...base, note: NOTE_NO_CHAR_SIEW };
    assert.equal(parseLineConfig(menu, cfg).ok, true);
    assert.equal(unitPriceSen(menu, cfg), unitPriceSen(menu, base));
    const p = linePortions(menu, cfg);
    assert.deepEqual([p.charSiewPortions, p.wantonCount, p.noodleHalfUnits], [0, linePortions(menu, base).wantonCount, linePortions(menu, base).noodleHalfUnits]);
    assert.equal(unitCostUnits(menu, BOM_V1, base) - unitCostUnits(menu, BOM_V1, cfg), BOM_V1.charSiewPortion);
  }
  assert.equal(parseLineConfig(menu, red({ note: BOTH })).ok, true, '两个要求一起也在 80 字内');
});

test('购物车：同一碗不管先按哪个都合并，和普通的分开', () => {
  const a = normalizeConfig(menu, red({ note: withNoteToken(withNoteToken('', NOTE_NO_CHAR_SIEW, true), NOTE_NO_TOMATO, true) }));
  const b = normalizeConfig(menu, red({ note: withNoteToken(withNoteToken('', NOTE_NO_TOMATO, true), NOTE_NO_CHAR_SIEW, true) }));
  assert.equal(lineMergeKey(a), lineMergeKey(b));
  assert.notEqual(lineMergeKey(red({ note: NOTE_NO_CHAR_SIEW })), lineMergeKey(red()));
  let cart = addLine(menu, emptyCart('dine_in'), a, 'x');
  cart = addLine(menu, cart, b, 'y');
  cart = addLine(menu, cart, red(), 'z');
  assert.deepEqual(cart.lines.map((l) => l.quantity), [2, 1]);
});

test('图卡：强调显示，列出要求按固定顺序', () => {
  const ids = linePictograms(menu, red({ note: BOTH }), 'dine_in').filter((p) => p.emphasized).map((p) => p.id);
  assert.ok(ids.includes('sauce:no_tomato') && ids.includes('charsiew:none'));
  assert.deepEqual(notePictogramIds({ note: BOTH }), ['sauce:no_tomato', 'charsiew:none']);
  assert.deepEqual(notePictogramIds({ note: '给 红酱面 · 不要叉烧' }), []);
});

test('后厨：合计数出不要叉烧几份，不要番茄酱也照算；加料小单不算', () => {
  const ticket = buildKitchenTicket(menu, {
    orderId: 'o', tokenNumber: 7, serviceMode: 'dine_in', kitchenRouting: 'digital', fulfillmentStatus: 'preparing', kitchenCancelRequested: false,
    acceptedAtEffectiveMs: 0, startedAtMs: 0, startedSource: 'auto', servedAtMs: null, timeQuality: 'server', businessDate: '2026-11-12', version: 1,
    lines: [
      { lineId: 'a', config: red({ note: BOTH }), quantity: 1, serviceMode: 'dine_in' },
      { lineId: 'b', config: { ...defaultConfig(menu, 'soup_noodle'), note: NOTE_NO_CHAR_SIEW }, quantity: 2, serviceMode: 'dine_in' },
      { lineId: 'c', config: { productKind: 'extra', size: 'one', noodleType: null, sauce: null, spice: null, lard: null, scallion: 'normal', isKosong: false, addOns: ['wanton_3'], note: '给 红酱面 · 小 · 细面 · 辣 · 不要番茄酱、不要叉烧' }, quantity: 1, serviceMode: 'dine_in' },
    ],
  });
  assert.ok(ticket.lines[0].pictograms.some((p) => p.id === 'charsiew:none'));
  const { active } = summarizeKitchen([ticket]);
  assert.equal(active.noCharSiew, 3);
  assert.equal(active.noTomato, 1);
});

test('下单后加叉烧：给后厨的那句话里不再写「不要叉烧」；加云吞照写', () => {
  const bowl = { ...red({ note: BOTH }), serviceMode: 'dine_in' as const };
  assert.equal(extraNote(menu, bowl, 'char_siew'), '给 红酱面 · 小 · 细面 · 辣 · 不要番茄酱');
  assert.equal(extraNote(menu, { ...red({ note: NOTE_NO_CHAR_SIEW }), serviceMode: 'dine_in' }, 'char_siew'), '给 红酱面 · 小 · 细面 · 辣');
  assert.equal(extraNote(menu, bowl, 'wanton_3'), '给 红酱面 · 小 · 细面 · 辣 · 不要番茄酱、不要叉烧');
});

test('收据写在要求那一行', () => {
  const src: ReceiptSource = {
    storeName: '豪云吞面', receiptNumber: '261112-001', offlineReceiptNumber: null, tokenNumber: 7, serviceMode: 'dine_in', source: 'online', acceptedAtMs: 0,
    timeQuality: 'server', fulfillmentStatus: 'preparing', servedAtMs: null, paymentState: 'unpaid', paymentMethod: null, tenderedSen: null, changeSen: null, synced: true,
    lines: [{ config: red({ note: BOTH }), quantity: 1, unitPriceSen: 700, serviceMode: 'dine_in' }], totalSen: 700,
  };
  const rows = buildReceipt(menu, src, { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' }).rows;
  assert.ok(rows.some((r) => r.left.includes('不要番茄酱 · 不要叉烧')));
});
