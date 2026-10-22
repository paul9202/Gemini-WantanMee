/**
 * 后厨连接：设备心跳（O11）与在线单的人工传单登记。
 * 心跳只记录「设备最近在线」，不代表厨师已开始；回执仍以 ackKitchenTicket 为准。
 */
import { Firestore } from 'firebase-admin/firestore';
import { runCommand, storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { obj, str, storeId, uuid } from '../core/input';

/** 同一设备两次写入的最短间隔，避免心跳放大写入费用。 */
export const HEARTBEAT_MIN_INTERVAL_MS = 10_000;

export async function heartbeatDevice(db: Firestore, uid: string | undefined, raw: unknown) {
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  const o = obj(raw, ['storeId', 'deviceId', 'appVersion']);
  const sid = storeId(o);
  const deviceId = str(o, 'deviceId', 64);
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) throw new CommandError('INVALID_ARGUMENT', 'deviceId 非法');
  const appVersion = typeof o.appVersion === 'string' ? o.appVersion.slice(0, 40) : null;
  const store = storeRefs(db, sid);
  const member = (await store.member(uid).get()).data();
  if (!member || member.active !== true) throw new CommandError('NOT_A_MEMBER');
  const role = member.role as 'owner' | 'cashier' | 'kitchen';
  const nowMs = Date.now();
  const deviceRef = store.root.collection('devices').doc(deviceId);
  const written = await db.runTransaction(async (tx) => {
    const dev = (await tx.get(deviceRef)).data();
    if (dev && nowMs - (dev.lastSeenAtMs as number) < HEARTBEAT_MIN_INTERVAL_MS) return false;
    tx.set(deviceRef, { role, authUid: uid, lastSeenAtMs: nowMs, appVersion }, { merge: true });
    const statusField = role === 'kitchen' ? 'kitchenLastSeenAtMs' : role === 'cashier' ? 'registerLastSeenAtMs' : 'ownerLastSeenAtMs';
    tx.set(store.status, { [statusField]: nowMs, ...(role === 'kitchen' ? { kitchenLastDeviceId: deviceId } : {}) }, { merge: true });
    return true;
  });
  return { serverNowMs: nowMs, written };
}

/**
 * 在线电子单长时间无后厨回执时，收银登记「已人工传单」。
 * 不改变制作状态与版本；后厨屏恢复后会在卡片上看到，避免重复制作。
 */
export async function recordManualHandoff(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'recordManualHandoff', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND');
      if (order.fulfillmentStatus === 'served' || order.fulfillmentStatus === 'cancelled') throw new CommandError('INVALID_TRANSITION', '订单已结束');
      if (order.manualHandoffAtMs) return { result: { orderId: input.orderId, manualHandoffAtMs: order.manualHandoffAtMs as number }, audit: { entityId: input.orderId } };
      tx.update(store.order(input.orderId), { manualHandoffAtMs: nowMs, manualHandoffReason: input.reason, updatedAtMs: nowMs });
      tx.update(store.ticket(input.orderId), { manualHandoffAtMs: nowMs });
      return { result: { orderId: input.orderId, manualHandoffAtMs: nowMs }, audit: { entityId: input.orderId, after: { manualHandoffAtMs: nowMs, reason: input.reason } } };
    },
  });
}
