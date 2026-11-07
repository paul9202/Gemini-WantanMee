/**
 * 同桌账单汇总：每种付款状态怎么算、本机已登记与取消待确认不进「现在要收」、一桌混合状态的合计；账单 ID 取组长单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { billIdOf, BillOrder, BillSummary, paidAtServeConflict, summarizeBill } from './index';

const FULFILLMENTS = ['queued', 'preparing', 'served', 'cancelled'] as const;
const OPEN_FULFILLMENTS = ['queued', 'preparing', 'served'] as const;
const ZERO: BillSummary = { payable: [], dueSen: 0, paidSen: 0, autoPaidSen: 0, refundDueSen: 0, writtenOffSen: 0, cancelPendingSen: 0 };

const order = (id: string, patch: Partial<BillOrder> = {}): BillOrder => ({
  id, totalSen: 700, paymentState: 'unpaid', fulfillmentStatus: 'preparing', ...patch,
});

test('空账单：全部为零', () => {
  assert.deepEqual(summarizeBill([]), ZERO);
});

test('待收款：未取消的单不论制作到哪一步都要收，金额为整单', () => {
  for (const fulfillmentStatus of OPEN_FULFILLMENTS) {
    assert.deepEqual(summarizeBill([order('a', { fulfillmentStatus, totalSen: 1400 })]), { ...ZERO, payable: [{ orderId: 'a', amountSen: 1400 }], dueSen: 1400 }, fulfillmentStatus);
  }
});

test('已取消的待收款单：不收、不计入任何金额', () => {
  assert.deepEqual(summarizeBill([order('a', { fulfillmentStatus: 'cancelled' })]), ZERO);
  assert.deepEqual(summarizeBill([order('a', { fulfillmentStatus: 'cancelled', kitchenCancelRequested: true })]), ZERO, '取消已成立，不再算待确认');
});

test('已收款：计入已收，不再收；旧数据没有 paidSen 时按整单', () => {
  for (const fulfillmentStatus of FULFILLMENTS) {
    assert.deepEqual(summarizeBill([order('a', { paymentState: 'paid', paidSen: 700, fulfillmentStatus })]), { ...ZERO, paidSen: 700 }, fulfillmentStatus);
  }
  assert.equal(summarizeBill([order('a', { paymentState: 'paid' })]).paidSen, 700);
});

test('应退款：单独列出，不算已收、不算要收；旧数据没有 paidSen 时按整单', () => {
  for (const fulfillmentStatus of FULFILLMENTS) {
    assert.deepEqual(summarizeBill([order('a', { paymentState: 'refund_due', paidSen: 900, totalSen: 900, fulfillmentStatus })]), { ...ZERO, refundDueSen: 900 }, fulfillmentStatus);
  }
  assert.equal(summarizeBill([order('a', { paymentState: 'refund_due' })]).refundDueSen, 700);
});

test('放弃追收：按整单单独列出，不算已收、不算要收', () => {
  for (const fulfillmentStatus of FULFILLMENTS) {
    assert.deepEqual(summarizeBill([order('a', { paymentState: 'written_off', fulfillmentStatus })]), { ...ZERO, writtenOffSen: 700 }, fulfillmentStatus);
  }
});

test('已退款、无需收款：不计入任何金额', () => {
  for (const paymentState of ['refunded', 'not_due'] as const) {
    for (const fulfillmentStatus of FULFILLMENTS) {
      assert.deepEqual(summarizeBill([order('a', { paymentState, paidSen: 700, fulfillmentStatus })]), ZERO, `${paymentState}/${fulfillmentStatus}`);
    }
  }
});

test('取消待确认：不进要收的单，单独计入 cancelPendingSen', () => {
  const s = summarizeBill([order('a', { kitchenCancelRequested: true, totalSen: 900 }), order('b')]);
  assert.deepEqual(s, { ...ZERO, payable: [{ orderId: 'b', amountSen: 700 }], dueSen: 700, cancelPendingSen: 900 });
  // 取消被拒后回到普通待收款
  assert.equal(summarizeBill([order('a', { kitchenCancelRequested: false })]).dueSen, 700);
});

test('本机已登记待同步：算已收、不再收，不会重复计入', () => {
  const local = new Set(['a']);
  assert.deepEqual(summarizeBill([order('a'), order('b', { totalSen: 900 })], local), { ...ZERO, payable: [{ orderId: 'b', amountSen: 900 }], dueSen: 900, paidSen: 700 });
  // 云端已同步成已收：只算一次
  assert.equal(summarizeBill([order('a', { paymentState: 'paid', paidSen: 700 })], local).paidSen, 700);
  // 本机已登记优先于取消待确认：钱已经收了，不算待确认
  assert.deepEqual(summarizeBill([order('a', { kitchenCancelRequested: true })], local), { ...ZERO, paidSen: 700 });
  // 已取消的单即使本机登记过也不算收到（由同步核对处理）
  assert.deepEqual(summarizeBill([order('a', { fulfillmentStatus: 'cancelled' })], local), ZERO);
  // 只看待收款的单：放弃追收的单不因本机记录变成已收
  assert.deepEqual(summarizeBill([order('a', { paymentState: 'written_off' })], local), { ...ZERO, writtenOffSen: 700 });
});

test('一桌混合状态：组长已收也不再收，各项分开算，要收的单保持原顺序', () => {
  const s = summarizeBill([
    order('leader', { paymentState: 'paid', paidSen: 700, fulfillmentStatus: 'served' }),
    order('b', { totalSen: 1400 }),
    order('local', { totalSen: 900 }),
    order('pending', { totalSen: 1100, kitchenCancelRequested: true }),
    order('gone', { totalSen: 500, fulfillmentStatus: 'cancelled' }),
    order('refund', { totalSen: 300, paidSen: 300, paymentState: 'refund_due', fulfillmentStatus: 'cancelled' }),
    order('off', { totalSen: 200, paymentState: 'written_off', fulfillmentStatus: 'served' }),
    order('refunded', { totalSen: 100, paidSen: 100, paymentState: 'refunded', fulfillmentStatus: 'cancelled' }),
    order('notdue', { totalSen: 50, paymentState: 'not_due', fulfillmentStatus: 'cancelled' }),
    order('c', { totalSen: 800, fulfillmentStatus: 'served' }),
  ], new Set(['local']));
  assert.deepEqual(s, {
    payable: [{ orderId: 'b', amountSen: 1400 }, { orderId: 'c', amountSen: 800 }],
    dueSen: 2200, paidSen: 1600, autoPaidSen: 0, refundDueSen: 300, writtenOffSen: 200, cancelPendingSen: 1100,
  });
});

test('全部收完：没有要收的单', () => {
  const s = summarizeBill([order('a', { paymentState: 'paid', paidSen: 700 }), order('b', { paymentState: 'paid', paidSen: 900, totalSen: 900 })]);
  assert.deepEqual(s, { ...ZERO, paidSen: 1600 });
});

test('billIdOf：组长单的 ID；没有关联就是订单自己', () => {
  assert.equal(billIdOf({ id: 'a' }), 'a');
  assert.equal(billIdOf({ id: 'a', addOnTo: null }), 'a');
  assert.equal(billIdOf({ id: 'b', addOnTo: { orderId: 'a' } }), 'a');
});

test('出餐即记收款：已收里分出出餐自动记的部分；旧单没有记录方式算前台确认', () => {
  const s = summarizeBill([
    order('a', { paymentState: 'paid', paidSen: 900, fulfillmentStatus: 'served', paymentConfirmationMode: 'auto_on_serve' }),
    order('b', { paymentState: 'paid', paidSen: 200, fulfillmentStatus: 'served', paymentConfirmationMode: 'manual' }),
    order('c', { paymentState: 'paid', paidSen: 700, fulfillmentStatus: 'served' }),
    order('d', { totalSen: 900 }),
  ]);
  assert.equal(s.paidSen, 1800);
  assert.equal(s.autoPaidSen, 900, '只算 auto_on_serve');
  assert.equal(s.dueSen, 900, '自动记过的不会再进要收');
  assert.equal(summarizeBill([order('x', { paymentState: 'unpaid', paymentConfirmationMode: null })]).autoPaidSen, 0);
});

test('ALREADY_PAID 详情：只有出餐自动记的才算「刚被后厨记了」，旧服务器没给详情照旧', () => {
  assert.deepEqual(paidAtServeConflict({ orderId: 'o1', tokenNumber: 9, confirmationMode: 'auto_on_serve', paidSen: 900 }), { orderId: 'o1', tokenNumber: 9, paidSen: 900 });
  assert.equal(paidAtServeConflict({ orderId: 'o1', tokenNumber: 9, confirmationMode: 'manual', paidSen: 900 }), null);
  assert.equal(paidAtServeConflict({ reasonCode: 'ALREADY_PAID' }), null, '旧服务器');
  assert.equal(paidAtServeConflict(undefined), null);
  assert.deepEqual(paidAtServeConflict({ orderId: 'o2', confirmationMode: 'auto_on_serve' }), { orderId: 'o2', tokenNumber: null, paidSen: 0 }, '缺字段不报错');
});
