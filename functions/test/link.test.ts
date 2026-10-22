/** O11 心跳与人工传单、O12 跨营业日未完成单（Emulator）。 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { admin, cleanupClients, newClient, placeOrder, setupStore, uuid } from './harness';

after(cleanupClients);

const status = (storeId: string) => admin().doc(`stores/${storeId}/operationsStatus/current`).get().then((s) => s.data() ?? {});

test('O11 心跳：后厨写 kitchenLastSeenAtMs，收银写 registerLastSeenAtMs；10 秒内重复不写；返回服务器时间', async () => {
  const f = await setupStore();
  const before = Date.now();
  const k1 = await f.kitchen.call<{ serverNowMs: number; written: boolean }>('heartbeatDevice', { storeId: f.storeId, deviceId: 'kds-1', appVersion: 'test' });
  assert.equal(k1.written, true);
  assert.ok(Math.abs(k1.serverNowMs - before) < 60_000);
  const k2 = await f.kitchen.call<{ written: boolean }>('heartbeatDevice', { storeId: f.storeId, deviceId: 'kds-1' });
  assert.equal(k2.written, false, '限频');
  await f.cashier.call('heartbeatDevice', { storeId: f.storeId, deviceId: 'pos-1' });
  const s = await status(f.storeId);
  assert.equal(s.kitchenLastSeenAtMs, k1.serverNowMs);
  assert.ok(s.registerLastSeenAtMs >= k1.serverNowMs);
  assert.equal(s.kitchenLastDeviceId, 'kds-1');
  const anon = await newClient('anon', false);
  assert.equal(await anon.code('heartbeatDevice', { storeId: f.storeId, deviceId: 'x' }), 'UNAUTHENTICATED');
  assert.equal(await f.kitchen.code('heartbeatDevice', { storeId: f.storeId, deviceId: '../orders/x' }), 'INVALID_ARGUMENT');
  // 后厨与收银都能读到状态（用于前台判断后厨是否在线）
  const ops = await getDocs(collection(f.cashier.db, `stores/${f.storeId}/operationsStatus`));
  assert.equal(ops.size, 1);
});

test('O11 人工传单：收银登记，不改制作状态与版本；后厨仍可接手并看到标记', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f, { tokenNumber: 6 });
  assert.equal(await f.kitchen.code('recordManualHandoff', { storeId: f.storeId, operationId: uuid(), orderId: result.orderId, reason: '后厨屏离线' }), 'FORBIDDEN');
  await f.cashier.call('recordManualHandoff', { storeId: f.storeId, operationId: uuid(), orderId: result.orderId, reason: '后厨屏离线，已递纸单' });
  const ticket = (await admin().doc(`stores/${f.storeId}/kitchenTickets/${result.orderId}`).get()).data()!;
  assert.ok(ticket.manualHandoffAtMs);
  assert.equal(ticket.version, 1);
  assert.equal(ticket.fulfillmentStatus, 'queued');
  await f.kitchen.call('serveOrder', { storeId: f.storeId, operationId: uuid(), orderId: result.orderId, expectedVersion: 1 });
  assert.equal(await f.cashier.code('recordManualHandoff', { storeId: f.storeId, operationId: uuid(), orderId: result.orderId, reason: '已出餐后不能登记' }), 'INVALID_TRANSITION');
});

test('O12 新营业日仍有昨晚未完成单：后厨继续可见可做，保持原营业日；昨天已关账也不阻止出餐', async () => {
  const f = await setupStore();
  const old = await placeOrder(f, { tokenNumber: 3 });
  const today = old.result.businessDate;
  const [y, m, d] = today.split('-').map(Number);
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  // 模拟「昨晚接的单」：营业日改为昨天，并把昨天关账
  const db = admin();
  await db.doc(`stores/${f.storeId}/orders/${old.result.orderId}`).update({ businessDate: yesterday });
  await db.doc(`stores/${f.storeId}/kitchenTickets/${old.result.orderId}`).update({ businessDate: yesterday });
  await db.doc(`stores/${f.storeId}/businessDays/${yesterday}`).set({ state: 'closed' });
  // 今天的新单不受影响
  const fresh = await placeOrder(f, { tokenNumber: 4 });
  assert.equal(fresh.result.businessDate, today);
  // 后厨查询不按日期截断：两张都在
  const q = await getDocs(query(collection(f.kitchen.db, `stores/${f.storeId}/kitchenTickets`), where('kitchenRouting', '==', 'digital'), where('fulfillmentStatus', 'in', ['queued', 'preparing'])));
  assert.deepEqual(q.docs.map((x) => x.data().businessDate).sort(), [today, yesterday].sort());
  await f.kitchen.call('startOrder', { storeId: f.storeId, operationId: uuid(), orderId: old.result.orderId, expectedVersion: 1 });
  await f.kitchen.call('serveOrder', { storeId: f.storeId, operationId: uuid(), orderId: old.result.orderId, expectedVersion: 2 });
  const o = (await db.doc(`stores/${f.storeId}/orders/${old.result.orderId}`).get()).data()!;
  assert.equal(o.fulfillmentStatus, 'served');
  assert.equal(o.businessDate, yesterday, '保持原营业日');
  // 收银「跨营业日未完成」查询（订单页）能查到昨天的未完成单
  const later = await placeOrder(f, { tokenNumber: 5 });
  await db.doc(`stores/${f.storeId}/orders/${later.result.orderId}`).update({ businessDate: yesterday });
  const open = await getDocs(query(collection(f.cashier.db, `stores/${f.storeId}/orders`), where('fulfillmentStatus', 'in', ['queued', 'preparing'])));
  assert.ok(open.docs.some((x) => x.id === later.result.orderId && x.data().businessDate === yesterday));
});
