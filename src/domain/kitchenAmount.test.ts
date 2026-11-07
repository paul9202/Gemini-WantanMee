/**
 * 后厨金额：每张卡要收多少 / 已付不用收 / 旧单没有金额；同牌框合计；碗卡上挂着的加料。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { kitchenAmount, kitchenFrameTotal, kitchenRM, kitchenSenPlain, openExtrasAmount } from './index';
import type { KitchenTicket } from './kitchen';

type T = Pick<KitchenTicket, 'orderId' | 'totalSen' | 'paidBeforeServe' | 'kitchenCancelRequested' | 'fulfillmentStatus' | 'extraOnly' | 'extraForOrderId'>;
const tk = (orderId: string, over: Partial<T> = {}): T => ({ orderId, kitchenCancelRequested: false, fulfillmentStatus: 'preparing', ...over });

test('kitchenAmount：未付有金额 → 要收；已付 → 不用收（优先于金额）；旧单 → 未知', () => {
  assert.deepEqual(kitchenAmount({ totalSen: 2200, paidBeforeServe: false }), { kind: 'collect', sen: 2200 });
  assert.deepEqual(kitchenAmount({ totalSen: 2200 }), { kind: 'collect', sen: 2200 });
  assert.deepEqual(kitchenAmount({ totalSen: 2200, paidBeforeServe: true }), { kind: 'paid' });
  assert.deepEqual(kitchenAmount({ paidBeforeServe: true }), { kind: 'paid' });
  assert.deepEqual(kitchenAmount({}), { kind: 'unknown' });
  assert.deepEqual(kitchenAmount({ paidBeforeServe: false }), { kind: 'unknown' });
  assert.deepEqual(kitchenAmount({ totalSen: 0 }), { kind: 'collect', sen: 0 });
});

test('kitchenAmount：金额不是非负整数 sen 当作未知，不显示错数', () => {
  assert.deepEqual(kitchenAmount({ totalSen: 12.5 }), { kind: 'unknown' });
  assert.deepEqual(kitchenAmount({ totalSen: -100 }), { kind: 'unknown' });
  assert.deepEqual(kitchenAmount({ totalSen: Number.NaN }), { kind: 'unknown' });
});

test('kitchenFrameTotal：只加未付的；已付不加；取消待确认不加；旧单记为未知', () => {
  // 原型：9 号 碗 9.00 + 加料 2.00 + 同牌加单 7.00 = 18.00
  assert.deepEqual(
    kitchenFrameTotal([tk('a', { totalSen: 900 }), tk('b', { totalSen: 200, extraOnly: true, extraForOrderId: 'a' }), tk('c', { totalSen: 700 })]),
    { sen: 1800, collect: 3, unknown: 0 },
  );
  assert.deepEqual(
    kitchenFrameTotal([tk('a', { totalSen: 900, paidBeforeServe: true }), tk('b', { totalSen: 700 }), tk('c', { totalSen: 500, kitchenCancelRequested: true }), tk('d')]),
    { sen: 700, collect: 1, unknown: 1 },
  );
  assert.deepEqual(kitchenFrameTotal([tk('a', { totalSen: 900, paidBeforeServe: true }), tk('b', { paidBeforeServe: true })]), { sen: 0, collect: 0, unknown: 0 });
  assert.deepEqual(kitchenFrameTotal([]), { sen: 0, collect: 0, unknown: 0 });
});

test('openExtrasAmount：只算给这碗、还在队列、未付、无取消申请的加料', () => {
  const bowl = tk('bowl', { totalSen: 900 });
  const queue = [
    bowl,
    tk('x1', { extraOnly: true, extraForOrderId: 'bowl', totalSen: 200 }),
    tk('x2', { extraOnly: true, extraForOrderId: 'bowl', totalSen: 300, paidBeforeServe: true }),
    tk('x3', { extraOnly: true, extraForOrderId: 'bowl', totalSen: 400, kitchenCancelRequested: true }),
    tk('x4', { extraOnly: true, extraForOrderId: 'bowl', totalSen: 500, fulfillmentStatus: 'served' }),
    tk('x5', { extraOnly: true, extraForOrderId: 'other', totalSen: 600 }),
    tk('x6', { extraOnly: true, extraForOrderId: 'bowl' }),
    tk('n1', { totalSen: 700 }),
  ];
  assert.deepEqual(openExtrasAmount(bowl, queue), { sen: 200, count: 1, unknown: 1 });
  assert.deepEqual(openExtrasAmount(tk('lonely'), queue), { sen: 0, count: 0, unknown: 0 });
  // 加料卡自己不再挂加料。
  assert.deepEqual(openExtrasAmount(queue[1], queue), { sen: 0, count: 0, unknown: 0 });
});

test('kitchenRM / kitchenSenPlain：后厨显示格式', () => {
  assert.equal(kitchenRM(2200), 'RM 22.00');
  assert.equal(kitchenRM(5), 'RM 0.05');
  assert.equal(kitchenRM(123456), 'RM 1,234.56');
  assert.equal(kitchenSenPlain(200), '2.00');
});
