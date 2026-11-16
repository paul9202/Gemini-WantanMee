/**
 * 送餐单 buildRunnerSlip：只写订单信息和金额，不写付款状态；面种、要求和收据同一个写法；
 * 同牌加单、吃完再加、加料、断网单、补打各有标记。以及什么时候自动打。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, MENU_V1, normalizeConfig, NOTE_NO_TOMATO, unitPriceSen } from './index';
import type { LineConfig, ServiceMode } from './index';
import { extraConfig, extraNote } from './extras';
import { amendSlipKey, amendSlipSource, autoPrintsSlip, buildRunnerSlip, manualSlip, printsAmendSlip, resumesOnReconnect, RunnerSlip, RunnerSlipSource, SLIP_RESUME_WINDOW_MS, slipAmount, slipKey, slipMark, slipTotal } from './runnerSlip';
import type { AmendedOrderView, AmendedTicketView, OrderSlipView } from './runnerSlip';

const menu = MENU_V1;
const TZ = 'Asia/Kuala_Lumpur';
const OPTS = { timeZone: TZ, printIndex: 0 };
const cfg = (patch: Partial<LineConfig> & Pick<LineConfig, 'productKind'>, sauce: LineConfig['sauce'] = null) =>
  normalizeConfig(menu, { ...defaultConfig(menu, patch.productKind, sauce), ...patch });
const line = (config: LineConfig, quantity = 1, serviceMode?: ServiceMode) => ({ config, quantity, unitPriceSen: unitPriceSen(menu, config), ...(serviceMode ? { serviceMode } : {}) });

const blackMeePoh = cfg({ productKind: 'dry_noodle', size: 'medium', noodleType: 'mee_poh', spice: 'less', scallion: 'none', addOns: ['char_siew'] }, 'black');
const soupSmall = cfg({ productKind: 'soup_noodle' });

const source = (patch: Partial<RunnerSlipSource> = {}): RunnerSlipSource => {
  const lines = patch.lines ?? [line(blackMeePoh), line(soupSmall)];
  return {
    tokenNumber: 12, serviceMode: 'dine_in', acceptedAtMs: Date.UTC(2026, 10, 12, 6, 32), receiptNumber: '261112-037', offlineReceiptNumber: null,
    source: 'online', totalSen: lines.reduce((s, l) => s + l.unitPriceSen * l.quantity, 0), ...patch, lines,
  };
};
const text = (s: RunnerSlip) => JSON.stringify(s);
const details = (s: RunnerSlip, i: number) => s.lines[i].detail.map((d) => d.text);

test('堂食：牌号、时间、品名、面种在前、要求、每行金额、合计、票号、份数', () => {
  const s = buildRunnerSlip(menu, source(), OPTS);
  assert.deepEqual(s.header, { label: '堂食 DINE IN', inverse: false });
  assert.equal(s.time, '14:32', '按门店时区写接单时间');
  assert.equal(s.token, 12);
  assert.equal(s.lines[0].name, '黑酱面 · 中');
  assert.deepEqual(s.lines[0].detail[0], { text: '面薄' }, '面薄写在最前面，和细面一样普通字（不再黑底）');
  assert.deepEqual(details(s, 0), ['面薄', '少辣', '走青', '加叉烧']);
  assert.equal(s.lines[0].amountSen, 1100, '中碗 9.00 + 加叉烧 2.00');
  assert.deepEqual(details(s, 1), ['细面'], '细面照写，不强调');
  assert.equal(s.totalSen, 1800);
  assert.equal(s.ref, '#261112-037');
  assert.equal(s.count, 2);
  assert.equal(s.flag, null);
  assert.equal(s.mark, null);
});

test('不写付款状态、付款方式和成本', () => {
  const s = text(buildRunnerSlip(menu, source(), OPTS));
  assert.ok(!/要收|已付|不用收|未收款|已收款|现金|QR|成本|利润/.test(s), s);
});

test('打包：整条黑底；干捞写「不附送清汤」；干捞云吞补上酱料；不要番茄酱照写', () => {
  const red = cfg({ productKind: 'dry_noodle', note: NOTE_NO_TOMATO }, 'red');
  const wanton = cfg({ productKind: 'dry_wanton' }, 'black');
  const s = buildRunnerSlip(menu, source({ tokenNumber: 9, serviceMode: 'takeaway', lines: [line(red, 2), line(wanton)] }), OPTS);
  assert.deepEqual(s.header, { label: '打包 TAKEAWAY', inverse: true });
  assert.deepEqual(details(s, 0), ['细面', '不要番茄酱', '辣', '不附送清汤']);
  assert.equal(s.lines[0].amountSen, 1400, '数量 2');
  assert.equal(s.lines[1].name, '干捞云吞 · 10粒');
  assert.deepEqual(details(s, 1), ['黑酱', '辣', '不附送清汤'], '收据没写酱料，送餐单要写');
  assert.equal(s.count, 3);
  assert.deepEqual(s.lines[0].tags, [], '整单打包时行上不再重复标打包');
});

test('堂食 + 打包：表头写两种，打包那一行前面加黑底「打包」', () => {
  const white = cfg({ productKind: 'dry_noodle', size: 'large', lard: 'extra' }, 'white');
  const soup = cfg({ productKind: 'wanton_soup', size: 'w15' });
  const s = buildRunnerSlip(menu, source({ tokenNumber: 21, lines: [line(white, 1, 'dine_in'), line(soup, 1, 'takeaway')] }), OPTS);
  assert.deepEqual(s.header, { label: '堂食 + 打包', inverse: false });
  assert.deepEqual(s.lines[0].tags, []);
  assert.deepEqual(details(s, 0), ['细面', '辣', '多油渣']);
  assert.deepEqual(s.lines[1].tags, [{ text: '打包' }]);
  assert.equal(s.lines[1].name, '云吞汤 · 15粒');
  assert.deepEqual(details(s, 1), [], '汤类打包没有「不附送清汤」');
});

test('净面：品名去掉「净面 · 」，改用框标出；价钱按净面价', () => {
  const kosong = cfg({ productKind: 'dry_noodle', isKosong: true }, 'black');
  const s = buildRunnerSlip(menu, source({ lines: [line(kosong)] }), OPTS);
  assert.equal(s.lines[0].name, '黑酱面 · 小');
  assert.deepEqual(s.lines[0].tags, [{ text: '净面', outline: true }]);
  assert.deepEqual(details(s, 0), ['细面', '辣']);
  assert.equal(s.lines[0].amountSen, 350);
});

test('同牌加单、吃完再加：牌号下面一句说明；同牌加单优先', () => {
  assert.equal(buildRunnerSlip(menu, source({ sharedToken: true }), OPTS).flag, '同牌加单 · 和前面的 12 号一起送');
  assert.equal(buildRunnerSlip(menu, source({ tokenNumber: 30, addOnToToken: 12 }), OPTS).flag, '加单 · 原 12 号的客人');
  assert.equal(buildRunnerSlip(menu, source({ sharedToken: true, addOnToToken: 12 }), OPTS).flag, '同牌加单 · 和前面的 12 号一起送');
});

test('加料：表头写加料，品名是加的料，小字是「给 …」那一碗，送法看后厨屏', () => {
  const note = extraNote(menu, blackMeePoh);
  const extra = { ...extraConfig('char_siew'), note };
  const s = buildRunnerSlip(menu, source({ extraOnly: true, receiptNumber: '261112-042', lines: [{ config: extra, quantity: 1, unitPriceSen: 200 }] }), OPTS);
  assert.deepEqual(s.header, { label: '加料 EXTRA', inverse: false });
  assert.equal(s.flag, '放进碗里还是小碟送 · 看后厨屏');
  assert.equal(s.lines[0].name, '加叉烧');
  assert.deepEqual(details(s, 0), [note]);
  assert.ok(note.startsWith('给 '), note);
  assert.equal(s.totalSen, 200);
});

test('断网单：整条黑底写明后厨屏上没有，写临时号', () => {
  const s = buildRunnerSlip(menu, source({ source: 'offline', receiptNumber: null, offlineReceiptNumber: 'O-F01-0042', tokenNumber: 8 }), OPTS);
  assert.deepEqual(s.header, { label: '断网单 · 后厨屏上没有', inverse: true });
  assert.equal(s.ref, '临时号 O-F01-0042');
});

test('补打写次数；核对后才确认接单的第一次写「核对后补打」，之后再打写补打次数', () => {
  assert.equal(buildRunnerSlip(menu, source(), { ...OPTS, printIndex: 1 }).mark, '补打 2');
  assert.equal(buildRunnerSlip(menu, source(), { ...OPTS, reconciled: true }).mark, '核对后补打');
  assert.equal(buildRunnerSlip(menu, source(), { ...OPTS, printIndex: 2, reconciled: true }).mark, '补打 3');
});

test('金额格式：每行不带 RM，合计带 RM 和空格', () => {
  assert.equal(slipAmount(1100), '11.00');
  assert.equal(slipAmount(350), '3.50');
  assert.equal(slipTotal(1800), 'RM 18.00');
});

test('什么时候自动打：接单、加料、断网接单、核对后确认才打；结果不明、被拒、补同步、出餐、取消、页面重开都不打', () => {
  for (const t of ['accepted', 'extra_accepted', 'local_accepted', 'reconciled'] as const) assert.equal(autoPrintsSlip(t), true, t);
  for (const t of ['unknown', 'rejected', 'not_found', 'synced', 'served', 'cancelled', 'reload'] as const) assert.equal(autoPrintsSlip(t), false, t);
});

test('打印机断开后连上：10 分钟内的单自动补打，更早的留给收银决定', () => {
  const now = 1_000_000_000;
  assert.equal(resumesOnReconnect({ createdAtMs: now - SLIP_RESUME_WINDOW_MS }, now), true);
  assert.equal(resumesOnReconnect({ createdAtMs: now - SLIP_RESUME_WINDOW_MS - 1 }, now), false);
});

test('打印记录的键：云端单用订单 ID，断网单用本机 ID', () => {
  assert.equal(slipKey({ orderId: 'abc' }), 'order:abc');
  assert.equal(slipKey({ clientOrderId: 'xyz' }), 'local:xyz');
  assert.throws(() => slipKey({}));
});

// ---- 后厨改单后补打 ----

const amendedOrder = (patch: Partial<AmendedOrderView> = {}): AmendedOrderView => ({
  tokenNumber: 12, serviceMode: 'dine_in', receiptNumber: '261116-007', offlineReceiptNumber: null, totalSen: 1600,
  items: [
    { lineId: 'a', ...blackMeePoh, quantity: 1, unitPriceSen: 900, serviceMode: 'dine_in' },
    { lineId: 'b', ...soupSmall, quantity: 1, unitPriceSen: 700, serviceMode: 'dine_in' },
  ],
  ...patch,
});
const amendedTicket = (patch: Partial<AmendedTicketView> = {}): AmendedTicketView => ({
  amendCount: 1, amendedAtMs: Date.UTC(2026, 10, 16, 6, 40), amendSummary: '黑酱面 · 中 不加叉烧；加 云吞汤面 · 小', amendMarks: { a: 'mod', b: 'add' }, ...patch,
});

test('改单补打：最上面「改单 · 以这张为准」，牌号下面写改了什么，改过的框「改」、新加的框「加」，时间写改单时间', () => {
  const s = buildRunnerSlip(menu, amendSlipSource(amendedOrder(), amendedTicket()), OPTS);
  assert.equal(s.mark, '改单 · 以这张为准');
  assert.equal(s.amendNo, 1);
  assert.equal(s.amendNote, '改了：黑酱面 · 中 不加叉烧；加 云吞汤面 · 小');
  assert.deepEqual(s.lines[0].tags, [{ text: '改', outline: true }]);
  assert.deepEqual(s.lines[1].tags, [{ text: '加', outline: true }]);
  assert.equal(s.time, '14:40');
  assert.equal(s.ref, '#261116-007');
  assert.equal(s.totalSen, 1600);
  assert.equal(s.lines[0].amountSen, 900, '用订单上的成交单价');
});

test('改单补打：第二次写「改单 2」；撤回写「撤回改单」；再补打写「改单 · 补打 N」', () => {
  assert.equal(buildRunnerSlip(menu, amendSlipSource(amendedOrder(), amendedTicket({ amendCount: 2 })), OPTS).mark, '改单 2 · 以这张为准');
  assert.ok(buildRunnerSlip(menu, amendSlipSource(amendedOrder(), amendedTicket({ amendUndo: true })), OPTS).amendNote!.startsWith('撤回改单：'));
  assert.equal(slipMark(1, false, 1), '改单 · 补打 2');
  assert.equal(slipMark(0, true, 3), '改单 3 · 以这张为准', '改单优先于核对后补打');
});

test('改单补打：能改的单都在后厨屏上，表头不写断网单；同牌加单、吃完再加的说明照写', () => {
  const s = buildRunnerSlip(menu, amendSlipSource(amendedOrder({ receiptNumber: null, offlineReceiptNumber: 'O-F01-0042' }), amendedTicket()), OPTS);
  assert.deepEqual(s.header, { label: '堂食 DINE IN', inverse: false });
  assert.equal(s.ref, '临时号 O-F01-0042');
  assert.equal(buildRunnerSlip(menu, amendSlipSource(amendedOrder({ sharedToken: true }), amendedTicket()), OPTS).flag, '同牌加单 · 和前面的 12 号一起送');
  assert.equal(buildRunnerSlip(menu, amendSlipSource(amendedOrder({ addOnTo: { tokenNumber: 5 } }), amendedTicket()), OPTS).flag, '加单 · 原 5 号的客人');
});

test('改单补打：每次改单一个键；只补打 10 分钟以内的改动；没改过的不打', () => {
  assert.equal(amendSlipKey('o1', 2), 'order:o1:amend:2');
  assert.notEqual(amendSlipKey('o1', 1), slipKey({ orderId: 'o1' }), '和原来那张分开记');
  const at = 1_000_000;
  assert.equal(printsAmendSlip({ amendCount: 1, amendedAtMs: at }, at + SLIP_RESUME_WINDOW_MS), true);
  assert.equal(printsAmendSlip({ amendCount: 1, amendedAtMs: at }, at + SLIP_RESUME_WINDOW_MS + 1), false);
  assert.equal(printsAmendSlip({ amendCount: 0, amendedAtMs: at }, at), false);
  assert.equal(printsAmendSlip({}, at), false);
});

test('真单（没改过）没有改单字样', () => {
  const s = buildRunnerSlip(menu, source(), OPTS);
  assert.equal(s.amendNote, undefined);
  assert.ok(s.lines.every((l) => !l.tags.some((t) => t.text === '改' || t.text === '加')));
});

// ---- 后厨手动补打 ----

const orderView = (patch: Partial<OrderSlipView> = {}): OrderSlipView => ({ ...amendedOrder(), acceptedAtEffectiveMs: Date.UTC(2026, 10, 16, 6, 32), ...patch });

test('后厨手动补打：没改过的单补打原来那张（同一个打印记录，时间写接单时间，没有改单字样）', () => {
  const { key, source: src } = manualSlip('o1', orderView(), { amendCount: 0 });
  assert.equal(key, slipKey({ orderId: 'o1' }));
  const s = buildRunnerSlip(menu, src, OPTS);
  assert.equal(s.time, '14:32');
  assert.equal(s.amendNote, undefined);
  assert.equal(s.mark, null);
  assert.equal(s.totalSen, 1600);
  assert.equal(s.lines.length, 2);
  assert.ok(s.lines.every((l) => l.tags.length === 0));
});

test('后厨手动补打：改过的单补打最近一次改单那张（带改了什么和改 / 加框）', () => {
  const { key, source: src } = manualSlip('o1', orderView(), amendedTicket({ amendCount: 2 }));
  assert.equal(key, amendSlipKey('o1', 2));
  const s = buildRunnerSlip(menu, src, OPTS);
  assert.equal(s.amendNo, 2);
  assert.ok(s.amendNote!.startsWith('改了：'));
  assert.deepEqual(s.lines[0].tags, [{ text: '改', outline: true }]);
});

test('后厨手动补打：加料单照加料的写法', () => {
  const s = buildRunnerSlip(menu, manualSlip('o1', orderView({ extraOnly: true }), {}).source, OPTS);
  assert.equal(s.header.label, '加料 EXTRA');
});

test('后厨手动补打的标记：这台机没打过也写「补打」（不写序号）；打过照旧写「补打 N」', () => {
  assert.equal(slipMark(0, false, undefined, true), '补打');
  assert.equal(slipMark(0, true, undefined, true), '补打', '不写核对后补打');
  assert.equal(slipMark(2, false, undefined, true), '补打 3');
  assert.equal(slipMark(0, false, 2, true), '改单 · 补打');
  assert.equal(slipMark(1, false, 2, true), '改单 · 补打 2');
});
