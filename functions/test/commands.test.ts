/**
 * Emulator 命令集成测试：真实 Auth 身份 → Callable（asia-southeast1）→ Functions 事务 → Firestore。
 * 覆盖阶段 C 退出条件：接单 → 厨房确认 → 制作 → 出餐 → 回收；以及幂等、并发、越权、篡改。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import {
  admin, cleanupClients, countDocs, newClient, noodle, orderPayload, placeOrder, setupStore, uuid,
} from './harness';
import { defaultConfig, MENU_V1, normalizeConfig } from '../../src/domain';

after(cleanupClients);

const lifecycle = (f: { storeId: string }, orderId: string, expectedVersion: number, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, operationId: uuid(), orderId, expectedVersion, ...extra,
});

test('C 闭环：现金接单 → 后厨确认 → 开始 → 出餐 → 牌待回收 → 回收 → 同牌新单', async () => {
  const f = await setupStore();
  const lines = [
    { config: noodle({ size: 'medium', noodleType: 'mee_poh', spice: 'less', scallion: 'none' }), quantity: 2 },
    { config: normalizeConfig(MENU_V1, { ...defaultConfig(MENU_V1, 'wanton_soup'), size: 'w15' }), quantity: 1 },
  ];
  const { result } = await placeOrder(f, { tokenNumber: 18, lines, expectedTotalSen: 2 * 900 + 1000, payment: { method: 'cash', tenderedSen: 5000, qrConfirmed: false } });
  assert.equal(result.totalSen, 2800);
  assert.equal(result.changeSen, 2200);
  assert.match(result.receiptNumber, /^\d{6}-001$/);
  const orderId = result.orderId;
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);

  // 同事务写入的所有文档
  const order = (await s(`orders/${orderId}`).get()).data()!;
  assert.equal(order.fulfillmentStatus, 'queued');
  assert.equal(order.paymentState, 'paid');
  assert.equal(order.kitchenRouting, 'digital');
  assert.equal(order.items[0].noodleType, 'mee_poh');
  assert.equal(order.items[1].sauce, null);
  assert.equal(order.items[1].spice, null);
  assert.equal((await s(`payments/${orderId}-p1`).get()).data()!.amountSen, 2800);
  const cost = (await s(`orderCosts/${orderId}`).get()).data()!;
  // 2×中面(3635) + 15 粒云吞汤(15×220+600=3900) = 11170
  assert.equal(cost.totalCostUnits, 11170);
  assert.equal((await s('tokens/18').get()).data()!.state, 'held');
  assert.equal((await s('registers/front-01').get()).data()!.lastAppliedSequence, 1);

  // 后厨读取真实网络响应：厨房投影无金额/成本
  const ticketSnap = await getDoc(doc(f.kitchen.db, `stores/${f.storeId}/kitchenTickets/${orderId}`));
  const raw = JSON.stringify(ticketSnap.data());
  assert.ok(!/Sen"|cost|price|payment|refund|tendered|change/i.test(raw), raw);
  assert.equal(ticketSnap.data()!.lines[0].noodleType, 'mee_poh');
  await assert.rejects(getDocs(collection(f.kitchen.db, `stores/${f.storeId}/orders`)), /permission/i, '后厨不能读订单');

  // 后厨确认收到：只记首次时间
  const ack1 = await f.kitchen.call<{ kitchenAckAtMs: number; first: boolean }>('ackKitchenTicket', { storeId: f.storeId, operationId: uuid(), orderId });
  const ack2 = await f.kitchen.call<{ kitchenAckAtMs: number; first: boolean }>('ackKitchenTicket', { storeId: f.storeId, operationId: uuid(), orderId });
  assert.equal(ack1.first, true);
  assert.equal(ack2.first, false);
  assert.equal(ack2.kitchenAckAtMs, ack1.kitchenAckAtMs);
  assert.equal((await s(`orders/${orderId}`).get()).data()!.fulfillmentStatus, 'queued', '收到 ≠ 开始制作');

  const started = await f.kitchen.call<{ version: number }>('startOrder', lifecycle(f, orderId, 1));
  assert.equal(started.version, 2);
  assert.equal((await s(`kitchenTickets/${orderId}`).get()).data()!.fulfillmentStatus, 'preparing');
  const served = await f.kitchen.call<{ version: number; fulfillmentStatus: string }>('serveOrder', lifecycle(f, orderId, 2));
  assert.equal(served.fulfillmentStatus, 'served');
  assert.equal((await s('tokens/18').get()).data()!.state, 'awaiting_return');

  // O06：出餐后同牌仍不可用
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 18 })), 'TOKEN_OCCUPIED');
  // 回收
  const rel = { storeId: f.storeId, operationId: uuid(), ...f.claim, sequence: f.seq.value + 1, tokenNumber: 18, orderId };
  await f.cashier.call('releaseToken', rel);
  f.seq.value++;
  assert.equal((await s('tokens/18').get()).data()!.state, 'available');
  const again = await placeOrder(f, { tokenNumber: 18 });
  assert.match(again.result.receiptNumber, /-002$/);
  assert.equal((await countDocs(f.storeId, 'auditEvents')) >= 6, true);
});

test('O03 同一请求连点 10 次（并发 + 顺序）：一张订单、一条支付、一个牌锁、一份成本', async () => {
  const f = await setupStore();
  const payload = orderPayload(f, { tokenNumber: 5 });
  const parallel = await Promise.allSettled(Array.from({ length: 5 }, () => f.cashier.call<{ orderId: string; paymentId: string; receiptNumber: string }>('createOrder', payload)));
  const sequential = [];
  for (let i = 0; i < 5; i++) sequential.push(await f.cashier.call<{ orderId: string; paymentId: string; receiptNumber: string }>('createOrder', payload));
  const ok = [...parallel.filter((p) => p.status === 'fulfilled').map((p) => (p as PromiseFulfilledResult<any>).value), ...sequential];
  assert.ok(ok.length >= 6, `至少顺序重试全部成功：${JSON.stringify(parallel.filter((p) => p.status === 'rejected'))}`);
  for (const r of ok) {
    assert.equal(r.orderId, payload.order.clientOrderId);
    assert.equal(r.paymentId, `${payload.order.clientOrderId}-p1`);
    assert.equal(r.receiptNumber, ok[0].receiptNumber);
  }
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  assert.equal(await countDocs(f.storeId, 'orderCosts'), 1);
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), 1);
  assert.equal(await countDocs(f.storeId, 'tokens', 'orderId', payload.order.clientOrderId), 1);
  assert.equal(await countDocs(f.storeId, 'operations', 'type', 'createOrder'), 1);
  assert.equal(await countDocs(f.storeId, 'auditEvents', 'action', 'createOrder'), 1);
});

test('O04 已提交但响应丢失：查询原 operation 恢复原单，重试返回同 ID；同 ID 换内容为冲突', async () => {
  const f = await setupStore();
  const payload = orderPayload(f, { tokenNumber: 9 });
  await f.cashier.call('createOrder', payload); // 假设这次响应在网络中丢失
  const status = await f.cashier.call<{ status: string; result: { orderId: string } }>('getOperationResult', { storeId: f.storeId, operationId: payload.operationId });
  assert.equal(status.status, 'committed');
  assert.equal(status.result.orderId, payload.order.clientOrderId);
  const unknown = await f.cashier.call<{ status: string }>('getOperationResult', { storeId: f.storeId, operationId: uuid() });
  assert.equal(unknown.status, 'not_found');
  // 后厨不能查看他人的操作结果
  assert.equal(await f.kitchen.code('getOperationResult', { storeId: f.storeId, operationId: payload.operationId }), 'FORBIDDEN');
  const changed = { ...payload, order: { ...payload.order, tokenNumber: 10 } };
  assert.equal(await f.cashier.code('createOrder', changed), 'OPERATION_CONFLICT');
  // 新 operationId 复用同一订单 ID（复制成新单）被拒绝，不会重复收款
  f.seq.value = payload.sequence;
  assert.equal(await f.cashier.code('createOrder', { ...payload, operationId: uuid(), sequence: f.seq.value + 1 }), 'ORDER_ID_CONFLICT');
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
});

test('O05 两个请求并发争同一餐牌：只有一单占牌成功', async () => {
  const f = await setupStore();
  const a = orderPayload(f, { tokenNumber: 33 });
  const b = orderPayload(f, { tokenNumber: 33 });
  const [ra, rb] = await Promise.all([f.cashier.code('createOrder', a), f.cashier.code('createOrder', b)]);
  const codes = [ra, rb].sort();
  assert.equal(codes.filter((c) => c === 'OK').length, 1, codes.join(','));
  assert.ok(['TOKEN_OCCUPIED', 'SEQUENCE_GAP'].includes(codes.find((c) => c !== 'OK')!), codes.join(','));
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
});

test('O07 两台 KDS 同版本同时出餐：只生效一次', async () => {
  const f = await setupStore();
  const kitchen2 = await newClient('kitchen2');
  await f.owner.call('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: kitchen2.uid, role: 'kitchen', active: true, displayName: '二厨', reason: '第二屏' });
  const { result } = await placeOrder(f, { tokenNumber: 2 });
  const codes = await Promise.all([
    f.kitchen.code('serveOrder', lifecycle(f, result.orderId, 1)),
    kitchen2.code('serveOrder', lifecycle(f, result.orderId, 1)),
  ]);
  assert.equal(codes.filter((c) => c === 'OK').length, 1, codes.join(','));
  assert.ok(codes.includes('STALE_VERSION'), codes.join(','));
  const order = (await admin().doc(`stores/${f.storeId}/orders/${result.orderId}`).get()).data()!;
  assert.equal(order.version, 2);
});

test('O08/O09 撤回：30 秒内恢复原状态；牌已回收后撤回被拒绝', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f, { tokenNumber: 4 });
  const id = result.orderId;
  await f.kitchen.call('startOrder', lifecycle(f, id, 1));
  const startedAt = (await admin().doc(`stores/${f.storeId}/orders/${id}`).get()).data()!.startedAtMs;
  await f.kitchen.call('serveOrder', lifecycle(f, id, 2));
  const undo = await f.kitchen.call<{ fulfillmentStatus: string; version: number }>('undoServe', lifecycle(f, id, 3));
  assert.equal(undo.fulfillmentStatus, 'preparing');
  const o = (await admin().doc(`stores/${f.storeId}/orders/${id}`).get()).data()!;
  assert.equal(o.startedAtMs, startedAt, '原耗时起点不变');
  assert.equal(o.servedAtMs, null);
  assert.equal((await admin().doc(`stores/${f.storeId}/tokens/04`).get()).data()!.state, 'held');
  assert.equal((await admin().doc(`stores/${f.storeId}/kitchenTickets/${id}`).get()).data()!.fulfillmentStatus, 'preparing');

  // 再次出餐 → 回收 → 撤回应被拒绝
  await f.kitchen.call('serveOrder', lifecycle(f, id, 4));
  await f.cashier.call('releaseToken', { storeId: f.storeId, operationId: uuid(), ...f.claim, sequence: f.seq.value + 1, tokenNumber: 4, orderId: id });
  f.seq.value++;
  assert.equal(await f.kitchen.code('undoServe', lifecycle(f, id, 5)), 'TOKEN_REASSIGNED');
  // 收银不能出餐/撤回
  assert.equal(await f.cashier.code('undoServe', lifecycle(f, id, 5)), 'FORBIDDEN');
});

test('F03 取消与退款分离：待做取消反转成本；制作中取消保留成本；只有老板可整单退款且只退一次', async () => {
  const f = await setupStore();
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);

  const q = (await placeOrder(f, { tokenNumber: 11 })).result.orderId;
  const c1 = await f.cashier.call<{ fulfillmentStatus: string; paymentState: string }>('requestCancel', lifecycle(f, q, 1, { reason: '顾客离开' }));
  assert.deepEqual([c1.fulfillmentStatus, c1.paymentState], ['cancelled', 'refund_due']);
  assert.equal((await s(`orderCosts/${q}`).get()).data()!.allocatedCostUnits, 0);
  assert.equal((await s('tokens/11').get()).data()!.state, 'awaiting_return', '取消后牌待回收，不自动释放');
  assert.equal(await countDocs(f.storeId, 'refunds'), 0, '取消不等于已退款');

  const p = (await placeOrder(f, { tokenNumber: 12 })).result.orderId;
  await f.kitchen.call('startOrder', lifecycle(f, p, 1));
  await f.cashier.call('requestCancel', lifecycle(f, p, 2, { reason: '打错单' }));
  assert.equal(await f.kitchen.code('serveOrder', lifecycle(f, p, 3)), 'INVALID_TRANSITION', '取消待确认不能当普通完成');
  assert.equal(await f.cashier.code('confirmKitchenCancel', lifecycle(f, p, 3)), 'FORBIDDEN');
  await f.kitchen.call('confirmKitchenCancel', lifecycle(f, p, 3));
  assert.equal((await s(`orderCosts/${p}`).get()).data()!.allocatedCostUnits, 2 * 425 + 3 * 220 + 1200 + 500, '小面成本 3210 单位保留');

  const refundArgs = lifecycle(f, q, 2, { amountSen: 700, refundMethod: 'cash', reason: '现金已退还顾客' });
  assert.equal(await f.cashier.code('confirmFullRefund', refundArgs), 'FORBIDDEN');
  assert.equal(await f.owner.code('confirmFullRefund', { ...refundArgs, operationId: uuid(), amountSen: 300 }), 'REFUND_MUST_BE_FULL');
  await f.owner.call('confirmFullRefund', refundArgs);
  await f.owner.call('confirmFullRefund', refundArgs); // 同操作重放
  assert.equal(await f.owner.code('confirmFullRefund', { ...refundArgs, operationId: uuid(), expectedVersion: 3 }), 'ALREADY_REFUNDED');
  assert.equal(await countDocs(f.storeId, 'refunds'), 1);
  assert.equal((await s(`orders/${q}`).get()).data()!.paymentState, 'refunded');
});

test('M11/M13/M02 服务器拒绝篡改：改总价、塞单价、Kosong 加肉、干捞云吞白酱、未知字段', async () => {
  const f = await setupStore();
  const code = (o: Parameters<typeof orderPayload>[1]) => f.cashier.code('createOrder', orderPayload(f, o));
  assert.equal(await code({ expectedTotalSen: 1 }), 'PRICE_MISMATCH');
  assert.equal(await code({ lines: [{ config: { ...noodle(), unitPriceSen: 1 }, quantity: 1 }] }), 'INVALID_MODIFIER');
  assert.equal(await code({ lines: [{ config: { ...noodle({ isKosong: true }), addOns: ['wanton_3'] }, quantity: 1 }], expectedTotalSen: 550 }), 'INVALID_MODIFIER');
  assert.equal(await code({ lines: [{ config: { ...defaultConfig(MENU_V1, 'dry_wanton'), sauce: 'white' }, quantity: 1 }] }), 'INVALID_MODIFIER');
  assert.equal(await code({ lines: [{ config: noodle(), quantity: 0 }] }), 'INVALID_ARGUMENT');
  assert.equal(await code({ lines: [{ config: noodle(), quantity: 1.5 }] }), 'INVALID_ARGUMENT');
  assert.equal(await code({ menuVersion: 'menu-old' }), 'MENU_CHANGED');
  assert.equal(await code({ tokenNumber: 51 }), 'INVALID_ARGUMENT');
  assert.equal(await f.cashier.code('createOrder', { ...orderPayload(f), totalSen: 1 }), 'INVALID_ARGUMENT');
  // Kosong 合法：小 350
  const k = await placeOrder(f, { lines: [{ config: noodle({ isKosong: true }), quantity: 1 }], expectedTotalSen: 350, payment: { method: 'cash', tenderedSen: 350, qrConfirmed: false } });
  assert.equal(k.result.totalSen, 350);
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
});

test('O01/O02 收款：少收拒绝；QR 未人工确认拒绝；未配置 QR 拒绝', async () => {
  const f = await setupStore();
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { payment: { method: 'cash', tenderedSen: 500, qrConfirmed: false } })), 'PAYMENT_NOT_CONFIRMED');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { payment: { method: 'qr_manual', tenderedSen: null, qrConfirmed: false } })), 'PAYMENT_NOT_CONFIRMED');
  const qr = await placeOrder(f, { payment: { method: 'qr_manual', tenderedSen: null, qrConfirmed: true } });
  assert.equal(qr.result.changeSen, null);
  const noQr = await setupStore(null);
  assert.equal(await noQr.cashier.code('createOrder', orderPayload(noQr, { payment: { method: 'qr_manual', tenderedSen: null, qrConfirmed: true } })), 'PAYMENT_NOT_CONFIRMED');
});

test('越权：匿名、非成员、他店、后厨下单、停用成员、旧收银机 epoch、缺号', async () => {
  const f = await setupStore();
  const anon = await newClient('anon', false);
  assert.equal(await anon.code('createOrder', orderPayload(f)), 'UNAUTHENTICATED');
  const stranger = await newClient('stranger');
  assert.equal(await stranger.code('createOrder', orderPayload(f)), 'NOT_A_MEMBER');
  assert.equal(await stranger.code('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: stranger.uid, role: 'owner', active: true, displayName: 'x', reason: '自封老板' }), 'NOT_A_MEMBER');
  const other = await setupStore();
  assert.equal(await f.cashier.code('createOrder', orderPayload(other)), 'NOT_A_MEMBER', '他店');
  assert.equal(await f.kitchen.code('createOrder', orderPayload(f)), 'FORBIDDEN');
  assert.equal(await f.cashier.code('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: f.cashier.uid, role: 'owner', active: true, displayName: 'x', reason: '提权' }), 'FORBIDDEN');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { sequence: 5 })), 'SEQUENCE_GAP');

  // 老板更换主收银设备：旧设备立即失效
  const reg = await f.owner.call<{ epoch: number }>('assignRegister', { storeId: f.storeId, operationId: uuid(), registerId: 'front-01', deviceId: 'pos-new', reason: '换机' });
  assert.equal(reg.epoch, f.claim.registerEpoch + 1);
  assert.equal(await f.cashier.code('createOrder', orderPayload(f)), 'REGISTER_REVOKED');

  // 停用成员
  await f.owner.call('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: f.cashier.uid, role: 'cashier', active: false, displayName: 'x', reason: '离职' });
  assert.equal(await f.cashier.code('openShift', { storeId: f.storeId, operationId: uuid(), deviceId: 'pos-new', registerId: 'front-01', registerEpoch: reg.epoch, openingFloatSen: 0 }), 'NOT_A_MEMBER');
});

test('F11（部分）营业日关账后写入屏障：拒绝新单', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f);
  await admin().doc(`stores/${f.storeId}/businessDays/${result.businessDate}`).update({ state: 'closed' });
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 2 })), 'DAY_CLOSED');
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
});
