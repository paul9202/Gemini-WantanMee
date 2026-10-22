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

function orderEvent(sequence: number, clientOrderId: string, tokenNumber: number): { event: OfflineEvent; order: LocalOrder } {
  const lines = [{ lineId: crypto.randomUUID(), config: defaultConfig(MENU_V1, 'dry_noodle'), quantity: 1 }];
  const payload = {
    clientOrderId, offlineReceiptNumber: offlineReceiptNumber('front-01', sequence), tokenNumber, serviceMode: 'dine_in' as const,
    menuVersion: MENU_V1.version, lines, totalSen: 700, payment: { method: 'cash' as const, tenderedSen: 1000, qrExternalVerificationNote: null },
  };
  return {
    event: {
      eventId: crypto.randomUUID(), registerId: 'front-01', deviceId: 'dev-1', registerEpoch: 1, sequence, shiftId: 'shift-1',
      occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0, type: 'offline_order_created', payload,
    },
    order: { ...payload, sequence, createdAtMs: Date.now(), changeSen: 300 },
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
  assert.deepEqual(manualStatus(outbox.map((r) => r.event), a), { handedOff: true, served: false, tokenReturned: false });
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
