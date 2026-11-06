/**
 * 后厨队列 arrangeKitchen：旧厨单照旧 FIFO；同牌加单留在原位、不重新排队；原单先出餐后加单仍占原位；并列时顺序稳定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangeKitchen, sortFifo } from './index';

type T = { orderId: string; acceptedAtEffectiveMs: number; queueAtMs?: number; queueGroupId?: string };

/** '10:28' → 当天的毫秒数（只比先后）。 */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h * 60 + m) * 60_000;
};
const ticket = (orderId: string, hhmm: string, joins?: T): T => ({
  orderId, acceptedAtEffectiveMs: at(hhmm),
  ...(joins ? { queueAtMs: joins.queueAtMs ?? joins.acceptedAtEffectiveMs, queueGroupId: joins.queueGroupId ?? joins.orderId } : {}),
});
/** 每组的单号：[['013','016'],['014']]。 */
const shape = (tickets: T[]) => arrangeKitchen(tickets).map((g) => g.tickets.map((t) => t.orderId));

test('旧厨单没有排队字段：与 FIFO 完全一致，每张自成一组', () => {
  const list = [ticket('c', '10:20'), ticket('a', '10:00'), ticket('b', '10:10')];
  const groups = arrangeKitchen(list);
  assert.deepEqual(groups.map((g) => g.tickets[0]), sortFifo(list));
  assert.deepEqual(groups.map((g) => [g.key, g.tickets.length, g.queueAtMs]), [['a', 1, at('10:00')], ['b', 1, at('10:10')], ['c', 1, at('10:20')]]);
});

test('空列表', () => {
  assert.deepEqual(arrangeKitchen([]), []);
});

test('加单留在原位：排在中间才来的别桌前面，组内按接单先后；加多张都在同一组', () => {
  const a = ticket('a', '10:00');
  const x = ticket('x', '10:05');
  const b = ticket('b', '10:10', a);
  const y = ticket('y', '10:12');
  const c = ticket('c', '10:15', b); // 接着加单：继承 b 继承来的位置和组
  const groups = arrangeKitchen([y, c, x, b, a]);
  assert.deepEqual(groups.map((g) => g.tickets.map((t) => t.orderId)), [['a', 'b', 'c'], ['x'], ['y']]);
  assert.deepEqual(groups.map((g) => [g.key, g.queueAtMs]), [['a', at('10:00')], ['x', at('10:05')], ['y', at('10:12')]]);
});

test('原单先出餐、已不在列表里：加单仍占原位，组键不变', () => {
  const a = ticket('a', '10:00');
  const x = ticket('x', '10:05');
  const b = ticket('b', '10:10', a);
  const c = ticket('c', '10:15', b);
  const groups = arrangeKitchen([x, b, c]);
  assert.deepEqual(groups.map((g) => g.tickets.map((t) => t.orderId)), [['b', 'c'], ['x']]);
  assert.deepEqual([groups[0].key, groups[0].queueAtMs], ['a', at('10:00')]);
  // 只剩最后一张加单也一样
  assert.deepEqual(shape([x, c]), [['c'], ['x']]);
});

test('实际数据重放：013 10:28、014 10:33、015 10:38、016 10:40（继承 013）→ [013+016]、014、015', () => {
  const t013 = ticket('013', '10:28');
  const t014 = ticket('014', '10:33');
  const t015 = ticket('015', '10:38');
  const t016 = ticket('016', '10:40', t013);
  const groups = arrangeKitchen([t013, t014, t015, t016]);
  assert.deepEqual(groups.map((g) => g.tickets.map((t) => t.orderId)), [['013', '016'], ['014'], ['015']]);
  assert.equal(groups[0].queueAtMs, at('10:28'));
  assert.equal(groups[0].tickets[1].acceptedAtEffectiveMs, at('10:40'), '接单时间不变，计时与统计仍按它');
  // 013 先出餐：016 仍排在 014 前面
  assert.deepEqual(shape([t014, t015, t016]), [['016'], ['014'], ['015']]);
});

test('并列：同一排队时间按组键、同一接单时间按单号；结果与传入顺序无关', () => {
  const a = ticket('a', '10:00');
  const b = ticket('b', '10:00');
  const c = ticket('c', '10:00', b);
  const d = ticket('d', '10:00', b);
  const expected = [['a'], ['b', 'c', 'd']];
  assert.deepEqual(shape([a, b, c, d]), expected);
  assert.deepEqual(shape([d, c, b, a]), expected);
  assert.deepEqual(shape([c, a, d, b]), expected);
});

test('不改动传入的数组', () => {
  const list = [ticket('b', '10:10'), ticket('a', '10:00')];
  arrangeKitchen(list);
  assert.deepEqual(list.map((t) => t.orderId), ['b', 'a']);
});
