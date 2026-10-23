/** 本机存储：离线接单原子性（D02）、重启恢复（D01）、序号连续、恢复包重入（D12）。 */
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  _resetConnectionForTests, allocateSequence, appendOfflineEvent, commitOfflineOrder, exportRecoveryPackage,
  importRecoveryPackage, kvGet, listLocalOrders, listOutbox, LocalOrder, releaseSequence, seqKey,
} from './idb';
import { defaultConfig, MENU_V1, OfflineEvent, offlineReceiptNumber, overlayLocalTokens, createTokenBoard, manualStatus } from '../../domain';

const KEY = seqKey('front-01', 1);

/** 新格式：下单未付款（payment=null）。legacy=true 模拟改版前「下单即收现金」的旧日志。 */
function orderEvent(sequence: number, clientOrderId: string, tokenNumber: number, legacy = false): { event: OfflineEvent; order: LocalOrder } {
  const lines = [{ lineId: crypto.randomUUID(), config: defaultConfig(MENU_V1, 'dry_noodle'), quantity: 1 }];
  const payload = {
    clientOrderId, offlineReceiptNumber: offlineReceiptNumber('front-01', sequence), tokenNumber, serviceMode: 'dine_in' as const,
    menuVersion: MENU_V1.version, lines, totalSen: 700,
    payment: legacy ? { method: 'cash' as const, tenderedSen: 1000, qrExternalVerificationNote: null } : null,
  };
  return {
    event: {
      eventId: crypto.randomUUID(), registerId: 'front-01', deviceId: 'dev-1', registerEpoch: 1, sequence, shiftId: 'shift-1',
      occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0, type: 'offline_order_created', payload,
    },
    order: { ...payload, sequence, createdAtMs: Date.now(), changeSen: legacy ? 300 : null },
  };
}

const simple = (type: 'manual_handoff' | 'manual_served', id: string) => (sequence: number): OfflineEvent => ({
  eventId: crypto.randomUUID(), registerId: 'front-01', deviceId: 'dev-1', registerEpoch: 1, sequence, shiftId: 'shift-1',
  occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0, type, payload: { clientOrderId: id },
});

test('D01 离线接单后「关闭浏览器」重开：订单、日志、序号、占牌都在', async () => {
  const a = crypto.randomUUID();
  await commitOfflineOrder(KEY, 3, (seq) => orderEvent(seq, a, 18));
  await appendOfflineEvent(KEY, 3, simple('manual_handoff', a));
  await _resetConnectionForTests();
  const orders = await listLocalOrders();
  const outbox = await listOutbox();
  assert.equal(orders.length, 1);
  assert.equal(orders[0].sequence, 4, '序号接在服务器已应用的 3 之后');
  assert.equal(orders[0].offlineReceiptNumber, 'O-F01-0004');
  assert.deepEqual(outbox.map((r) => [r.sequence, r.event.type, r.status]), [[4, 'offline_order_created', 'pending'], [5, 'manual_handoff', 'pending']]);
  assert.equal(await kvGet<number>(KEY), 5);
  const board = overlayLocalTokens(createTokenBoard(), outbox.map((r) => r.event));
  assert.equal(board[18].state, 'held');
  assert.deepEqual(manualStatus(outbox.map((r) => r.event), a), { handedOff: true, served: false, tokenReturned: false, paid: false });
});

test('D02 写入中途失败：整次回滚，不留下半张单，序号不前进', async () => {
  const before = await listOutbox();
  const seqBefore = await kvGet<number>(KEY);
  await assert.rejects(commitOfflineOrder(KEY, 0, (seq) => {
    const x = orderEvent(seq, crypto.randomUUID(), 19);
    return { event: x.event, order: { ...x.order, clientOrderId: undefined as unknown as string } }; // 缺主键 → 写入失败
  }));
  assert.equal((await listOutbox()).length, before.length);
  assert.equal((await listLocalOrders()).length, 1);
  assert.equal(await kvGet<number>(KEY), seqBefore);
});

test('序号：在线与离线共用；被拒的在线命令仅在其后无分配时才归还', async () => {
  const s1 = await allocateSequence(KEY, 0);
  assert.equal(s1, 6);
  assert.equal(await releaseSequence(KEY, s1), true);
  const s2 = await allocateSequence(KEY, 0);
  assert.equal(s2, 6);
  await appendOfflineEvent(KEY, 0, simple('manual_served', crypto.randomUUID()));
  assert.equal(await releaseSequence(KEY, s2), false, '其后已有离线事件：需要作废事件补位');
  // 服务器已应用的序号更大时（例如换回已同步设备），从服务器值继续
  assert.equal(await allocateSequence(KEY, 100), 101);
});

test('D12 恢复包导出后重复导入：同 eventId 不重复', async () => {
  const pkg = await exportRecoveryPackage();
  const count = (await listOutbox()).length;
  assert.equal(await importRecoveryPackage(pkg), 0);
  assert.equal(await importRecoveryPackage(JSON.parse(JSON.stringify(pkg))), 0);
  assert.equal((await listOutbox()).length, count);
  assert.throws(() => importRecoveryPackage({ ...pkg, kind: 'other' } as never));
});

test('§11-12 断网先下单、后确认收款、人工出餐：各自原子入日志；重启后仍在；出餐即本机释放餐牌', async () => {
  const b = crypto.randomUUID();
  const base = (await kvGet<number>(KEY)) ?? 0;
  await commitOfflineOrder(KEY, 0, (seq) => orderEvent(seq, b, 21));
  await appendOfflineEvent(KEY, 0, (sequence) => ({
    eventId: crypto.randomUUID(), registerId: 'front-01', deviceId: 'dev-1', registerEpoch: 1, sequence, shiftId: 'shift-1',
    occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0, type: 'offline_payment_recorded', payload: { clientOrderId: b, amountSen: 700 },
  }));
  await appendOfflineEvent(KEY, 0, simple('manual_served', b));
  await _resetConnectionForTests();
  const mine = (await listOutbox()).filter((r) => r.event.payload.clientOrderId === b);
  assert.deepEqual(mine.map((r) => [r.sequence - base, r.event.type]), [[1, 'offline_order_created'], [2, 'offline_payment_recorded'], [3, 'manual_served']]);
  const events = (await listOutbox()).map((r) => r.event);
  assert.deepEqual(manualStatus(events, b), { handedOff: false, served: true, tokenReturned: true, paid: true });
  const board = overlayLocalTokens(createTokenBoard(), events);
  assert.equal(board[21].state, 'available', '人工出餐即释放，不再需要人工回收');
  assert.equal(board[21].lastReleasedOrderId, b);
});

test('旧格式日志（下单即收现金 + 出餐 + token_returned）仍能解析叠加', () => {
  const c = crypto.randomUUID();
  const created = orderEvent(1, c, 30, true).event;
  const ev = (type: 'manual_served', seq: number): OfflineEvent => ({ ...simple(type, c)(seq) });
  const returned: OfflineEvent = { ...created, eventId: crypto.randomUUID(), sequence: 3, type: 'token_returned', payload: { clientOrderId: c, tokenNumber: 30 } };
  const events = [created, ev('manual_served', 2), returned];
  assert.equal(manualStatus(events, c).paid, true);
  assert.equal(overlayLocalTokens(createTokenBoard(), events)[30].state, 'available');
});
