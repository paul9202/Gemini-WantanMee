/**
 * 离线补同步 Emulator 测试（04 §4）：真实身份调用 syncOfflineEventsCmd。
 * 浏览器侧的断网、刷新、IndexedDB 原子性另见前端测试与 E2E 脚本。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { admin, cleanupClients, countDocs, noodle, orderPayload, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { MENU_V1 } from '../../src/domain';

after(cleanupClients);

type Ev = Record<string, unknown> & { eventId: string; sequence: number };

function makeEvents(f: StoreFixture) {
  let seq = f.seq.value;
  const base = (type: string, payload: Record<string, unknown>, o: { atMs?: number; epoch?: number; deviceId?: string; sequence?: number } = {}): Ev => ({
    eventId: uuid(), registerId: f.claim.registerId, deviceId: o.deviceId ?? f.claim.deviceId, registerEpoch: o.epoch ?? f.claim.registerEpoch,
    sequence: o.sequence ?? ++seq, shiftId: f.shiftId, type, occurredAtDeviceMs: o.atMs ?? Date.now(), lastServerOffsetMs: 0, payload,
  });
  return {
    create: (orderId: string, tokenNumber: number, extra: { totalSen?: number; menuVersion?: string; method?: 'cash' | 'qr_manual'; note?: string | null; atMs?: number; epoch?: number; deviceId?: string } = {}) =>
      base('offline_order_created', {
        clientOrderId: orderId, offlineReceiptNumber: `O-T01-${String(seq + 1).padStart(4, '0')}`, tokenNumber, serviceMode: 'dine_in',
        menuVersion: extra.menuVersion ?? MENU_V1.version, lines: [{ lineId: uuid(), config: noodle({ size: 'medium' }), quantity: 1 }],
        totalSen: extra.totalSen ?? 900,
        payment: extra.method === 'qr_manual'
          ? { method: 'qr_manual', tenderedSen: null, qrExternalVerificationNote: extra.note ?? null }
          : { method: 'cash', tenderedSen: 1000, qrExternalVerificationNote: null },
      }, extra),
    handoff: (orderId: string) => base('manual_handoff', { clientOrderId: orderId }),
    served: (orderId: string) => base('manual_served', { clientOrderId: orderId }),
    returned: (orderId: string, tokenNumber: number) => base('token_returned', { clientOrderId: orderId, tokenNumber }),
    voided: (orderId: string, operationId: string) => base('sequence_void', { clientOrderId: orderId, operationId }),
    skip: () => ++seq,
  };
}

async function sync(f: StoreFixture, events: Ev[], who = f.cashier) {
  const r = await who.call<{ results: { eventId: string; status: string; reasonCode?: string; orderId?: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events });
  for (const x of r.results) if (x.status === 'accepted' || x.status === 'needs_review') f.seq.value = Math.max(f.seq.value, events.find((e) => e.eventId === x.eventId)!.sequence);
  return r.results;
}

const doc = (f: StoreFixture, p: string) => admin().doc(`stores/${f.storeId}/${p}`).get().then((s) => s.data());

test('D03/D04 离线接单→人工交接→人工出餐→回收→同牌新单；每条重复上传 10 次不重复入账、不送厨', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const a = uuid();
  const b = uuid();
  const events = [ev.create(a, 7), ev.handoff(a), ev.served(a), ev.returned(a, 7), ev.create(b, 7)];
  const first = await sync(f, events);
  assert.deepEqual(first.map((r) => r.status), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'], JSON.stringify(first));
  for (let i = 0; i < 10; i++) {
    for (const e of events) {
      const again = await f.cashier.call<{ results: { status: string; orderId?: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events: [e] });
      assert.equal(again.results[0].status, 'accepted');
    }
  }
  assert.equal(await countDocs(f.storeId, 'orders'), 2);
  assert.equal(await countDocs(f.storeId, 'payments'), 2);
  assert.equal(await countDocs(f.storeId, 'orderCosts'), 2);
  assert.equal(await countDocs(f.storeId, 'offlineInbox'), 5);
  assert.equal(await countDocs(f.storeId, 'auditEvents', 'action', 'offline:offline_order_created'), 2);
  const oa = (await doc(f, `orders/${a}`))!;
  assert.equal(oa.source, 'offline');
  assert.equal(oa.kitchenRouting, 'manual');
  assert.equal(oa.fulfillmentStatus, 'served');
  assert.equal(oa.servedManually, true);
  assert.equal(oa.timeQuality, 'device_estimated');
  assert.ok(oa.manualHandoffAtMs && oa.tokenReturnedAtMs);
  assert.match(oa.offlineReceiptNumber, /^O-/);
  assert.equal((await doc(f, 'tokens/07'))!.orderId, b, '最终 7 号牌属于后一张离线单');
  // 后厨电子队列里没有任何离线单
  const digital = await getDocs(query(collection(f.kitchen.db, `stores/${f.storeId}/kitchenTickets`), where('kitchenRouting', '==', 'digital')));
  assert.equal(digital.size, 0);
  assert.equal((await doc(f, 'registers/front-01'))!.lastAppliedSequence, f.seq.value);
  // 补同步后可以继续在线接单（同一序号流）
  const online = await placeOrder(f, { tokenNumber: 8 });
  assert.ok(online.result.orderId);
});

test('D05 尚未制作的离线单：保持人工单；收银核实后才转电子厨单，后厨可接手', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const a = uuid();
  await sync(f, [ev.create(a, 3), ev.handoff(a)]);
  const t = (await doc(f, `kitchenTickets/${a}`))!;
  assert.equal(t.kitchenRouting, 'manual');
  assert.equal(t.fulfillmentStatus, 'queued');
  assert.equal(await f.kitchen.code('startOrder', { storeId: f.storeId, operationId: uuid(), orderId: a, expectedVersion: 1 }), 'OFFLINE_REVIEW_REQUIRED');
  assert.equal(await f.kitchen.code('routeManualOrderToKitchen', { storeId: f.storeId, operationId: uuid(), orderId: a, expectedVersion: 1, note: '已问厨师，未做' }), 'FORBIDDEN');
  await f.cashier.call('routeManualOrderToKitchen', { storeId: f.storeId, operationId: uuid(), orderId: a, expectedVersion: 1, note: '已问厨师，未做' });
  const t2 = (await doc(f, `kitchenTickets/${a}`))!;
  assert.equal(t2.kitchenRouting, 'digital');
  assert.equal(t2.routedFromManual, true);
  await f.kitchen.call('startOrder', { storeId: f.storeId, operationId: uuid(), orderId: a, expectedVersion: 2 });
  // 已出餐的人工单不能转电子
  const b = uuid();
  const ev2 = makeEvents(f);
  await sync(f, [ev2.create(b, 4), ev2.served(b)]);
  assert.equal(await f.cashier.code('routeManualOrderToKitchen', { storeId: f.storeId, operationId: uuid(), orderId: b, expectedVersion: 2, note: '误操作测试' }), 'INVALID_TRANSITION');
});

test('D07 缺号：后续事件阻塞并保留收件；补上缺失事件后按序接纳', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const a = uuid();
  const b = uuid();
  const e1 = ev.create(a, 1);
  const e2 = ev.create(b, 2);
  const r1 = await sync(f, [e2]);
  assert.deepEqual(r1.map((r) => [r.status, r.reasonCode]), [['blocked', 'SEQUENCE_GAP']]);
  assert.equal((await doc(f, `offlineInbox/${e2.eventId}`))!.status, 'blocked');
  assert.equal(await countDocs(f.storeId, 'orders'), 0);
  const r2 = await sync(f, [e2, e1]);
  assert.deepEqual(r2.map((r) => r.status), ['accepted', 'accepted']);
  assert.equal(await countDocs(f.storeId, 'orders'), 2);
});

test('D14 结果不明的在线单最终被拒：作废其序号后，后续离线日志继续接纳；不复制成新单', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const rejectedOp = uuid();
  const lost = uuid();
  const voidEv = ev.voided(lost, rejectedOp);
  const a = uuid();
  const r = await sync(f, [voidEv, ev.create(a, 6)]);
  assert.deepEqual(r.map((x) => x.status), ['accepted', 'accepted']);
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  // 已提交的操作不能被作废
  const committed = await placeOrder(f, { tokenNumber: 7 });
  const bad = await sync(f, [{ ...makeEvents(f).voided(committed.result.orderId, committed.payload.operationId), sequence: committed.payload.sequence }]);
  assert.equal(bad[0].reasonCode, 'SEQUENCE_REUSED');
});

test('D08 离线期间主机被更换：旧机日志进入待核对，不自动接纳、不推进新主机序号', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const a = uuid();
  const old = ev.create(a, 5);
  await f.owner.call('assignRegister', { storeId: f.storeId, operationId: uuid(), registerId: 'front-01', deviceId: 'pos-replacement', reason: '换机' });
  const r = await sync(f, [old]);
  assert.deepEqual(r.map((x) => [x.status, x.reasonCode]), [['needs_review', 'REGISTER_REVOKED']]);
  assert.equal(await countDocs(f.storeId, 'orders'), 0);
  const inbox = (await doc(f, `offlineInbox/${old.eventId}`))!;
  assert.equal(inbox.amountSen, 900, '未入账金额对老板可见');
  assert.equal((await doc(f, 'registers/front-01'))!.lastAppliedSequence, 0);
});

test('D09/D10/D11/价格：未知菜单、时间异常、超出离线资格、QR 无外部核实、金额不符 → 待核对且序号前进', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const events = [
    ev.create(uuid(), 11, { menuVersion: 'menu-unknown' }),
    ev.create(uuid(), 12, { atMs: Date.now() + 10 * 60_000 }),
    ev.create(uuid(), 13, { method: 'qr_manual', note: null }),
    ev.create(uuid(), 14, { totalSen: 100 }),
    ev.create(uuid(), 15, { method: 'qr_manual', note: '老板手机银行 App 已见到账' }),
  ];
  const r = await sync(f, events);
  assert.deepEqual(r.map((x) => x.reasonCode ?? x.status), ['MENU_UNKNOWN', 'TIME_ANOMALY', 'PAYMENT_UNVERIFIED', 'PRICE_MISMATCH', 'accepted']);
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  // 超出 24 小时离线营业资格
  await admin().doc(`stores/${f.storeId}/shifts/${f.shiftId}`).update({ offlineCapabilityExpiresAtMs: Date.now() - 60_000 });
  const late = await sync(f, [makeEvents(f).create(uuid(), 16)]);
  assert.equal(late[0].reasonCode, 'OFFLINE_CAPABILITY_EXPIRED');
});

test('餐牌冲突：被在线单占用 → 待核对；同批已回收的历史单 → 只补账、不抢占当前牌锁', async () => {
  const f = await setupStore();
  const online = await placeOrder(f, { tokenNumber: 9 });
  const ev = makeEvents(f);
  const a = uuid();
  const conflict = await sync(f, [ev.create(a, 9)]);
  assert.deepEqual(conflict.map((x) => x.reasonCode), ['TOKEN_CONFLICT']);
  const b = uuid();
  const ev2 = makeEvents(f);
  const hist = await sync(f, [ev2.create(b, 9), ev2.served(b), ev2.returned(b, 9)]);
  assert.deepEqual(hist.map((x) => x.status), ['accepted', 'accepted', 'accepted']);
  assert.equal((await doc(f, `orders/${b}`))!.tokenLock, 'history_only');
  const tok = (await doc(f, 'tokens/09'))!;
  assert.equal(tok.orderId, online.result.orderId, '当前牌锁仍属于在线单');
  assert.equal(tok.state, 'held');
});

test('D13 云端关账后才恢复的离线单：保留收件为「关账后待调整」，不改动该日账本', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f, { tokenNumber: 1 });
  await admin().doc(`stores/${f.storeId}/businessDays/${result.businessDate}`).update({ state: 'closed' });
  const paymentsBefore = await countDocs(f.storeId, 'payments');
  const r = await sync(f, [makeEvents(f).create(uuid(), 2)]);
  assert.deepEqual(r.map((x) => x.reasonCode), ['DAY_CLOSED_LATE']);
  assert.equal(await countDocs(f.storeId, 'payments'), paymentsBefore);
});

test('同 eventId 换内容被拒绝；后厨不能上传；越权与非法事件被拒绝', async () => {
  const f = await setupStore();
  const ev = makeEvents(f);
  const e = ev.create(uuid(), 20);
  await sync(f, [e]);
  const tampered = { ...e, payload: { ...(e.payload as object), totalSen: 1 } };
  const r = await sync(f, [tampered]);
  assert.deepEqual(r.map((x) => [x.status, x.reasonCode]), [['rejected', 'EVENT_CONFLICT']]);
  assert.equal(await f.kitchen.code('syncOfflineEvents', { storeId: f.storeId, events: [makeEvents(f).create(uuid(), 21)] }), 'FORBIDDEN');
  assert.equal(await f.cashier.code('syncOfflineEvents', { storeId: f.storeId, events: [{ ...makeEvents(f).create(uuid(), 22), type: 'refund' }] }), 'INVALID_ARGUMENT');
  assert.equal(await f.cashier.code('syncOfflineEvents', { storeId: f.storeId, events: [] }), 'INVALID_ARGUMENT');
  // 原单不受影响
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  void orderPayload;
});
