/**
 * 整桌收据 buildBillReceipt：一张纸上按接单先后列这桌每张单；合计 / 已收 / 还要收只算没取消的单；还有没收的单就不是付款凭证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBillReceipt, defaultConfig, MENU_V1, normalizeConfig, ReceiptSource } from './index';

const menu = MENU_V1;
const OPTS = { printIndex: 0, timeZone: 'Asia/Kuala_Lumpur' };
const source = (patch: Partial<ReceiptSource> = {}): ReceiptSource => ({
  storeName: '豪云吞面', receiptNumber: '261105-013', offlineReceiptNumber: null, tokenNumber: 5, serviceMode: 'dine_in',
  source: 'online', acceptedAtMs: Date.UTC(2026, 10, 5, 2, 28), timeQuality: 'server', fulfillmentStatus: 'served', servedAtMs: Date.UTC(2026, 10, 5, 2, 38),
  paymentState: 'paid',
  lines: [{ config: normalizeConfig(menu, defaultConfig(menu, 'dry_noodle', 'black')), quantity: 1, unitPriceSen: 700 }],
  totalSen: 700, paymentMethod: 'unspecified', tenderedSen: null, changeSen: null, synced: true, ...patch,
});
const addOn = (patch: Partial<ReceiptSource> = {}) => source({
  receiptNumber: '261105-016', acceptedAtMs: Date.UTC(2026, 10, 5, 2, 40), servedAtMs: null, fulfillmentStatus: 'preparing',
  paymentState: 'unpaid', paymentMethod: null, totalSen: 1800,
  lines: [{ config: normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'red'), size: 'medium' }), quantity: 2, unitPriceSen: 900 }],
  ...patch,
});
const text = (d: ReturnType<typeof buildBillReceipt>) => d.rows.map((r) => `${r.left}|${r.right ?? ''}`).join('\n');

test('整桌收据：同一张牌、每张单的票号和内容都在；合计是整桌的钱，已收的不再算进还要收', () => {
  const d = buildBillReceipt(menu, [source(), addOn()], OPTS);
  const t = text(d);
  assert.equal(d.title, '豪云吞面');
  assert.ok(t.includes('餐牌 5|'));
  assert.ok(t.includes('票号 261105-013') && t.includes('票号 261105-016'), '两张票号都印出来');
  assert.ok(t.includes('RM7.00'), '第一张单的内容');
  assert.ok(t.includes('2 × 红酱面 · 中|RM18.00'), '第二张单的内容');
  assert.ok(t.includes('合计|RM25.00'));
  assert.ok(t.includes('已收|RM7.00'));
  assert.ok(t.includes('还要收|RM18.00'));
  assert.ok(!/成本|利润|cost/i.test(t));
});

test('整桌收据：按接单先后排，和传入顺序无关', () => {
  const d = buildBillReceipt(menu, [addOn(), source()], OPTS);
  const t = text(d);
  assert.ok(t.indexOf('票号 261105-013') < t.indexOf('票号 261105-016'));
});

test('整桌收据：还有没收的单就标「未收款」，全部收完才不标', () => {
  assert.ok(buildBillReceipt(menu, [source(), addOn()], OPTS).badges.includes('未收款 · 不是付款凭证'));
  const allPaid = buildBillReceipt(menu, [source(), addOn({ paymentState: 'paid', paymentMethod: 'unspecified' })], OPTS);
  assert.ok(!allPaid.badges.includes('未收款 · 不是付款凭证'));
  assert.ok(text(allPaid).includes('还要收|RM0.00'));
});

test('整桌收据：已取消的单只列票号和「已取消」，不算钱', () => {
  const d = buildBillReceipt(menu, [source(), addOn({ fulfillmentStatus: 'cancelled', paymentState: 'not_due' })], OPTS);
  const t = text(d);
  assert.ok(t.includes('票号 261105-016|已取消'));
  assert.ok(!t.includes('红酱面'), '不列已取消单的内容');
  assert.ok(t.includes('合计|RM7.00'));
  assert.ok(t.includes('还要收|RM0.00'));
  assert.ok(!d.badges.includes('未收款 · 不是付款凭证'), '已取消的单不算欠款');
});

test('整桌收据：取消待后厨确认的单列出来但不计入合计和还要收', () => {
  const t = text(buildBillReceipt(menu, [source(), addOn({ kitchenCancelRequested: true })], OPTS));
  assert.ok(t.includes('取消待后厨确认，不计|RM18.00'));
  assert.ok(t.includes('合计|RM7.00'));
  assert.ok(t.includes('还要收|RM0.00'));
});

test('整桌收据：离线单有标识，只有临时号时印临时号；旧式加单发过别的牌也都列出', () => {
  const d = buildBillReceipt(menu, [source(), addOn({ source: 'offline', receiptNumber: null, offlineReceiptNumber: 'O-F01-0004', tokenNumber: 9, synced: false })], OPTS);
  const t = text(d);
  assert.ok(d.badges.includes('本机接单 / 人工传单') && d.badges.includes('尚未同步云端'));
  assert.ok(t.includes('临时号 O-F01-0004'));
  assert.ok(t.includes('餐牌 5 / 9|'));
});

test('整桌收据：重印标副本；没有订单不能打印', () => {
  assert.equal(buildBillReceipt(menu, [source(), addOn()], OPTS).copyLabel, null);
  assert.equal(buildBillReceipt(menu, [source(), addOn()], { ...OPTS, printIndex: 1 }).copyLabel, '副本');
  assert.throws(() => buildBillReceipt(menu, [], OPTS));
});
