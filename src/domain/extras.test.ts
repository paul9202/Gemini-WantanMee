/**
 * 下单后加料：配置校验、价钱与成本（和下单时点同样的加料一样）、份数、能不能加、给哪一碗的文字、
 * 厨单投影（旧后厨屏不崩）、报表与收据、餐牌（空闲再占 / 同桌挂上 / 不抢别人的牌）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOM_V1, unitCostUnits } from './bom';
import { Cart, computeTotals } from './cart';
import { extraBlockReason, extraConfig, extraNote } from './extras';
import { buildKitchenTicket, KitchenTicketSource, summarizeKitchen } from './kitchen';
import { csvOrders, dishRanking, orderServiceStats, OrderReportRow, productMix } from './ledger';
import { defaultConfig, LineConfig, lineNameEn, NOTE_NO_TOMATO, parseLineConfig, unitPriceSen } from './lineItem';
import { AddOnId, MENU_V1 as menu } from './menu';
import { linePictograms } from './pictograms';
import { buildReceipt } from './receipt';
import {
  canReholdToken, createTokenBoard, holdForExtra, holdToken, reholdToken, releaseHeldToken, TokenBoard, tokenForExtra, TokenResult,
} from './tokens';

const ADD_ONS: AddOnId[] = ['char_siew', 'wanton_3'];
const NOTE = '给 红酱面 · 中 · 细面 · 辣';
const red = (patch: Partial<LineConfig> = {}): LineConfig => ({ ...defaultConfig(menu, 'dry_noodle', 'red'), size: 'medium', ...patch });

// ---------- 配置校验 ----------

test('parseLineConfig：普通下单和离线一律不收加料行；只有明确允许才收', () => {
  assert.deepEqual(parseLineConfig(menu, extraConfig('char_siew')), { ok: false, issues: [{ code: 'UNKNOWN_PRODUCT', field: 'productKind' }] });
  assert.deepEqual(parseLineConfig(menu, extraConfig('char_siew'), { allowExtra: false }), { ok: false, issues: [{ code: 'UNKNOWN_PRODUCT', field: 'productKind' }] });
  for (const a of ADD_ONS) assert.deepEqual(parseLineConfig(menu, extraConfig(a), { allowExtra: true }), { ok: true, value: extraConfig(a) });
});

test('parseLineConfig：允许加料时也必须正好一个加料，且不能带面、酱、净面、别的规格', () => {
  const issues = (patch: Record<string, unknown>) => {
    const r = parseLineConfig(menu, { ...extraConfig('char_siew'), ...patch }, { allowExtra: true });
    return r.ok ? [] : r.issues.map((x) => x.code);
  };
  assert.deepEqual(issues({ addOns: [] }), ['INVALID_ADDON']);
  assert.deepEqual(issues({ addOns: ['char_siew', 'wanton_3'] }), ['INVALID_ADDON']);
  assert.ok(issues({ addOns: ['char_siew', 'char_siew'] }).includes('DUPLICATE_ADDON'));
  assert.deepEqual(issues({ addOns: ['sauce'] }), ['INVALID_ADDON']);
  assert.deepEqual(issues({ size: 'small' }), ['INVALID_SIZE']);
  assert.deepEqual(issues({ noodleType: 'thin_egg' }), ['INVALID_NOODLE_TYPE']);
  assert.deepEqual(issues({ sauce: 'red' }), ['INVALID_SAUCE']);
  assert.deepEqual(issues({ spice: 'normal' }), ['INVALID_MODIFIER']);
  assert.ok(issues({ isKosong: true }).includes('KOSONG_NOT_ALLOWED'));
});

test('parseLineConfig：加料行的备注同样受 80 字限制；售罄不影响加料', () => {
  const parse = (note: string) => parseLineConfig(menu, { ...extraConfig('wanton_3'), note }, { allowExtra: true });
  assert.equal(parse('字'.repeat(80)).ok, true);
  assert.deepEqual(parse('字'.repeat(81)), { ok: false, issues: [{ code: 'NOTE_TOO_LONG', field: 'note' }] });
  const soldOut = { ...menu, soldOut: ['dry_wanton' as const] };
  assert.equal(parseLineConfig(soldOut, extraConfig('wanton_3'), { allowExtra: true }).ok, true);
});

// ---------- 价钱、成本、份数 ----------

test('价钱和成本：一碗连加料点，和先点一碗再加一张小单，一分不差', () => {
  const bowls: LineConfig[] = [defaultConfig(menu, 'dry_noodle', 'black'), red(), defaultConfig(menu, 'soup_noodle')];
  for (const bowl of bowls) for (const a of ADD_ONS) {
    const together: LineConfig = { ...bowl, addOns: [a] };
    const extra = extraConfig(a);
    assert.equal(unitPriceSen(menu, together), unitPriceSen(menu, bowl) + unitPriceSen(menu, extra), `${bowl.productKind}/${a} 价钱`);
    assert.equal(unitCostUnits(menu, BOM_V1, together), unitCostUnits(menu, BOM_V1, bowl) + unitCostUnits(menu, BOM_V1, extra), `${bowl.productKind}/${a} 成本`);
  }
  // 云吞类只配云吞
  const wantons: LineConfig = defaultConfig(menu, 'wanton_soup');
  assert.equal(unitCostUnits(menu, BOM_V1, { ...wantons, addOns: ['wanton_3'] }), unitCostUnits(menu, BOM_V1, wantons) + unitCostUnits(menu, BOM_V1, extraConfig('wanton_3')));
  // 固定数值：RM2，叉烧 1 份 / 云吞 3 粒，不含底料
  assert.deepEqual(ADD_ONS.map((a) => unitPriceSen(menu, extraConfig(a))), [200, 200]);
  assert.deepEqual(ADD_ONS.map((a) => unitCostUnits(menu, BOM_V1, extraConfig(a))), [BOM_V1.charSiewPortion, 3 * BOM_V1.wanton]);
});

test('打包的一碗：连加料点和分开点，包装都只算一次，整单成本一样', () => {
  const bowl = red();
  const line = (lineId: string, config: LineConfig) => ({ lineId, config, quantity: 1, serviceMode: 'takeaway' as const });
  const a = computeTotals(menu, BOM_V1, { serviceMode: 'takeaway', lines: [line('l', { ...bowl, addOns: ['char_siew'] })] });
  const b = computeTotals(menu, BOM_V1, { serviceMode: 'takeaway', lines: [line('l', bowl)] });
  const c = computeTotals(menu, BOM_V1, { serviceMode: 'takeaway', lines: [line('x', extraConfig('char_siew'))] });
  assert.equal(a.totalSen, b.totalSen + c.totalSen);
  assert.equal(a.totalCostUnits, b.totalCostUnits + c.totalCostUnits);
});

test('computeTotals：加料不算份数、不算打包、不计包装；云吞数要算', () => {
  const cart: Cart = {
    serviceMode: 'takeaway',
    lines: [
      { lineId: 'b', config: defaultConfig(menu, 'dry_noodle', 'black'), quantity: 1, serviceMode: 'takeaway' },
      { lineId: 'w', config: extraConfig('wanton_3'), quantity: 2, serviceMode: 'takeaway' },
      { lineId: 'c', config: extraConfig('char_siew'), quantity: 1, serviceMode: 'takeaway' },
    ],
  };
  const t = computeTotals(menu, BOM_V1, cart);
  assert.deepEqual([t.portionCount, t.takeawayPortionCount, t.packagingCostUnits], [1, 1, BOM_V1.packagingPerPortion]);
  assert.deepEqual([t.totalSen, t.wantonCount, t.noodleHalfUnits], [700 + 400 + 200, 4 + 6, 2]);

  const only = computeTotals(menu, BOM_V1, { serviceMode: 'takeaway', lines: [{ lineId: 'w', config: extraConfig('wanton_3'), quantity: 1, serviceMode: 'takeaway' }] });
  assert.deepEqual([only.portionCount, only.takeawayPortionCount, only.packagingCostUnits], [0, 0, 0]);
  assert.deepEqual([only.totalSen, only.wantonCount, only.noodleHalfUnits, only.totalCostUnits], [200, 3, 0, 3 * BOM_V1.wanton]);
});

// ---------- 能不能加 ----------

test('extraBlockReason：净面不加肉；干捞云吞、云吞汤只加云吞；面类都能加；加料上不能再加料', () => {
  const matrix = (bowl: Pick<LineConfig, 'productKind' | 'isKosong'>) => ADD_ONS.map((a) => extraBlockReason(menu, bowl, a));
  assert.deepEqual(matrix({ productKind: 'dry_noodle', isKosong: false }), [null, null]);
  assert.deepEqual(matrix({ productKind: 'soup_noodle', isKosong: false }), [null, null]);
  assert.deepEqual(matrix({ productKind: 'dry_noodle', isKosong: true }), ['kosong', 'kosong']);
  assert.deepEqual(matrix({ productKind: 'soup_noodle', isKosong: true }), ['kosong', 'kosong']);
  assert.deepEqual(matrix({ productKind: 'dry_wanton', isKosong: false }), ['not_on_product', null]);
  assert.deepEqual(matrix({ productKind: 'wanton_soup', isKosong: false }), ['not_on_product', null]);
  assert.deepEqual(matrix({ productKind: 'extra', isKosong: false }), ['is_extra', 'is_extra']);
});

// ---------- 给哪一碗 ----------

test('extraNote：写明碗、面种、辣度、备注、打包，厨房一眼认得；不随界面语言变', () => {
  assert.equal(extraNote(menu, red()), NOTE);
  assert.equal(extraNote(menu, { ...defaultConfig(menu, 'dry_noodle', 'black'), size: 'large', noodleType: 'mee_poh', spice: 'none', serviceMode: 'takeaway' }), '给 黑酱面 · 大 · 面薄 · 不辣 · 打包');
  assert.equal(extraNote(menu, { ...red(), serviceMode: 'dine_in' }), NOTE, '堂食不写');
  assert.equal(extraNote(menu, { ...red(), note: NOTE_NO_TOMATO, serviceMode: 'takeaway' }), `${NOTE} · ${NOTE_NO_TOMATO} · 打包`);
  assert.equal(extraNote(menu, defaultConfig(menu, 'soup_noodle')), '给 云吞汤面 · 小 · 细面', '汤面没有辣度');
  assert.equal(extraNote(menu, defaultConfig(menu, 'wanton_soup')), '给 云吞汤 · 10粒');
  assert.equal(extraNote(menu, defaultConfig(menu, 'dry_wanton')), '给 干捞云吞 · 10粒 · 辣');
});

test('extraNote：最多 80 字，写进订单也能过配置校验', () => {
  const note = extraNote(menu, { ...red(), note: '字'.repeat(80), serviceMode: 'takeaway' });
  assert.equal(note.length, 80);
  assert.ok(note.startsWith(NOTE));
  assert.equal(parseLineConfig(menu, { ...extraConfig('char_siew'), note }, { allowExtra: true }).ok, true);
});

// ---------- 厨单 ----------

const ticketSrc = (orderId: string, lines: KitchenTicketSource['lines']): KitchenTicketSource => ({
  orderId, tokenNumber: 5, serviceMode: 'dine_in', kitchenRouting: 'digital', fulfillmentStatus: 'preparing', kitchenCancelRequested: false,
  acceptedAtEffectiveMs: 1000, startedAtMs: 1000, startedSource: 'auto', servedAtMs: null, timeQuality: 'server', businessDate: '2026-11-06', version: 1, lines,
});

test('buildKitchenTicket：加料行写成不带酱的干捞云吞（旧后厨屏不崩），名字、照片、云吞数和备注都保留', () => {
  const t = buildKitchenTicket(menu, ticketSrc('x', [
    { lineId: 'w', config: { ...extraConfig('wanton_3'), note: NOTE }, quantity: 2, serviceMode: 'takeaway' },
    { lineId: 'c', config: { ...extraConfig('char_siew'), note: NOTE }, quantity: 1, serviceMode: 'takeaway' },
  ]));
  const [w, c] = t.lines;
  assert.deepEqual(
    [w.productKind, w.sauce, w.noodleType, w.size, w.nameZh, w.photoId, w.wantonCount, w.noodleHalfUnits, w.note, w.quantity, w.addOns],
    ['dry_wanton', null, null, 'one', '加云吞3粒', 'dish.dry_wanton', 3, 0, NOTE, 2, ['wanton_3']],
  );
  assert.deepEqual(
    [c.productKind, c.sauce, c.nameZh, c.photoId, c.wantonCount, c.note, c.addOns],
    ['dry_wanton', null, '加叉烧', 'ingredient.char_siew', 0, NOTE, ['char_siew']],
  );
  assert.equal(t.serviceMode, 'takeaway');
  assert.ok(w.pictograms.some((p) => p.id === 'addon:wanton_3' && p.emphasized));
  assert.ok(!w.pictograms.some((p) => p.id === 'takeaway:no_side_soup'), '存下来的图卡不写不附送清汤');
  assert.ok(!/Sen"|cost|price/i.test(JSON.stringify(t)), '厨单不带金额和成本');
});

test('厨单投影行：后厨屏把它当 LineConfig 重算图卡和英文名，不能抛错', () => {
  const t = buildKitchenTicket(menu, ticketSrc('x', ADD_ONS.map((a) => ({ lineId: a, config: extraConfig(a), quantity: 1, serviceMode: 'takeaway' as const }))));
  for (const l of t.lines) {
    const cfg = l as unknown as LineConfig;
    assert.doesNotThrow(() => lineNameEn(menu, cfg));
    for (const mode of ['dine_in', 'takeaway'] as const) {
      const ids = linePictograms(menu, cfg, mode).map((p) => p.id);
      assert.ok(ids.includes(`addon:${cfg.addOns[0]}`), ids.join());
    }
  }
});

test('summarizeKitchen：云吞合计算上加料；酱料合计不受影响', () => {
  const bowl = buildKitchenTicket(menu, ticketSrc('b', [{ lineId: 'b', config: defaultConfig(menu, 'dry_wanton', 'black'), quantity: 1, serviceMode: 'dine_in' }]));
  const extra = buildKitchenTicket(menu, ticketSrc('x', [{ lineId: 'w', config: extraConfig('wanton_3'), quantity: 2, serviceMode: 'dine_in' }]));
  const { active } = summarizeKitchen([bowl, extra]);
  assert.equal(active.wantons, 10 + 6);
  assert.deepEqual(active.sauce, { black: 1, white: 0, red: 0 });
  assert.deepEqual(active.dryWantonBySauce, { black: 1, white: 0, red: 0 });
  assert.equal(active.noodleHalfUnits, 0);
});

// ---------- 报表与收据 ----------

const bowlItem = { productKind: 'dry_noodle', sauce: 'black', noodleType: 'thin_egg', isKosong: false, quantity: 2, nameZh: '黑酱面 · 中' };
const extraItem = { productKind: 'extra', sauce: null, noodleType: null, isKosong: false, quantity: 1, nameZh: '加叉烧', note: NOTE };
const row = (patch: Partial<OrderReportRow>): OrderReportRow => ({
  id: 'o', receiptNumber: '261106-001', businessDate: '2026-11-06', tokenNumber: 5, serviceMode: 'dine_in', source: 'online', fulfillmentStatus: 'served',
  paymentState: 'paid', paymentMethod: 'unspecified', totalSen: 200, acceptedAtEffectiveMs: 0, servedAtMs: 300_000, timeQuality: 'server', items: [bowlItem], ...patch,
});

test('productMix / dishRanking：加料不算份数，也不进餐品结构和排行', () => {
  const orders = [row({ id: 'a', items: [bowlItem, extraItem] }), row({ id: 'x', items: [extraItem] })];
  const m = productMix(orders);
  assert.equal(m.portionsServed, 2);
  assert.deepEqual(m.byProduct.map((x) => [x.key, x.portions]), [['dry_noodle', 2]]);
  assert.deepEqual(m.bySauce.map((x) => [x.key, x.portions]), [['black', 2]]);
  assert.deepEqual(m.byNoodle.map((x) => [x.key, x.portions]), [['thin_egg', 2]]);
  assert.deepEqual(dishRanking(orders).map((x) => [x.key, x.portions]), [['black_noodle', 2]]);
});

test('orderServiceStats：只有加料的小单不算出餐速度；一张单里有面就照算', () => {
  const s = orderServiceStats([
    row({ id: 'a' }),
    row({ id: 'mixed', items: [bowlItem, extraItem] }),
    row({ id: 'x', items: [extraItem], servedAtMs: 5_000 }),
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.minMs, 300_000, '小单 5 秒出餐不进样本');
});

test('csvOrders：明细写出加料和给哪一碗', () => {
  const csv = csvOrders([row({ items: [extraItem] })], 'Asia/Kuala_Lumpur');
  assert.ok(csv.includes(`1×加叉烧（${NOTE}）`), csv);
});

test('buildReceipt：印加叉烧和给哪一碗，不印不附送清汤（打包也一样）', () => {
  const d = buildReceipt(menu, {
    storeName: '豪云吞面', receiptNumber: '261106-002', offlineReceiptNumber: null, tokenNumber: 5, serviceMode: 'takeaway', source: 'online',
    acceptedAtMs: Date.UTC(2026, 10, 6, 4, 30), timeQuality: 'server', fulfillmentStatus: 'preparing', servedAtMs: null, paymentState: 'unpaid',
    lines: [{ config: { ...extraConfig('char_siew'), note: NOTE }, quantity: 1, unitPriceSen: 200, serviceMode: 'takeaway' }],
    totalSen: 200, paymentMethod: null, tenderedSen: null, changeSen: null, synced: true,
  }, { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' });
  const text = d.rows.map((r) => `${r.left}|${r.right ?? ''}`).join('\n');
  assert.ok(text.includes('1 × 加叉烧|RM2.00'), text);
  assert.ok(text.includes(NOTE), text);
  assert.ok(!text.includes('不附送清汤'), text);
});

// ---------- 餐牌 ----------

function ok(r: TokenResult | null) {
  if (!r?.ok) throw new Error(`餐牌操作失败：${JSON.stringify(r)}`);
  return r;
}
const hold = (b: TokenBoard, n: number, id: string) => ok(holdToken(b, n, id)).board;
const release = (b: TokenBoard, n: number, id: string) => ok(releaseHeldToken(b, n, id)).board;
/** 这碗在 n 号上出餐了，牌空闲。 */
const servedOn = (n: number, id = 'bowl') => release(hold(createTokenBoard(), n, id), n, id);
const shape = (r: { token: TokenBoard[number] }) => [r.token.state, r.token.orderId, r.token.orderIds, r.token.sessionOrderIds];

test('holdForExtra：牌空闲、这一轮就是这碗——重新占上，这碗留在这一轮', () => {
  const r = ok(holdForExtra(servedOn(5), 5, 'x1', 'bowl'));
  assert.deepEqual(shape(r), ['held', 'x1', ['x1'], ['bowl', 'x1']]);
  assert.equal(r.token.lastReleasedOrderId, null);
});

test('holdForExtra：牌空闲、中间别的客人用过——开新一轮 [那碗, 加料]，不留上一位客人', () => {
  const b = release(hold(servedOn(5), 5, 'other'), 5, 'other');
  const r = ok(holdForExtra(b, 5, 'x1', 'bowl'));
  assert.deepEqual(shape(r), ['held', 'x1', ['x1'], ['bowl', 'x1']]);
  assert.equal(canReholdToken(r.token, 'other'), false);
});

test('holdForExtra：换了一张从没用过的牌也一样', () => {
  const r = ok(holdForExtra(servedOn(5), 9, 'x1', 'bowl'));
  assert.deepEqual(shape(r), ['held', 'x1', ['x1'], ['bowl', 'x1']]);
});

test('holdForExtra：牌还被这桌占着就挂上；重复调用不重复挂', () => {
  const r = ok(holdForExtra(hold(createTokenBoard(), 5, 'bowl'), 5, 'x1', 'bowl'));
  assert.deepEqual(shape(r), ['held', 'bowl', ['bowl', 'x1'], ['bowl', 'x1']]);
  const again = ok(holdForExtra(r.board, 5, 'x1', 'bowl'));
  assert.deepEqual(shape(again), shape(r));
  assert.equal(again.token.version, r.token.version);
});

test('holdForExtra：牌给了别的客人——TOKEN_OCCUPIED，绝不挂上去；号码越界和旧版待回收同样拒绝', () => {
  const taken = hold(servedOn(5), 5, 'other');
  const r = holdForExtra(taken, 5, 'x1', 'bowl');
  assert.deepEqual([r.ok, !r.ok && r.error], [false, 'TOKEN_OCCUPIED']);
  const out = holdForExtra(taken, 51, 'x1', 'bowl');
  assert.deepEqual([out.ok, !out.ok && out.error], [false, 'TOKEN_OUT_OF_RANGE']);
  const legacy: TokenBoard = { ...taken, 7: { number: 7, state: 'awaiting_return', orderId: 'bowl', version: 1 } };
  const old = holdForExtra(legacy, 7, 'x1', 'bowl');
  assert.deepEqual([old.ok, !old.ok && old.error], [false, 'TOKEN_OCCUPIED']);
});

test('holdForExtra：第二份加料挂在同一张牌上', () => {
  const first = ok(holdForExtra(servedOn(5), 5, 'x1', 'bowl'));
  const second = ok(holdForExtra(first.board, 5, 'x2', 'bowl'));
  assert.deepEqual(shape(second), ['held', 'x1', ['x1', 'x2'], ['bowl', 'x1', 'x2']]);
});

test('重新占牌后，撤回那碗出餐还认这张牌；加料也出餐、牌空闲后同样认', () => {
  const r = ok(holdForExtra(servedOn(5), 5, 'x1', 'bowl'));
  assert.equal(canReholdToken(r.token, 'bowl'), true);
  const back = ok(reholdToken(r.board, 5, 'bowl'));
  assert.deepEqual(shape(back), ['held', 'x1', ['x1', 'bowl'], ['bowl', 'x1']]);
  const freed = ok(releaseHeldToken(r.board, 5, 'x1'));
  assert.equal(freed.token.state, 'available');
  assert.equal(canReholdToken(freed.token, 'bowl'), true);
});

test('tokenForExtra：这桌还拿着牌 → 那张；原来的号空闲 → 原来的号；给了别人 → 下一个空闲；全满 → null', () => {
  const held = hold(createTokenBoard(), 5, 'bowl');
  assert.equal(tokenForExtra(held, { id: 'bowl', tokenNumber: 5 }, 30), 5, '那碗还在做');

  // 那碗出餐后加过料：这桌现在拿的是别的号，原来的号空着也用这桌手上的
  const moved = ok(holdForExtra(servedOn(5), 9, 'x1', 'bowl')).board;
  assert.equal(tokenForExtra(moved, { id: 'bowl', tokenNumber: 5 }, 30), 9);

  assert.equal(tokenForExtra(servedOn(5), { id: 'bowl', tokenNumber: 5 }, 30), 5, '空闲：把原来的号再给客人');

  const taken = hold(servedOn(5), 5, 'other');
  assert.equal(tokenForExtra(taken, { id: 'bowl', tokenNumber: 5 }, 30), 31, '接着上一张发的号');
  assert.equal(tokenForExtra(taken, { id: 'bowl', tokenNumber: 5 }, null), 1);

  let full = createTokenBoard();
  for (let n = 1; n <= 50; n++) full = hold(full, n, `o${n}`);
  assert.equal(tokenForExtra(full, { id: 'bowl', tokenNumber: 5 }, 30), null);
});
