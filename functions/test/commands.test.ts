/**
 * Emulator 命令集成测试：真实 Auth 身份 → Callable（asia-southeast1）→ Functions 事务 → Firestore。
 * 覆盖：下单即送厨（无付款流水）→ 厨房确认 → 出餐自动释放餐牌 → 同牌新单 → 旧单补登记收款；
 * 以及幂等、并发、越权、篡改，收款独立登记、取消与成本、撤回不抢牌、跨日收款（DESIGN 2026-10-23 §11）；
 * 加单与同牌加单（一张牌挂多张单，逐张出餐 / 取消，全部摘完才释放；排队位置继承；一轮占用内并同桌账单）；
 * 下单后加料（一张小单：同一桌账单、排在那碗的位置、服务器写给哪一碗）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import {
  admin, cleanupClients, countDocs, newClient, noodle, orderPayload, OrderOptions, pay, payPayload, placeOrder, setupStore, StoreFixture, uuid,
} from './harness';
import { AddOnId, arrangeKitchen, BOM_V1, defaultConfig, KitchenTicket, MENU_V1, normalizeConfig } from '../../src/domain';
import { extraConfig } from '../../src/domain/extras';

after(cleanupClients);

const lifecycle = (f: { storeId: string }, orderId: string, expectedVersion: number, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, operationId: uuid(), orderId, expectedVersion, ...extra,
});

/** 厨单上只允许 totalSen（售价合计）与 paidBeforeServe 两个金额相关字段；去掉它们后序列化，再查其余字段。 */
function ticketWithoutSaleTotal(t: Record<string, unknown>): string {
  const { totalSen: _t, paidBeforeServe: _p, ...rest } = t;
  return JSON.stringify(rest);
}

test('§11-1/2/3/4 闭环：下单无付款记录 → 直接制作中 → 后厨回执 → 出餐自动释放牌 → 同牌新单 → 旧单按订单 ID 补登记', async () => {
  const f = await setupStore();
  const lines = [
    { config: noodle({ size: 'medium', noodleType: 'mee_poh', spice: 'less', scallion: 'none' }), quantity: 2 },
    { config: normalizeConfig(MENU_V1, { ...defaultConfig(MENU_V1, 'wanton_soup'), size: 'w15' }), quantity: 1 },
  ];
  const { result } = await placeOrder(f, { tokenNumber: 18, lines, expectedTotalSen: 2 * 900 + 1000 });
  assert.equal(result.totalSen, 2800);
  assert.equal(result.paymentState, 'unpaid');
  assert.equal(result.fulfillmentStatus, 'preparing');
  assert.match(result.receiptNumber, /^\d{6}-001$/);
  const orderId = result.orderId;
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);

  const order = (await s(`orders/${orderId}`).get()).data()!;
  assert.equal(order.schemaVersion, 3);
  assert.equal(order.fulfillmentStatus, 'preparing', '下单即送厨，直接制作中');
  assert.equal(order.startedSource, 'auto');
  assert.equal(order.startedAtMs, order.acceptedAtEffectiveMs);
  assert.equal(order.paymentState, 'unpaid');
  assert.equal(order.paidSen, 0);
  assert.equal(order.paymentMethod, null, '不假装 cash');
  assert.equal(order.kitchenRouting, 'digital');
  assert.equal(order.items[0].noodleType, 'mee_poh');
  assert.equal(order.items[1].sauce, null);
  assert.equal(await countDocs(f.storeId, 'payments'), 0, '未付款不产生付款流水');
  const cost = (await s(`orderCosts/${orderId}`).get()).data()!;
  assert.equal(cost.totalCostUnits, 11610);
  assert.equal((await s('tokens/18').get()).data()!.state, 'held');
  assert.equal((await s('registers/front-01').get()).data()!.lastAppliedSequence, 1);

  // 后厨读取真实网络响应：厨房投影只有售价合计与「已付不用收」，无单价/成本/付款明细
  const ticketSnap = await getDoc(doc(f.kitchen.db, `stores/${f.storeId}/kitchenTickets/${orderId}`));
  assert.deepEqual([ticketSnap.data()!.totalSen, ticketSnap.data()!.paidBeforeServe], [2800, false]);
  const raw = ticketWithoutSaleTotal(ticketSnap.data()!);
  assert.ok(!/Sen"|cost|price|payment|paid|refund|tendered|change/i.test(raw), raw);
  assert.equal(ticketSnap.data()!.fulfillmentStatus, 'preparing');
  assert.equal(ticketSnap.data()!.startedSource, 'auto');
  await assert.rejects(getDocs(collection(f.kitchen.db, `stores/${f.storeId}/orders`)), /permission/i, '后厨不能读订单');

  // 后厨回执独立：只记首次时间，不因建单成功而伪造
  assert.equal((await s(`orders/${orderId}`).get()).data()!.kitchenAckAtMs, null);
  const ack1 = await f.kitchen.call<{ kitchenAckAtMs: number; first: boolean }>('ackKitchenTicket', { storeId: f.storeId, operationId: uuid(), orderId });
  const ack2 = await f.kitchen.call<{ kitchenAckAtMs: number; first: boolean }>('ackKitchenTicket', { storeId: f.storeId, operationId: uuid(), orderId });
  assert.equal(ack1.first, true);
  assert.equal(ack2.kitchenAckAtMs, ack1.kitchenAckAtMs);
  assert.equal(await f.kitchen.code('startOrder', lifecycle(f, orderId, 1)), 'INVALID_TRANSITION', '不再有开始制作步骤');

  // 制作中占牌：同牌不能有第二张有效电子单
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 18 })), 'TOKEN_OCCUPIED');
  const served = await f.kitchen.call<{ version: number; fulfillmentStatus: string; paymentState: string }>('serveOrder', lifecycle(f, orderId, 1));
  assert.equal(served.fulfillmentStatus, 'served');
  assert.equal(served.paymentState, 'unpaid', '出餐不标已付款');
  const tok = (await s('tokens/18').get()).data()!;
  assert.deepEqual([tok.state, tok.orderId, tok.lastReleasedOrderId], ['available', null, orderId], '出餐即自动释放');
  assert.equal((await s(`orders/${orderId}`).get()).data()!.tokenReleaseSource, 'served');

  // 同牌新单
  const again = await placeOrder(f, { tokenNumber: 18 });
  assert.match(again.result.receiptNumber, /-002$/);
  // 旧单（已出餐未收）按原订单 ID 补登记：不影响同牌新单、不重发厨单、不重扣成本
  const ticketsBefore = await countDocs(f.storeId, 'kitchenTickets');
  const costsBefore = await countDocs(f.storeId, 'costEvents');
  const paid = await pay(f, orderId, 2800);
  assert.equal(paid.paymentId, `${orderId}-p1`);
  const p1 = (await s(`payments/${orderId}-p1`).get()).data()!;
  assert.deepEqual([p1.method, p1.confirmationMode, p1.amountSen, p1.tenderedSen], ['unspecified', 'manual', 2800, null]);
  assert.equal((await s(`orders/${orderId}`).get()).data()!.paymentState, 'paid');
  const newer = (await s(`orders/${again.result.orderId}`).get()).data()!;
  assert.deepEqual([newer.paymentState, newer.fulfillmentStatus], ['unpaid', 'preparing'], '同牌新单不受影响');
  assert.equal((await s('tokens/18').get()).data()!.orderId, again.result.orderId);
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), ticketsBefore);
  assert.equal(await countDocs(f.storeId, 'costEvents'), costsBefore);
  assert.equal((await countDocs(f.storeId, 'auditEvents')) >= 6, true);
});

test('§11-2/5 提前登记：下单后立即确认收款，同一张厨单；同 operationId 重试 / 不同 operationId 并发都只登记一次', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f, { tokenNumber: 6 });
  const id = result.orderId;
  const same = payPayload(f, id, 700);
  const parallelSame = await Promise.allSettled(Array.from({ length: 4 }, () => f.cashier.call('recordPayment', same)));
  const replay = await f.cashier.call<{ paymentId: string; replayed: boolean }>('recordPayment', same);
  assert.equal(replay.paymentId, `${id}-p1`);
  assert.equal(replay.replayed, true, '超时后用原 operationId 重试返回原结果');
  assert.ok(parallelSame.some((p) => p.status === 'fulfilled'));
  const others = await Promise.all(Array.from({ length: 4 }, () => f.cashier.code('recordPayment', payPayload(f, id, 700))));
  assert.ok(others.every((c) => c === 'ALREADY_PAID'), others.join(','));
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), 1);
  assert.equal(await countDocs(f.storeId, 'operations', 'type', 'recordPayment'), 1);
  // 再出餐：已付款状态保持
  const served = await f.kitchen.call<{ paymentState: string }>('serveOrder', lifecycle(f, id, 1));
  assert.equal(served.paymentState, 'paid');

  // 并发：两个新 operationId 同时确认同一张未付单
  const b = (await placeOrder(f, { tokenNumber: 7 })).result.orderId;
  const race = await Promise.all([f.cashier.code('recordPayment', payPayload(f, b, 700)), f.owner.code('recordPayment', payPayload(f, b, 700))]);
  assert.equal(race.filter((c) => c === 'OK').length, 1, race.join(','));
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', b), 1);
});

test('收款登记校验：金额须为整单、主收银机资格、后厨不能登记；老板更正误登记后可重新登记，原收款保留', async () => {
  const f = await setupStore();
  const id = (await placeOrder(f, { tokenNumber: 3 })).result.orderId;
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, id, 600)), 'AMOUNT_MISMATCH');
  assert.equal(await f.kitchen.code('recordPayment', payPayload(f, id, 700)), 'FORBIDDEN');
  assert.equal(await f.cashier.code('recordPayment', { ...payPayload(f, id, 700), deviceId: 'pos-other' }), 'REGISTER_REVOKED');
  assert.equal(await f.cashier.code('recordPayment', { ...payPayload(f, id, 700), method: 'cash' }), 'INVALID_ARGUMENT', '不接受渠道字段');
  await pay(f, id, 700);
  assert.equal(await f.cashier.code('reversePayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '点错单' }), 'FORBIDDEN');
  await f.owner.call('reversePayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '点错单' });
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  assert.equal((await s(`orders/${id}`).get()).data()!.paymentState, 'unpaid');
  assert.equal((await s(`payments/${id}-p1`).get()).data()!.amountSen, 700, '原收款不硬删');
  assert.equal((await s(`payments/${id}-p1-rev`).get()).data()!.amountSen, -700);
  assert.equal(await countDocs(f.storeId, 'refunds'), 0, '更正不是退款');
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), 1, '更正不重新送厨');
  const again = await pay(f, id, 700);
  assert.equal(again.paymentId, `${id}-p2`);
});

test('§10 旧客户端带 payment 字段下单被拒，不会把未付款新单当已付', async () => {
  const f = await setupStore();
  const legacy = { ...orderPayload(f), payment: { method: 'cash', tenderedSen: 1000, qrConfirmed: false } };
  assert.equal(await f.cashier.code('createOrder', legacy), 'INVALID_ARGUMENT');
  assert.equal(await countDocs(f.storeId, 'orders'), 0);
});

test('§11-10 开班不需备用金，不创建虚构备用金流水；主设备资格照常校验', async () => {
  const f = await setupStore();
  assert.equal(await countDocs(f.storeId, 'cashMovements'), 0);
  const shift = (await admin().doc(`stores/${f.storeId}/shifts/${f.shiftId}`).get()).data()!;
  assert.deepEqual([shift.status, shift.openingFloatSen, shift.cashDrawerTracked], ['open', null, false]);
  assert.ok(shift.offlineCapabilityExpiresAtMs > Date.now());
  assert.equal(await f.cashier.code('openShift', { storeId: f.storeId, operationId: uuid(), ...f.claim, deviceId: 'pos-other' }), 'REGISTER_REVOKED');
});

test('O03 同一下单请求连点 10 次（并发 + 顺序）：一张订单、零付款流水、一个牌锁、一份成本', async () => {
  const f = await setupStore();
  const payload = orderPayload(f, { tokenNumber: 5 });
  const parallel = await Promise.allSettled(Array.from({ length: 5 }, () => f.cashier.call<{ orderId: string; receiptNumber: string }>('createOrder', payload)));
  const sequential = [];
  for (let i = 0; i < 5; i++) sequential.push(await f.cashier.call<{ orderId: string; receiptNumber: string }>('createOrder', payload));
  const ok = [...parallel.filter((p) => p.status === 'fulfilled').map((p) => (p as PromiseFulfilledResult<any>).value), ...sequential];
  assert.ok(ok.length >= 6, `至少顺序重试全部成功：${JSON.stringify(parallel.filter((p) => p.status === 'rejected'))}`);
  for (const r of ok) {
    assert.equal(r.orderId, payload.order.clientOrderId);
    assert.equal(r.receiptNumber, ok[0].receiptNumber);
  }
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
  assert.equal(await countDocs(f.storeId, 'payments'), 0);
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
  assert.equal(await f.kitchen.code('getOperationResult', { storeId: f.storeId, operationId: payload.operationId }), 'FORBIDDEN');
  const changed = { ...payload, order: { ...payload.order, tokenNumber: 10 } };
  assert.equal(await f.cashier.code('createOrder', changed), 'OPERATION_CONFLICT');
  // 新 operationId 复用同一订单 ID（复制成新单）被拒绝，不会重复送厨
  f.seq.value = payload.sequence;
  assert.equal(await f.cashier.code('createOrder', { ...payload, operationId: uuid(), sequence: f.seq.value + 1 }), 'ORDER_ID_CONFLICT');
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), 1);
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

test('O08/O09/§11-9 撤回：30 秒内重新占回原牌；牌已被新单占用时拒绝、不抢牌、不重复恢复厨单', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f, { tokenNumber: 4, paid: true });
  const id = result.orderId;
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const startedAt = (await s(`orders/${id}`).get()).data()!.startedAtMs;
  await f.kitchen.call('serveOrder', lifecycle(f, id, 1));
  assert.equal((await s('tokens/04').get()).data()!.state, 'available');
  const undo = await f.kitchen.call<{ fulfillmentStatus: string; paymentState: string }>('undoServe', lifecycle(f, id, 2));
  assert.equal(undo.fulfillmentStatus, 'preparing');
  assert.equal(undo.paymentState, 'paid', '撤回不反转收款');
  const o = (await s(`orders/${id}`).get()).data()!;
  assert.equal(o.startedAtMs, startedAt, '原耗时起点不变');
  assert.equal(o.servedAtMs, null);
  const tok = (await s('tokens/04').get()).data()!;
  assert.deepEqual([tok.state, tok.orderId], ['held', id], '同一事务重新占牌');

  // 再出餐 → 新单拿到 4 号 → 撤回被拒绝
  await f.kitchen.call('serveOrder', lifecycle(f, id, 3));
  const newer = await placeOrder(f, { tokenNumber: 4 });
  assert.equal(await f.kitchen.code('undoServe', lifecycle(f, id, 4)), 'TOKEN_REASSIGNED');
  assert.equal((await s('tokens/04').get()).data()!.orderId, newer.result.orderId, '不抢新单的牌');
  assert.equal((await s(`kitchenTickets/${id}`).get()).data()!.fulfillmentStatus, 'served', '不重复恢复厨单');
  // 旧单出餐重放（同操作）不释放新单的牌
  assert.equal(await f.kitchen.code('serveOrder', lifecycle(f, id, 3)), 'STALE_VERSION');
  assert.equal((await s('tokens/04').get()).data()!.state, 'held');
  assert.equal(await f.cashier.code('undoServe', lifecycle(f, id, 4)), 'FORBIDDEN');
});

test('§11-3/7/8 取消：申请期间占牌且冻结；未做→反转成本、已消耗→保留；成立即释放牌；未付不退款，已付应退款后实退才完成', async () => {
  const f = await setupStore();
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);

  // 未付款、自动制作中的单：后厨确认「未做」
  const q = (await placeOrder(f, { tokenNumber: 11 })).result.orderId;
  const req = await f.cashier.call<{ fulfillmentStatus: string }>('requestCancel', lifecycle(f, q, 1, { reason: '顾客离开' }));
  assert.equal(req.fulfillmentStatus, 'preparing');
  assert.equal((await s('tokens/11').get()).data()!.state, 'held', '等后厨确认期间仍占牌');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 11 })), 'TOKEN_OCCUPIED');
  assert.equal(await f.kitchen.code('serveOrder', lifecycle(f, q, 2)), 'INVALID_TRANSITION', '取消待确认不能当普通完成');
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, q, 700)), 'CANCEL_PENDING');
  assert.equal(await f.cashier.code('confirmKitchenCancel', lifecycle(f, q, 2, { consumed: false })), 'FORBIDDEN');
  assert.equal(await f.kitchen.code('confirmKitchenCancel', lifecycle(f, q, 2)), 'INVALID_ARGUMENT', '必须明确未做 / 已消耗');
  const c1 = await f.kitchen.call<{ fulfillmentStatus: string; paymentState: string }>('confirmKitchenCancel', lifecycle(f, q, 2, { consumed: false }));
  assert.deepEqual([c1.fulfillmentStatus, c1.paymentState], ['cancelled', 'not_due']);
  assert.equal((await s(`orderCosts/${q}`).get()).data()!.allocatedCostUnits, 0, '未做：反转成本');
  assert.equal((await s('tokens/11').get()).data()!.state, 'available', '取消成立即释放，不留 awaiting_return');
  assert.equal((await s(`orders/${q}`).get()).data()!.cancelCostDecision, 'not_made');
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, q, 700)), 'ORDER_CANCELLED', '取消后不再待收');
  assert.equal(await f.owner.code('confirmFullRefund', lifecycle(f, q, 3, { amountSen: 700, reason: '测试退款' })), 'INVALID_TRANSITION', '未付不退款');

  // 已付款单：后厨确认「已消耗」
  const p = (await placeOrder(f, { tokenNumber: 12, paid: true })).result.orderId;
  await f.cashier.call('requestCancel', lifecycle(f, p, 1, { reason: '打错单' }));
  const c2 = await f.kitchen.call<{ paymentState: string }>('confirmKitchenCancel', lifecycle(f, p, 2, { consumed: true }));
  assert.equal(c2.paymentState, 'refund_due');
  assert.equal((await s(`orderCosts/${p}`).get()).data()!.allocatedCostUnits, 2 * 425 + 4 * 220 + 1200 + 500, '已消耗成本保留');
  assert.equal((await s('tokens/12').get()).data()!.state, 'available');
  assert.equal(await countDocs(f.storeId, 'refunds'), 0, '取消不等于已退款');

  const refundArgs = lifecycle(f, p, 3, { amountSen: 700, reason: '已退还顾客' });
  assert.equal(await f.cashier.code('confirmFullRefund', refundArgs), 'FORBIDDEN');
  assert.equal(await f.owner.code('confirmFullRefund', { ...refundArgs, operationId: uuid(), amountSen: 300 }), 'REFUND_MUST_BE_FULL');
  await f.owner.call('confirmFullRefund', refundArgs);
  await f.owner.call('confirmFullRefund', refundArgs); // 同操作重放
  assert.equal(await f.owner.code('confirmFullRefund', { ...refundArgs, operationId: uuid(), expectedVersion: 4 }), 'ALREADY_REFUNDED');
  assert.equal(await countDocs(f.storeId, 'refunds'), 1);
  const refund = (await db.collection(`stores/${f.storeId}/refunds`).get()).docs[0].data();
  assert.deepEqual([refund.method, refund.originalPaymentId], ['unspecified', `${p}-p1`], '不强制选择渠道，关联原收款');
  assert.equal((await s(`orders/${p}`).get()).data()!.paymentState, 'refunded');
});

test('§11-13 跨营业日补登记：计入登记日、关联原订单；不改写原日冻结报表、不重扣成本', async () => {
  const f = await setupStore();
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);
  const { result } = await placeOrder(f, { tokenNumber: 8 });
  await f.kitchen.call('serveOrder', lifecycle(f, result.orderId, 1));
  // 把订单移到「昨天」并冻结昨天（模拟跨日）
  const yesterday = '2020-01-01';
  await s(`orders/${result.orderId}`).update({ businessDate: yesterday });
  await s(`businessDays/${yesterday}`).set({ state: 'closed', closedVersion: 1, receiptSeq: 1 });
  await s(`dailyReports/${yesterday}`).set({ businessDate: yesterday, latestVersion: 1, status: 'closed', pendingAdjustments: 0 });
  const frozen = { version: 1, figures: { schemaVersion: 2, registeredSen: 0 } };
  await s(`dailyReports/${yesterday}/versions/1`).set(frozen);
  const costs = await countDocs(f.storeId, 'costEvents');
  const r = await pay(f, result.orderId, 700);
  assert.equal(r.orderBusinessDate, yesterday);
  assert.notEqual(r.businessDate, yesterday, '计入登记当天');
  const p = (await s(`payments/${r.paymentId}`).get()).data()!;
  assert.deepEqual([p.businessDate, p.orderBusinessDate], [r.businessDate, yesterday]);
  assert.deepEqual((await s(`dailyReports/${yesterday}/versions/1`).get()).data(), frozen, '旧冻结报表不变');
  assert.equal((await s(`dailyReports/${yesterday}`).get()).data()!.latestVersion, 1);
  assert.equal(await countDocs(f.storeId, 'costEvents'), costs);
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
  const k = await placeOrder(f, { lines: [{ config: noodle({ isKosong: true }), quantity: 1 }], expectedTotalSen: 350 });
  assert.equal(k.result.totalSen, 350);
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
});

test('混合单：同一单部分堂食部分打包，一次结账；订单、厨单逐行带方式，包装成本只算打包份数；非法行方式被拒', async () => {
  const f = await setupStore();
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { lines: [{ config: noodle(), quantity: 1, serviceMode: 'delivery' }] })), 'INVALID_ARGUMENT');
  const { result } = await placeOrder(f, {
    tokenNumber: 9, serviceMode: 'dine_in', expectedTotalSen: 3 * 700,
    lines: [{ config: noodle(), quantity: 1 }, { config: noodle({ sauce: 'red' }), quantity: 2, serviceMode: 'takeaway' }],
  });
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);
  const order = (await s(`orders/${result.orderId}`).get()).data()!;
  assert.equal(order.serviceMode, 'mixed');
  assert.deepEqual(order.items.map((i: { serviceMode: string }) => i.serviceMode), ['dine_in', 'takeaway']);
  assert.ok(order.items[1].pictogramIds.includes('takeaway:no_side_soup'));
  assert.ok(!order.items[0].pictogramIds.includes('takeaway:no_side_soup'));
  const ticket = (await s(`kitchenTickets/${result.orderId}`).get()).data()!;
  assert.equal(ticket.serviceMode, 'mixed');
  assert.deepEqual(ticket.lines.map((l: { serviceMode: string }) => l.serviceMode), ['dine_in', 'takeaway']);
  const cost = (await s(`orderCosts/${result.orderId}`).get()).data()!;
  assert.equal(cost.packagingCostUnits, 2 * BOM_V1.packagingPerPortion);
  // 一次结账：整单一笔收款
  await pay(f, result.orderId, result.totalSen);
  assert.equal((await s(`orders/${result.orderId}`).get()).data()!.paymentState, 'paid');
});

test('加单：已送厨（已出餐）的单，客人吃完再加打包；新厨单标原餐牌；原单与加单一次结账，任何一单不能登记就整组都不登记', async () => {
  const f = await setupStore();
  const db = admin();
  const s = (p: string) => db.doc(`stores/${f.storeId}/${p}`);
  const root = (await placeOrder(f, { tokenNumber: 5, expectedTotalSen: 700 })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, root.orderId, 1));

  // 原单已出餐、餐牌已释放：加单照常一张新单（可再用同一个牌），挂到原单上
  const add = (await placeOrder(f, {
    tokenNumber: 5, addOnToOrderId: root.orderId, serviceMode: 'takeaway', expectedTotalSen: 1400,
    lines: [{ config: noodle({ sauce: 'red' }), quantity: 2 }],
  })).result;
  const addDoc = (await s(`orders/${add.orderId}`).get()).data()!;
  assert.deepEqual(addDoc.addOnTo, { orderId: root.orderId, tokenNumber: 5, receiptNumber: root.receiptNumber });
  assert.equal(addDoc.paymentState, 'unpaid');
  assert.notEqual(add.receiptNumber, root.receiptNumber, '加单有自己的票号');
  const ticket = (await s(`kitchenTickets/${add.orderId}`).get()).data()!;
  assert.deepEqual(ticket.addOnTo, { tokenNumber: 5 });
  assert.equal(ticket.fulfillmentStatus, 'preparing');
  // 加单的加单仍指向最早的原单
  const add2 = (await placeOrder(f, { tokenNumber: 6, addOnToOrderId: add.orderId, expectedTotalSen: 700 })).result;
  assert.equal((await s(`orders/${add2.orderId}`).get()).data()!.addOnTo.orderId, root.orderId);

  const group = (ids: { orderId: string; amountSen: number }[], operationId = uuid()) => ({ storeId: f.storeId, operationId, ...f.claim, orders: ids });
  const all = [{ orderId: root.orderId, amountSen: 700 }, { orderId: add.orderId, amountSen: 1400 }, { orderId: add2.orderId, amountSen: 700 }];
  // 不同组的单不能合并；金额不对整组都不登记
  const other = (await placeOrder(f, { tokenNumber: 7 })).result;
  assert.equal(await f.cashier.code('recordGroupPayment', group([all[0], { orderId: other.orderId, amountSen: 700 }])), 'INVALID_ARGUMENT');
  assert.equal(await f.cashier.code('recordGroupPayment', group([all[0], { ...all[1], amountSen: 1 }])), 'AMOUNT_MISMATCH');
  assert.equal((await s(`orders/${root.orderId}`).get()).data()!.paymentState, 'unpaid', '整组未写');
  assert.equal(await f.kitchen.code('recordGroupPayment', group(all)), 'FORBIDDEN');

  const op = uuid();
  const r = await f.cashier.call<{ amountSen: number; orders: { orderId: string; paymentId: string }[] }>('recordGroupPayment', group(all, op));
  assert.equal(r.amountSen, 2800);
  for (const o of all) {
    const d = (await s(`orders/${o.orderId}`).get()).data()!;
    assert.deepEqual([d.paymentState, d.paidSen], ['paid', o.amountSen]);
    assert.equal((await s(`payments/${o.orderId}-p1`).get()).data()!.amountSen, o.amountSen, '每单各有一条收款');
  }
  // 同 operationId 重试返回原结果；再登记一次被拒，不会重复收
  assert.equal((await f.cashier.call<{ amountSen: number }>('recordGroupPayment', group(all, op))).amountSen, 2800);
  assert.equal(await f.cashier.code('recordGroupPayment', group(all)), 'ALREADY_PAID');
  // 原单已收款：仍可再挂加单（出餐即记收款后，原单多半已记收款）；新单自己待收款，原单不会再收一次
  const late = (await placeOrder(f, { tokenNumber: 8, addOnToOrderId: root.orderId })).result;
  assert.deepEqual([late.addOnToOrderId, late.paymentState], [root.orderId, 'unpaid']);
  assert.equal((await s(`orders/${late.orderId}`).get()).data()!.addOnTo.orderId, root.orderId);
  assert.equal(await f.cashier.code('recordGroupPayment', group([all[0], { orderId: late.orderId, amountSen: 700 }])), 'ALREADY_PAID', '整组不写，原单不再收');
  assert.equal((await s(`orders/${late.orderId}`).get()).data()!.paymentState, 'unpaid');
  await pay(f, late.orderId, 700);
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 9, addOnToOrderId: uuid() })), 'NOT_FOUND');
});

test('同牌加单：拿着 5 号牌再点一碗挂到同一张牌；各自厨单与票号；逐张出餐、全部出餐才释放；撤回可挂回；与原单一次结账', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const a = (await placeOrder(f, { tokenNumber: 5 })).result;
  assert.equal(a.sharedToken, false);
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 5 })), 'TOKEN_OCCUPIED', '新客人仍不能用占用中的牌');

  const b = (await placeOrder(f, { tokenNumber: 5, joinTokenOrderId: a.orderId, lines: [{ config: noodle(), quantity: 2 }], expectedTotalSen: 1400 })).result;
  assert.deepEqual([b.sharedToken, b.addOnToOrderId], [true, a.orderId], '原单待收款：自动并入它的组');
  assert.notEqual(b.receiptNumber, a.receiptNumber, '同牌加单有自己的票号');
  const tok = (await s('tokens/05').get()).data()!;
  assert.deepEqual([tok.state, tok.orderId, tok.orderIds], ['held', a.orderId, [a.orderId, b.orderId]]);
  const bDoc = (await s(`orders/${b.orderId}`).get()).data()!;
  assert.deepEqual([bDoc.sharedToken, bDoc.tokenNumber, bDoc.addOnTo?.orderId], [true, 5, a.orderId]);
  assert.equal((await s(`orders/${a.orderId}`).get()).data()!.sharedToken, false);
  const ticket = (await s(`kitchenTickets/${b.orderId}`).get()).data()!;
  assert.deepEqual([ticket.sharedToken, ticket.tokenNumber, ticket.receiptNumber, ticket.fulfillmentStatus], [true, 5, b.receiptNumber, 'preparing']);

  // 先出 A：牌仍由 B 占着；撤回 A 挂回同一张牌
  await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 1));
  let t5 = (await s('tokens/05').get()).data()!;
  assert.deepEqual([t5.state, t5.orderId, t5.orderIds], ['held', b.orderId, [b.orderId]], '只摘 A，牌继续占用');
  const undo = await f.kitchen.call<{ fulfillmentStatus: string }>('undoServe', lifecycle(f, a.orderId, 2));
  assert.equal(undo.fulfillmentStatus, 'preparing');
  t5 = (await s('tokens/05').get()).data()!;
  assert.equal(t5.state, 'held');
  assert.ok(t5.orderIds.includes(a.orderId), '撤回：A 挂回 5 号');
  await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 3));
  await f.kitchen.call('serveOrder', lifecycle(f, b.orderId, 1));
  t5 = (await s('tokens/05').get()).data()!;
  assert.deepEqual([t5.state, t5.orderId, t5.orderIds, t5.lastReleasedOrderId], ['available', null, [], b.orderId], '全部出餐才释放');

  const group = { storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: a.orderId, amountSen: 700 }, { orderId: b.orderId, amountSen: 1400 }] };
  const paid = await f.cashier.call<{ amountSen: number }>('recordGroupPayment', group);
  assert.equal(paid.amountSen, 2100);
  for (const id of [a.orderId, b.orderId]) assert.equal((await s(`orders/${id}`).get()).data()!.paymentState, 'paid');
});

test('同牌加单边界：原单已收款也并账、新单仍可自己收；取消其中一张只摘它；牌已给别的客人被拒；牌已空闲则按新客人占同一号', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);

  // 原单已收款：同牌加单仍并入这桌的账（组长已收款，只收还没收的单），自己也能单独收
  const c = (await placeOrder(f, { tokenNumber: 6, paid: true })).result;
  const d = (await placeOrder(f, { tokenNumber: 6, joinTokenOrderId: c.orderId })).result;
  assert.deepEqual([d.sharedToken, d.addOnToOrderId], [true, c.orderId]);
  assert.equal((await s(`orders/${d.orderId}`).get()).data()!.addOnTo.orderId, c.orderId);
  assert.deepEqual((await s('tokens/06').get()).data()!.orderIds, [c.orderId, d.orderId]);
  // 显式指定已收款的原单也可以（出餐即记收款后原单多半已记收款）：新单自己待收款，原单不会再收
  const explicit = (await placeOrder(f, { tokenNumber: 6, joinTokenOrderId: c.orderId, addOnToOrderId: c.orderId })).result;
  assert.deepEqual([explicit.sharedToken, explicit.addOnToOrderId, explicit.paymentState], [true, c.orderId, 'unpaid']);
  await pay(f, d.orderId, 700);
  await pay(f, explicit.orderId, 700);
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', c.orderId), 1, '原单不会再收一次');

  // 取消其中一张：牌继续由另一张占着
  const e = (await placeOrder(f, { tokenNumber: 7 })).result;
  const fo = (await placeOrder(f, { tokenNumber: 7, joinTokenOrderId: e.orderId })).result;
  await f.cashier.call('requestCancel', lifecycle(f, fo.orderId, 1, { reason: '多点了' }));
  assert.deepEqual((await s('tokens/07').get()).data()!.orderIds, [e.orderId, fo.orderId], '取消待确认期间仍占牌');
  await f.kitchen.call('confirmKitchenCancel', lifecycle(f, fo.orderId, 2, { consumed: false }));
  const t7 = (await s('tokens/07').get()).data()!;
  assert.deepEqual([t7.state, t7.orderId, t7.orderIds], ['held', e.orderId, [e.orderId]]);

  // G 出餐后 8 号给了新客人 H：拿 G 来同牌加单被拒，不挂到 H 的牌上
  const g = (await placeOrder(f, { tokenNumber: 8 })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, g.orderId, 1));
  const h = (await placeOrder(f, { tokenNumber: 8 })).result;
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 8, joinTokenOrderId: g.orderId })), 'TOKEN_OCCUPIED');
  assert.deepEqual((await s('tokens/08').get()).data()!.orderIds, [h.orderId]);

  // I 已出餐、9 号空闲没给别人：同牌加单按新客人占 9 号（不算共用），仍并入 I 的组一起收
  const i = (await placeOrder(f, { tokenNumber: 9 })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, i.orderId, 1));
  const j = (await placeOrder(f, { tokenNumber: 9, joinTokenOrderId: i.orderId })).result;
  assert.deepEqual([j.sharedToken, j.addOnToOrderId], [false, i.orderId]);
  assert.equal((await s(`orders/${j.orderId}`).get()).data()!.sharedToken, false);
  const t9 = (await s('tokens/09').get()).data()!;
  assert.deepEqual([t9.state, t9.orderId, t9.orderIds, t9.sessionOrderIds], ['held', j.orderId, [j.orderId], [i.orderId, j.orderId]]);

  // 显式加单的原单不在这张牌上（过期的加单目标）：拒绝，不把别桌的单并进来
  const k = (await placeOrder(f, { tokenNumber: 10 })).result;
  const l = (await placeOrder(f, { tokenNumber: 11 })).result;
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 11, joinTokenOrderId: l.orderId, addOnToOrderId: k.orderId })), 'ADD_ON_NOT_ALLOWED');
});

test('同牌加单自动并单不超过一次结账上限：同组未收款满 10 张后，新单单独收款', async () => {
  const f = await setupStore();
  const root = (await placeOrder(f, { tokenNumber: 14 })).result;
  for (let n = 0; n < 9; n++) {
    const r = (await placeOrder(f, { tokenNumber: 14, joinTokenOrderId: root.orderId })).result;
    assert.equal(r.addOnToOrderId, root.orderId, `第 ${n + 2} 张并入同组`);
  }
  const extra = (await placeOrder(f, { tokenNumber: 14, joinTokenOrderId: root.orderId })).result;
  assert.deepEqual([extra.sharedToken, extra.addOnToOrderId], [true, null], '第 11 张仍挂在 14 号上，但单独收款');
  assert.equal((await admin().doc(`stores/${f.storeId}/tokens/14`).get()).data()!.orderIds.length, 11);
});

test('同牌加单排队：继承同桌最早未完成单的位置，不重新排队；接单时间不变；接着再加还是同一个位置', async () => {
  const f = await setupStore();
  const ticket = async (id: string) => (await admin().doc(`stores/${f.storeId}/kitchenTickets/${id}`).get()).data()!;
  const a = (await placeOrder(f, { tokenNumber: 5 })).result;
  const x = (await placeOrder(f, { tokenNumber: 6 })).result;
  const b = (await placeOrder(f, { tokenNumber: 5, joinTokenOrderId: a.orderId })).result;
  const [ta, tx, tb] = await Promise.all([ticket(a.orderId), ticket(x.orderId), ticket(b.orderId)]);
  assert.deepEqual([ta.queueAtMs, ta.queueGroupId], [undefined, undefined], '原单和普通单不写排队字段');
  assert.deepEqual([tx.queueAtMs, tx.queueGroupId], [undefined, undefined]);
  assert.deepEqual([tb.queueAtMs, tb.queueGroupId], [ta.acceptedAtEffectiveMs, a.orderId], 'B 继承 A 的位置');
  assert.equal(b.queueInherited, true, '结果如实告诉收银排回了原位');
  assert.ok(tb.acceptedAtEffectiveMs > tx.acceptedAtEffectiveMs, 'B 的接单时间不变，仍晚于 X');

  const c = (await placeOrder(f, { tokenNumber: 5, joinTokenOrderId: b.orderId })).result;
  const tc = await ticket(c.orderId);
  assert.deepEqual([tc.queueAtMs, tc.queueGroupId], [ta.acceptedAtEffectiveMs, a.orderId], 'C 接着 B 再加：还是同一个位置、同一组');
  assert.ok(tc.acceptedAtEffectiveMs > tb.acceptedAtEffectiveMs, 'C 的接单时间也不变');

  const queue = arrangeKitchen([tx, tc, tb, ta] as KitchenTicket[]);
  assert.deepEqual(queue.map((g) => g.tickets.map((t) => t.orderId)), [[a.orderId, b.orderId, c.orderId], [x.orderId]], '排在 X 前面');
});

test('同牌加单排队：A 已出餐、B 还占着牌，C 从 B 继承，仍是 A 那个位置和组', async () => {
  const f = await setupStore();
  const ticket = async (id: string) => (await admin().doc(`stores/${f.storeId}/kitchenTickets/${id}`).get()).data()!;
  const a = (await placeOrder(f, { tokenNumber: 12 })).result;
  await placeOrder(f, { tokenNumber: 13 });
  const b = (await placeOrder(f, { tokenNumber: 12, joinTokenOrderId: a.orderId })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 1));
  const c = (await placeOrder(f, { tokenNumber: 12, joinTokenOrderId: b.orderId })).result;
  assert.deepEqual([c.sharedToken, c.addOnToOrderId], [true, a.orderId]);
  const [ta, tb, tc] = await Promise.all([ticket(a.orderId), ticket(b.orderId), ticket(c.orderId)]);
  assert.equal(tb.queueAtMs, ta.acceptedAtEffectiveMs);
  assert.deepEqual([tc.queueAtMs, tc.queueGroupId], [ta.acceptedAtEffectiveMs, a.orderId]);
});

test('同牌加单排队：牌上只有人工单时不继承（人工单不在电子队列里），照常排队尾；账仍并', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const manualId = uuid();
  const sequence = f.seq.value + 1;
  const r = await f.cashier.call<{ results: { status: string }[] }>('syncOfflineEvents', {
    storeId: f.storeId,
    events: [{
      eventId: uuid(), registerId: f.claim.registerId, deviceId: f.claim.deviceId, registerEpoch: f.claim.registerEpoch, sequence, shiftId: f.shiftId,
      type: 'offline_order_created', occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0,
      payload: {
        clientOrderId: manualId, offlineReceiptNumber: 'O-T01-0001', tokenNumber: 31, serviceMode: 'dine_in', menuVersion: MENU_V1.version,
        lines: [{ lineId: uuid(), config: noodle(), quantity: 1 }], totalSen: 700, payment: null,
      },
    }],
  });
  assert.equal(r.results[0].status, 'accepted', JSON.stringify(r.results));
  f.seq.value = sequence;
  const manual = (await s(`kitchenTickets/${manualId}`).get()).data()!;
  assert.deepEqual([manual.kitchenRouting, manual.fulfillmentStatus], ['manual', 'queued']);

  const b = (await placeOrder(f, { tokenNumber: 31, joinTokenOrderId: manualId })).result;
  assert.deepEqual([b.sharedToken, b.addOnToOrderId], [true, manualId]);
  const tb = (await s(`kitchenTickets/${b.orderId}`).get()).data()!;
  assert.deepEqual([tb.queueAtMs, tb.queueGroupId], [undefined, undefined]);
});

test('同桌账单：组长已收款，B、C 还欠；一键收 [B, C] 成功，组长不会被收第二次', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const a = (await placeOrder(f, { tokenNumber: 5, paid: true })).result;
  const b = (await placeOrder(f, { tokenNumber: 5, joinTokenOrderId: a.orderId })).result;
  assert.deepEqual([b.sharedToken, b.addOnToOrderId], [true, a.orderId]);
  await f.kitchen.call('serveOrder', lifecycle(f, b.orderId, 1));
  // A 还在做，牌还在：C 指着已出餐的 B 也算这一桌
  const c = (await placeOrder(f, { tokenNumber: 5, joinTokenOrderId: b.orderId, lines: [{ config: noodle(), quantity: 2 }], expectedTotalSen: 1400 })).result;
  assert.deepEqual([c.sharedToken, c.addOnToOrderId], [true, a.orderId]);
  for (const id of [b.orderId, c.orderId]) assert.equal((await s(`orders/${id}`).get()).data()!.addOnTo.orderId, a.orderId);

  const group = (orders: { orderId: string; amountSen: number }[]) => ({ storeId: f.storeId, operationId: uuid(), ...f.claim, orders });
  const rest = [{ orderId: b.orderId, amountSen: 700 }, { orderId: c.orderId, amountSen: 1400 }];
  assert.equal(await f.cashier.code('recordGroupPayment', group([{ orderId: a.orderId, amountSen: 700 }, ...rest])), 'ALREADY_PAID', '带上已收的组长：整组不写');
  assert.equal((await s(`orders/${b.orderId}`).get()).data()!.paymentState, 'unpaid');
  const paid = await f.cashier.call<{ amountSen: number }>('recordGroupPayment', group(rest));
  assert.equal(paid.amountSen, 2100);
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', a.orderId), 1, 'A 只有一笔收款');
  assert.equal(await countDocs(f.storeId, 'payments'), 3);
  const aDoc = (await s(`orders/${a.orderId}`).get()).data()!;
  assert.deepEqual([aDoc.paymentState, aDoc.paidSen, aDoc.paymentSeq], ['paid', 700, 1]);
});

test('同牌加单指向上一桌的单：牌已换过一轮，不并账；只按牌上这一轮算', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const g = (await placeOrder(f, { tokenNumber: 8 })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, g.orderId, 1));
  const h = (await placeOrder(f, { tokenNumber: 8 })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, h.orderId, 1));
  assert.equal((await s('tokens/08').get()).data()!.state, 'available');

  const j = (await placeOrder(f, { tokenNumber: 8, joinTokenOrderId: g.orderId })).result;
  assert.deepEqual([j.sharedToken, j.addOnToOrderId], [false, null], 'G 不在这一轮占用里：号码相同也不并');
  assert.equal((await s(`orders/${j.orderId}`).get()).data()!.addOnTo, null);
  assert.deepEqual((await s('tokens/08').get()).data()!.sessionOrderIds, [j.orderId]);
  const tj = (await s(`kitchenTickets/${j.orderId}`).get()).data()!;
  assert.deepEqual([tj.queueAtMs, tj.queueGroupId], [undefined, undefined]);
});

test('全部出餐后再加：都收完是普通新单；还有欠款就并账，但排队尾', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);

  // 都出餐、都收完：普通新单
  const a = (await placeOrder(f, { tokenNumber: 15, paid: true })).result;
  const b = (await placeOrder(f, { tokenNumber: 15, joinTokenOrderId: a.orderId, paid: true })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 1));
  await f.kitchen.call('serveOrder', lifecycle(f, b.orderId, 1));
  const fresh = (await placeOrder(f, { tokenNumber: 15, joinTokenOrderId: b.orderId })).result;
  assert.deepEqual([fresh.sharedToken, fresh.addOnToOrderId], [false, null]);
  assert.equal((await s(`orders/${fresh.orderId}`).get()).data()!.addOnTo, null);
  const tFresh = (await s(`kitchenTickets/${fresh.orderId}`).get()).data()!;
  assert.deepEqual([tFresh.queueAtMs, tFresh.queueGroupId], [undefined, undefined]);

  // 都出餐、C 已收、D 还欠：E 并到这桌的账上，牌按新一轮占，不继承位置
  const c = (await placeOrder(f, { tokenNumber: 16, paid: true })).result;
  const d = (await placeOrder(f, { tokenNumber: 16, joinTokenOrderId: c.orderId })).result;
  await f.kitchen.call('serveOrder', lifecycle(f, c.orderId, 1));
  await f.kitchen.call('serveOrder', lifecycle(f, d.orderId, 1));
  const e = (await placeOrder(f, { tokenNumber: 16, joinTokenOrderId: d.orderId })).result;
  assert.deepEqual([e.sharedToken, e.addOnToOrderId], [false, c.orderId]);
  const te = (await s(`kitchenTickets/${e.orderId}`).get()).data()!;
  assert.deepEqual([te.queueAtMs, te.queueGroupId], [undefined, undefined], '排队尾');
  const paid = await f.cashier.call<{ amountSen: number }>('recordGroupPayment', {
    storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: d.orderId, amountSen: 700 }, { orderId: e.orderId, amountSen: 700 }],
  });
  assert.equal(paid.amountSen, 1400);
});

test('取消待确认：加单照常挂上这张牌；合并收款带上待取消的单被拒，整组不写；新单可以单独收', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const a = (await placeOrder(f, { tokenNumber: 17 })).result;
  await f.cashier.call('requestCancel', lifecycle(f, a.orderId, 1, { reason: '点错了' }));
  const b = (await placeOrder(f, { tokenNumber: 17, joinTokenOrderId: a.orderId })).result;
  assert.equal(b.sharedToken, true);
  assert.deepEqual((await s('tokens/17').get()).data()!.orderIds, [a.orderId, b.orderId]);

  const group = { storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: a.orderId, amountSen: 700 }, { orderId: b.orderId, amountSen: 700 }] };
  assert.equal(await f.cashier.code('recordGroupPayment', group), 'CANCEL_PENDING');
  assert.equal((await s(`orders/${b.orderId}`).get()).data()!.paymentState, 'unpaid', '整组不写');
  assert.equal(await countDocs(f.storeId, 'payments'), 0);
  await pay(f, b.orderId, 700);
  assert.equal((await s(`orders/${b.orderId}`).get()).data()!.paymentState, 'paid');
  assert.equal((await s(`orders/${a.orderId}`).get()).data()!.paymentState, 'unpaid');
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
});

test('日结：同一桌合并收款与逐张收款，关账数字一样', async () => {
  const close = async (settle: (f: StoreFixture, orders: { orderId: string; amountSen: number }[]) => Promise<unknown>) => {
    const f = await setupStore();
    const a = (await placeOrder(f, { tokenNumber: 18 })).result;
    const b = (await placeOrder(f, { tokenNumber: 18, joinTokenOrderId: a.orderId, lines: [{ config: noodle(), quantity: 2 }], expectedTotalSen: 1400 })).result;
    await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 1));
    await f.kitchen.call('serveOrder', lifecycle(f, b.orderId, 1));
    await settle(f, [{ orderId: a.orderId, amountSen: 700 }, { orderId: b.orderId, amountSen: 1400 }]);
    assert.equal(await countDocs(f.storeId, 'payments'), 2, '合并收款也是每单一条收款');
    const closed = await f.owner.call<{ figures: any }>('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: a.businessDate, acknowledgeExceptions: true, exceptionReason: '测试关账' });
    const fg = closed.figures;
    return [fg.registeredSen, fg.netRegisteredSen, fg.validOrderCount, fg.validOrderSen, fg.unpaid.count, fg.unpaid.totalSen, fg.summary.receipts.unspecifiedSen];
  };
  const grouped = await close((f, orders) => f.cashier.call('recordGroupPayment', { storeId: f.storeId, operationId: uuid(), ...f.claim, orders }));
  const single = await close(async (f, orders) => {
    for (const o of orders) await pay(f, o.orderId, o.amountSen);
  });
  assert.deepEqual(grouped, [2100, 2100, 2, 2100, 0, 0, 2100]);
  assert.deepEqual(single, grouped);
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
  assert.equal(await f.cashier.code('recordPayment', { storeId: f.storeId, operationId: uuid(), ...f.claim, orderId: uuid(), amountSen: 700 }), 'REGISTER_REVOKED', '旧设备也不能登记收款');

  // 停用成员
  await f.owner.call('manageMember', { storeId: f.storeId, operationId: uuid(), memberUid: f.cashier.uid, role: 'cashier', active: false, displayName: 'x', reason: '离职' });
  assert.equal(await f.cashier.code('openShift', { storeId: f.storeId, operationId: uuid(), deviceId: 'pos-new', registerId: 'front-01', registerEpoch: reg.epoch }), 'NOT_A_MEMBER');
});

test('F11（部分）营业日关账后写入屏障：拒绝新单', async () => {
  const f = await setupStore();
  const { result } = await placeOrder(f);
  await admin().doc(`stores/${f.storeId}/businessDays/${result.businessDate}`).update({ state: 'closed' });
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 2 })), 'DAY_CLOSED');
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
});

test('放弃追收：仅老板、须原因；退出待收款与日结例外，不增加实收、不重扣成本；之后恢复待收款再正常登记', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const { result } = await placeOrder(f, { tokenNumber: 21 });
  const id = result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, id, 1));
  const costs = await countDocs(f.storeId, 'costEvents');
  const args = { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '顾客未付款离开' };
  assert.equal(await f.cashier.code('writeOffPayment', args), 'FORBIDDEN');
  assert.equal(await f.owner.code('writeOffPayment', { ...args, operationId: uuid(), reason: '' }), 'INVALID_ARGUMENT', '必须写原因');
  const w = await f.owner.call<{ writeOffId: string; amountSen: number }>('writeOffPayment', args);
  await f.owner.call('writeOffPayment', args); // 同操作重放
  assert.equal(w.amountSen, 700);
  const wo = (await s(`paymentWriteOffs/${w.writeOffId}`).get()).data()!;
  assert.deepEqual([wo.kind, wo.amountSen, wo.reason, wo.recordedBy], ['write_off', 700, '顾客未付款离开', f.owner.uid], '记录金额、原因、操作者');
  assert.ok(wo.occurredAtMs > 0);
  const o = (await s(`orders/${id}`).get()).data()!;
  assert.deepEqual([o.paymentState, o.paidSen, o.fulfillmentStatus], ['written_off', 0, 'served'], '历史订单保留，不标已付');
  assert.equal(await countDocs(f.storeId, 'payments'), 0, '不计实收');
  assert.equal(await countDocs(f.storeId, 'costEvents'), costs, '不重扣成本');
  assert.equal(await countDocs(f.storeId, 'orders', 'paymentState', 'unpaid'), 0, '退出待登记收款');
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, id, 700)), 'WRITTEN_OFF');
  // 离线补来的收款事件也不能直接入账
  const ev = { eventId: uuid(), registerId: f.claim.registerId, deviceId: f.claim.deviceId, registerEpoch: f.claim.registerEpoch, sequence: f.seq.value + 1, shiftId: f.shiftId, type: 'offline_payment_recorded', occurredAtDeviceMs: Date.now(), lastServerOffsetMs: 0, payload: { clientOrderId: id, amountSen: 700 } };
  const r = await f.cashier.call<{ results: { status: string; reasonCode?: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events: [ev] });
  assert.deepEqual([r.results[0].status, r.results[0].reasonCode], ['needs_review', 'ORDER_STATE']);
  f.seq.value++;
  assert.equal(await countDocs(f.storeId, 'payments'), 0);

  // 日结：不在例外里，未收回金额单独列出，已登记收款不变
  // 唯一的例外是上面那条被拦下的离线收款（待老板核对），不是未登记收款
  const closed = await f.owner.call<{ figures: any; exceptions: any }>('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: result.businessDate, acknowledgeExceptions: true, exceptionReason: '离线收款待核对' });
  assert.equal(closed.exceptions.unpaidOrders.length, 0);
  assert.equal(closed.exceptions.offlineReviews.length, 1);
  assert.deepEqual([closed.figures.registeredSen, closed.figures.writtenOffSen, closed.figures.writtenOffCount, closed.figures.unpaid.count], [0, 700, 1, 0]);
});

test('放弃追收后又收到钱：老板恢复待收款（留记录）→ 主点单平板正常登记一次', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const id = (await placeOrder(f, { tokenNumber: 22 })).result.orderId;
  await f.owner.call('writeOffPayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '跑单' });
  assert.equal(await f.cashier.code('reinstateWrittenOff', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '回来付了' }), 'FORBIDDEN');
  await f.owner.call('reinstateWrittenOff', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '顾客回来付了' });
  assert.equal((await s(`paymentWriteOffs/${id}-w1`).get()).data()!.amountSen, 700, '原放弃记录保留');
  assert.equal((await s(`paymentWriteOffs/${id}-w1-reinstate`).get()).data()!.amountSen, -700);
  assert.equal((await s(`orders/${id}`).get()).data()!.paymentState, 'unpaid');
  await pay(f, id, 700);
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, id, 700)), 'ALREADY_PAID');
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  assert.equal(await f.owner.code('writeOffPayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '已付不能放弃' }), 'NOT_UNPAID');
});

test('后厨「继续做，拒绝取消」：结束申请、通知前台；不释放牌、不改付款；随后正常出餐与收款', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const id = (await placeOrder(f, { tokenNumber: 23 })).result.orderId;
  assert.equal(await f.kitchen.code('rejectKitchenCancel', lifecycle(f, id, 1)), 'INVALID_TRANSITION', '没有取消申请不能拒绝');
  await f.cashier.call('requestCancel', lifecycle(f, id, 1, { reason: '顾客说不要了' }));
  assert.equal(await f.cashier.code('rejectKitchenCancel', lifecycle(f, id, 2)), 'FORBIDDEN');
  const r = await f.kitchen.call<{ fulfillmentStatus: string; paymentState: string; version: number }>('rejectKitchenCancel', lifecycle(f, id, 2, { reason: '已送餐，顾客仍要' }));
  assert.deepEqual([r.fulfillmentStatus, r.paymentState, r.version], ['preparing', 'unpaid', 3]);
  const o = (await s(`orders/${id}`).get()).data()!;
  assert.equal(o.kitchenCancelRequested, false);
  assert.deepEqual([o.cancelRejection.reason, o.cancelRejection.requestedReason], ['已送餐，顾客仍要', '顾客说不要了'], '保留记录供前台提示');
  const t = (await s(`kitchenTickets/${id}`).get()).data()!;
  assert.deepEqual([t.kitchenCancelRequested, t.cancelReason], [false, null]);
  assert.deepEqual([(await s('tokens/23').get()).data()!.state, await countDocs(f.storeId, 'refunds'), await countDocs(f.storeId, 'payments')], ['held', 0, 0], '不释放牌、不退款、不标付款');
  await pay(f, id, 700);
  const served = await f.kitchen.call<{ fulfillmentStatus: string }>('serveOrder', lifecycle(f, id, 3));
  assert.equal(served.fulfillmentStatus, 'served');
  assert.equal((await s('tokens/23').get()).data()!.state, 'available');
});

test('不要番茄酱：在线下单时备注原样进订单和厨单，价钱不变', async () => {
  const f = await setupStore();
  const lines = [{ config: noodle({ sauce: 'red', note: '不要番茄酱' }), quantity: 1 }];
  const { result } = await placeOrder(f, { tokenNumber: 20, lines });
  assert.equal(result.totalSen, 700);
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  assert.equal((await s(`orders/${result.orderId}`).get()).data()!.items[0].note, '不要番茄酱');
  assert.equal((await s(`kitchenTickets/${result.orderId}`).get()).data()!.lines[0].note, '不要番茄酱');
});

test('不要叉烧：和不要番茄酱一起进订单和厨单，价钱不变，成本少一份叉烧；之后加叉烧，小单不再写不要叉烧', async () => {
  const f = await setupStore();
  const s = (p: string) => admin().doc(`stores/${f.storeId}/${p}`);
  const both = '不要番茄酱、不要叉烧';
  const plain = await placeOrder(f, { tokenNumber: 21, lines: [{ config: noodle({ sauce: 'red' }), quantity: 1 }] });
  const bowl = await placeOrder(f, { tokenNumber: 22, lines: [{ config: noodle({ sauce: 'red', note: both }), quantity: 1 }] });
  assert.equal(bowl.result.totalSen, 700);
  assert.equal((await s(`orders/${bowl.result.orderId}`).get()).data()!.items[0].note, both);
  const line = (await s(`kitchenTickets/${bowl.result.orderId}`).get()).data()!.lines[0];
  assert.equal(line.note, both);
  assert.deepEqual(line.pictograms.filter((p: { emphasized: boolean }) => p.emphasized).map((p: { id: string }) => p.id).filter((id: string) => id === 'sauce:no_tomato' || id === 'charsiew:none'), ['sauce:no_tomato', 'charsiew:none']);
  const cost = async (id: string) => (await s(`orderCosts/${id}`).get()).data()!.ingredientCostUnits as number;
  assert.equal(await cost(plain.result.orderId) - await cost(bowl.result.orderId), BOM_V1.charSiewPortion);

  const extra = await placeOrder(f, { tokenNumber: 22, extraForOrderId: bowl.result.orderId, expectedTotalSen: 200,
    lines: [{ config: extraConfig('char_siew'), quantity: 1, forLineId: bowl.payload.order.lines[0].lineId }] });
  assert.equal((await s(`kitchenTickets/${extra.result.orderId}`).get()).data()!.lines[0].note, '给 红酱面 · 小 · 细面 · 辣 · 不要番茄酱');
});

// ---------- 下单后加料 ----------

type Placed = Awaited<ReturnType<typeof placeOrder>>;
const docOf = async (f: StoreFixture, p: string) => (await admin().doc(`stores/${f.storeId}/${p}`).get()).data()!;
const bowlLine = (bowl: Placed) => bowl.payload.order.lines[0].lineId;
/** 给这碗（单的第一行）加一份料：RM2。 */
const extraFor = (bowl: Placed, addOn: AddOnId, tokenNumber: number, patch: OrderOptions = {}): OrderOptions => ({
  tokenNumber, extraForOrderId: bowl.result.orderId, expectedTotalSen: 200,
  lines: [{ config: extraConfig(addOn), quantity: 1, forLineId: bowlLine(bowl) }], ...patch,
});

test('下单后加料：还在做的那碗——挂在同一张牌、排在那碗的位置、并进账单；给哪一碗由服务器写；原单不变', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 5, lines: [{ config: noodle({ sauce: 'red', size: 'medium' }), quantity: 1 }], expectedTotalSen: 900 });
  const a = bowl.result.orderId;
  const later = (await placeOrder(f, { tokenNumber: 6 })).result.orderId;
  const before = await docOf(f, `orders/${a}`);

  const placed = await placeOrder(f, extraFor(bowl, 'char_siew', 5, {
    lines: [{ config: { ...extraConfig('char_siew'), note: '客户端乱写的' }, quantity: 1, forLineId: bowlLine(bowl) }],
  }));
  const x = placed.result;
  assert.deepEqual([x.sharedToken, x.addOnToOrderId, x.queueInherited, x.totalSen, x.paymentState], [true, a, true, 200, 'unpaid']);
  assert.notEqual(x.receiptNumber, bowl.result.receiptNumber, '小单有自己的票号');

  const token = await docOf(f, 'tokens/05');
  assert.deepEqual([token.state, token.orderId, token.orderIds], ['held', a, [a, x.orderId]]);

  const note = '给 红酱面 · 中 · 细面 · 辣';
  const order = await docOf(f, `orders/${x.orderId}`);
  assert.deepEqual([order.extraOnly, order.sharedToken, order.tokenNumber, order.portionCount, order.totalSen, order.paidSen], [true, true, 5, 0, 200, 0]);
  assert.deepEqual(order.addOnTo, { orderId: a, tokenNumber: 5, receiptNumber: bowl.result.receiptNumber });
  const item = order.items[0];
  assert.deepEqual([item.productKind, item.size, item.addOns, item.note, item.nameZh, item.unitPriceSen, item.lineTotalSen, item.serviceMode], ['extra', 'one', ['char_siew'], note, '加叉烧', 200, 200, 'dine_in']);

  const ticket = await docOf(f, `kitchenTickets/${x.orderId}`);
  const aTicket = await docOf(f, `kitchenTickets/${a}`);
  assert.deepEqual([ticket.extraOnly, ticket.sharedToken, ticket.tokenNumber, ticket.receiptNumber], [true, true, 5, x.receiptNumber]);
  assert.deepEqual([ticket.queueAtMs, ticket.queueGroupId], [aTicket.acceptedAtEffectiveMs, a]);
  assert.deepEqual(ticket.addOnTo, { tokenNumber: 5 });
  const line = ticket.lines[0];
  assert.deepEqual([line.productKind, line.sauce, line.nameZh, line.photoId, line.note, line.wantonCount], ['dry_wanton', null, '加叉烧', 'ingredient.char_siew', note, 0]);
  assert.deepEqual([ticket.totalSen, ticket.paidBeforeServe], [200, false], '厨单只写这张小单的售价合计');
  assert.ok(!/Sen"|cost|price|payment|paid|refund|tendered|change/i.test(ticketWithoutSaleTotal(ticket)), '厨单没有单价、成本、付款明细');
  assert.ok(ticket.acceptedAtEffectiveMs > (await docOf(f, `kitchenTickets/${later}`)).acceptedAtEffectiveMs, '接单时间不改');
  const queue = arrangeKitchen([ticket, aTicket, await docOf(f, `kitchenTickets/${later}`)] as KitchenTicket[]);
  assert.deepEqual(queue.map((g) => g.tickets.map((t) => t.orderId)), [[a, x.orderId], [later]], '排在后来的客人前面');

  // 卖 RM2，成本记在账上：一份叉烧（1200 成本单位 = RM1.20）
  const cost = await docOf(f, `orderCosts/${x.orderId}`);
  assert.deepEqual([cost.ingredientCostUnits, cost.packagingCostUnits, cost.totalCostUnits], [BOM_V1.charSiewPortion, 0, BOM_V1.charSiewPortion]);
  const event = await docOf(f, `costEvents/${placed.payload.operationId}-alloc`);
  assert.deepEqual([event.orderId, event.kind, event.costUnits], [x.orderId, 'allocate', BOM_V1.charSiewPortion]);

  const after = await docOf(f, `orders/${a}`);
  assert.deepEqual([after.totalSen, after.version, after.items], [before.totalSen, before.version, before.items], '原单金额和内容不变');
  assert.equal(after.extraOnly, undefined);
});

test('下单后加料：堂食 / 打包跟那一碗走，不计包装；加云吞算进厨单云吞数', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 5, lines: [{ config: noodle(), quantity: 1, serviceMode: 'takeaway' }] });
  const x = (await placeOrder(f, extraFor(bowl, 'wanton_3', 5))).result;
  const order = await docOf(f, `orders/${x.orderId}`);
  assert.deepEqual([order.serviceMode, order.items[0].serviceMode, order.items[0].note], ['takeaway', 'takeaway', '给 黑酱面 · 小 · 细面 · 辣 · 打包']);
  const cost = await docOf(f, `orderCosts/${x.orderId}`);
  assert.deepEqual([cost.packagingCostUnits, cost.totalCostUnits], [0, 3 * BOM_V1.wanton]);
  const ticket = await docOf(f, `kitchenTickets/${x.orderId}`);
  assert.deepEqual([ticket.lines[0].serviceMode, ticket.lines[0].wantonCount, ticket.lines[0].nameZh], ['takeaway', 3, '加云吞3粒']);
});

test('下单后加料：那碗已出餐、牌空闲——把同一张牌再给客人，这碗留在这一轮，仍排在那碗的位置；撤回那碗还认这张牌', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 7 });
  const a = bowl.result.orderId;
  const later = (await placeOrder(f, { tokenNumber: 8 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  assert.equal((await docOf(f, 'tokens/07')).state, 'available');

  const x = (await placeOrder(f, extraFor(bowl, 'char_siew', 7))).result;
  assert.deepEqual([x.sharedToken, x.addOnToOrderId, x.queueInherited], [false, a, true], '牌是重新发的：要提醒把牌给客人');
  const token = await docOf(f, 'tokens/07');
  assert.deepEqual([token.state, token.orderId, token.orderIds, token.sessionOrderIds, token.lastReleasedOrderId], ['held', x.orderId, [x.orderId], [a, x.orderId], null]);

  const ticket = await docOf(f, `kitchenTickets/${x.orderId}`);
  const aTicket = await docOf(f, `kitchenTickets/${a}`);
  assert.deepEqual([ticket.queueAtMs, ticket.queueGroupId, ticket.sharedToken], [aTicket.acceptedAtEffectiveMs, a, false]);
  const queue = arrangeKitchen([ticket, await docOf(f, `kitchenTickets/${later}`)] as KitchenTicket[]);
  assert.deepEqual(queue.map((g) => g.tickets.map((t) => t.orderId)), [[x.orderId], [later]], '那碗出餐了也排在原位');

  await f.kitchen.call('undoServe', lifecycle(f, a, 2));
  assert.deepEqual((await docOf(f, 'tokens/07')).orderIds, [x.orderId, a]);
});

test('下单后加料：原来的号给了别的客人——同号被拒，换一张空闲的牌可以，账和位置还跟那碗', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 8 });
  const a = bowl.result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  const other = (await placeOrder(f, { tokenNumber: 8 })).result.orderId;

  assert.equal(await f.cashier.code('createOrder', orderPayload(f, extraFor(bowl, 'char_siew', 8))), 'TOKEN_OCCUPIED');
  assert.deepEqual((await docOf(f, 'tokens/08')).orderIds, [other], '绝不挂到别人的牌上');
  assert.equal(await countDocs(f.storeId, 'orders'), 2);

  const x = (await placeOrder(f, extraFor(bowl, 'char_siew', 9))).result;
  assert.deepEqual([x.sharedToken, x.addOnToOrderId, x.queueInherited], [false, a, true]);
  const token = await docOf(f, 'tokens/09');
  assert.deepEqual([token.state, token.orderIds, token.sessionOrderIds], ['held', [x.orderId], [a, x.orderId]]);
  const order = await docOf(f, `orders/${x.orderId}`);
  assert.deepEqual([order.tokenNumber, order.addOnTo.orderId, order.addOnTo.tokenNumber], [9, a, 8]);
  const ticket = await docOf(f, `kitchenTickets/${x.orderId}`);
  assert.deepEqual([ticket.tokenNumber, ticket.addOnTo.tokenNumber, ticket.queueGroupId], [9, 8, a]);
  assert.deepEqual((await docOf(f, 'tokens/08')).orderIds, [other]);
});

test('下单后加料：第二份挂在同一张牌，同一个位置、同一张账单', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 10 });
  const a = bowl.result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  const x1 = (await placeOrder(f, extraFor(bowl, 'char_siew', 10))).result;
  const x2 = (await placeOrder(f, extraFor(bowl, 'wanton_3', 10))).result;
  assert.deepEqual([x2.sharedToken, x2.addOnToOrderId, x2.queueInherited], [true, a, true]);
  const token = await docOf(f, 'tokens/10');
  assert.deepEqual([token.state, token.orderIds, token.sessionOrderIds], ['held', [x1.orderId, x2.orderId], [a, x1.orderId, x2.orderId]]);
  const [t1, t2] = [await docOf(f, `kitchenTickets/${x1.orderId}`), await docOf(f, `kitchenTickets/${x2.orderId}`)];
  assert.deepEqual([t2.queueAtMs, t2.queueGroupId], [t1.queueAtMs, t1.queueGroupId]);
});

test('下单后加料：原单已收款——并进它的账单，只收这张小单，原单不会再收一次', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 11, paid: true });
  const a = bowl.result.orderId;
  const x = (await placeOrder(f, extraFor(bowl, 'char_siew', 11))).result;
  assert.equal(x.addOnToOrderId, a);
  assert.equal((await docOf(f, `orders/${x.orderId}`)).addOnTo.orderId, a);

  const group = (orders: { orderId: string; amountSen: number }[]) => ({ storeId: f.storeId, operationId: uuid(), ...f.claim, orders });
  const rest = [{ orderId: x.orderId, amountSen: 200 }];
  assert.equal(await f.cashier.code('recordGroupPayment', group([{ orderId: a, amountSen: 700 }, ...rest])), 'ALREADY_PAID');
  const paid = await f.cashier.call<{ amountSen: number }>('recordGroupPayment', group(rest));
  assert.equal(paid.amountSen, 200);
  assert.equal((await docOf(f, `orders/${x.orderId}`)).paymentState, 'paid');
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', a), 1, '原单只有一笔收款');
  assert.equal(await countDocs(f.storeId, 'payments'), 2);
  assert.deepEqual([(await docOf(f, `orders/${a}`)).paidSen, (await docOf(f, `orders/${a}`)).totalSen], [700, 700]);
});

test('下单后加料被拒：净面加肉、干捞云吞加叉烧、加料上再加料、认不出那一碗、混了普通餐品；什么都不写', async () => {
  const f = await setupStore();
  const reject = async (o: OrderOptions) => f.cashier.code('createOrder', orderPayload(f, o));

  const kosong = await placeOrder(f, { tokenNumber: 1, lines: [{ config: noodle({ isKosong: true }), quantity: 1 }], expectedTotalSen: 350 });
  assert.equal(await reject(extraFor(kosong, 'char_siew', 1)), 'EXTRA_NOT_ALLOWED');
  assert.equal(await reject(extraFor(kosong, 'wanton_3', 1)), 'EXTRA_NOT_ALLOWED');

  const dryWanton = await placeOrder(f, { tokenNumber: 2, lines: [{ config: normalizeConfig(MENU_V1, defaultConfig(MENU_V1, 'dry_wanton')), quantity: 1 }] });
  assert.equal(await reject(extraFor(dryWanton, 'char_siew', 2)), 'EXTRA_NOT_ALLOWED');

  const bowl = await placeOrder(f, { tokenNumber: 3 });
  const x = await placeOrder(f, extraFor(bowl, 'char_siew', 3));
  assert.equal(await reject(extraFor(x, 'char_siew', 3)), 'EXTRA_NOT_ALLOWED', '加料上不能再加料');

  const line = (forLineId?: string) => ({ config: extraConfig('char_siew'), quantity: 1, ...(forLineId ? { forLineId } : {}) });
  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, { lines: [line(uuid())] })), 'EXTRA_NOT_ALLOWED', '那张单没有这一行');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, { lines: [line()] })), 'EXTRA_NOT_ALLOWED', '没说给哪一碗');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, {
    lines: [line(bowlLine(bowl)), { config: noodle(), quantity: 1, forLineId: bowlLine(bowl) }], expectedTotalSen: 900,
  })), 'EXTRA_NOT_ALLOWED', '混了一碗面');

  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, { extraForOrderId: uuid() })), 'NOT_FOUND');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, { expectedTotalSen: 100 })), 'PRICE_MISMATCH');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 3, { lines: [{ ...line(bowlLine(bowl)), quantity: 2 }] })), 'PRICE_MISMATCH', '两份是 RM4，服务器重算');

  assert.equal(await countDocs(f.storeId, 'orders'), 4);
  assert.deepEqual((await docOf(f, 'tokens/03')).orderIds, [bowl.result.orderId, x.result.orderId]);
});

test('下单后加料被拒：原单已取消、取消待确认、不是今天的单', async () => {
  const f = await setupStore();
  const pending = await placeOrder(f, { tokenNumber: 4 });
  await f.cashier.call('requestCancel', lifecycle(f, pending.result.orderId, 1, { reason: '点错了' }));
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, extraFor(pending, 'char_siew', 4))), 'EXTRA_NOT_ALLOWED', '取消待确认');
  await f.kitchen.call('confirmKitchenCancel', lifecycle(f, pending.result.orderId, 2, { consumed: false }));
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, extraFor(pending, 'char_siew', 4))), 'EXTRA_NOT_ALLOWED', '已取消');
  assert.equal((await docOf(f, 'tokens/04')).state, 'available', '牌不被占');

  const old = await placeOrder(f, { tokenNumber: 5 });
  await admin().doc(`stores/${f.storeId}/orders/${old.result.orderId}`).update({ businessDate: '2000-01-01' });
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, extraFor(old, 'char_siew', 5))), 'EXTRA_NOT_ALLOWED', '昨天的单');
  assert.equal(await countDocs(f.storeId, 'orders'), 2);
});

test('加料行只能走下单后加料：普通下单带加料行、带 forLineId、和加单 / 同牌加单同时指定都被拒', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 6 });
  const a = bowl.result.orderId;
  const reject = async (o: OrderOptions) => f.cashier.code('createOrder', orderPayload(f, o));
  assert.equal(await reject({ tokenNumber: 7, lines: [{ config: extraConfig('char_siew'), quantity: 1 }], expectedTotalSen: 200 }), 'INVALID_MODIFIER');
  assert.equal(await reject({ tokenNumber: 6, joinTokenOrderId: a, lines: [{ config: extraConfig('char_siew'), quantity: 1 }], expectedTotalSen: 200 }), 'INVALID_MODIFIER', '同牌加单也不收加料行');
  assert.equal(await reject({ tokenNumber: 7, lines: [{ config: noodle(), quantity: 1, forLineId: bowlLine(bowl) }] }), 'INVALID_ARGUMENT');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 6, { addOnToOrderId: a })), 'INVALID_ARGUMENT');
  assert.equal(await reject(extraFor(bowl, 'char_siew', 6, { joinTokenOrderId: a })), 'INVALID_ARGUMENT');
  assert.equal(await countDocs(f.storeId, 'orders'), 1);
});

test('下单后加料：响应丢失后重试，只有一张小单', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 12 });
  const placed = await placeOrder(f, extraFor(bowl, 'char_siew', 12));
  const again = await f.cashier.call<{ orderId: string; receiptNumber: string; replayed: boolean }>('createOrder', placed.payload);
  assert.deepEqual([again.orderId, again.receiptNumber, again.replayed], [placed.result.orderId, placed.result.receiptNumber, true]);
  assert.equal(await countDocs(f.storeId, 'orders'), 2);
  assert.equal(await countDocs(f.storeId, 'kitchenTickets'), 2);
  assert.equal(await countDocs(f.storeId, 'costEvents'), 2);
  assert.deepEqual((await docOf(f, 'tokens/12')).orderIds, [bowl.result.orderId, placed.result.orderId]);
});

test('牌上只剩加料时再点一碗：新的一碗排队尾，不沾加料的位置；账仍并', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 13 });
  const a = bowl.result.orderId;
  await placeOrder(f, { tokenNumber: 14 });
  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  const x = (await placeOrder(f, extraFor(bowl, 'char_siew', 13))).result;

  const b = (await placeOrder(f, { tokenNumber: 13, joinTokenOrderId: a })).result;
  assert.deepEqual([b.sharedToken, b.queueInherited, b.addOnToOrderId], [true, false, a]);
  const ticket = await docOf(f, `kitchenTickets/${b.orderId}`);
  assert.deepEqual([ticket.queueAtMs, ticket.queueGroupId, ticket.extraOnly], [undefined, undefined, undefined]);
  assert.deepEqual((await docOf(f, 'tokens/13')).orderIds, [x.orderId, b.orderId]);

  // 指着加料小单同牌加单：账单组长也不是小单
  const c = (await placeOrder(f, { tokenNumber: 13, joinTokenOrderId: x.orderId })).result;
  assert.equal(c.addOnToOrderId, a);
  assert.equal((await docOf(f, `orders/${c.orderId}`)).extraOnly, undefined);
});

test('那碗和加料都出餐，牌才释放；一起收款', async () => {
  const f = await setupStore();
  const bowl = await placeOrder(f, { tokenNumber: 15 });
  const a = bowl.result.orderId;
  const x = (await placeOrder(f, extraFor(bowl, 'wanton_3', 15))).result;

  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  const still = await docOf(f, 'tokens/15');
  assert.deepEqual([still.state, still.orderIds], ['held', [x.orderId]], '只摘那碗，牌继续占用');
  await f.kitchen.call('serveOrder', lifecycle(f, x.orderId, 1));
  const freed = await docOf(f, 'tokens/15');
  assert.deepEqual([freed.state, freed.orderId, freed.orderIds, freed.lastReleasedOrderId], ['available', null, [], x.orderId]);
  assert.equal((await docOf(f, `orders/${x.orderId}`)).fulfillmentStatus, 'served');

  const paid = await f.cashier.call<{ amountSen: number }>('recordGroupPayment', {
    storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: a, amountSen: 700 }, { orderId: x.orderId, amountSen: 200 }],
  });
  assert.equal(paid.amountSen, 900);
});

test('下单后加料：厨单记着给哪一张单，后厨才分得清同桌哪一碗出了', async () => {
  const f = await setupStore();
  const a = (await placeOrder(f, { tokenNumber: 30 })).result;
  const lineId = (await admin().doc(`stores/${f.storeId}/orders/${a.orderId}`).get()).data()!.items[0].lineId as string;
  const extra = (await placeOrder(f, {
    tokenNumber: 30, extraForOrderId: a.orderId, expectedTotalSen: 200,
    lines: [{ config: extraConfig('char_siew'), quantity: 1, forLineId: lineId }],
  })).result;
  const t = (await admin().doc(`stores/${f.storeId}/kitchenTickets/${extra.orderId}`).get()).data()!;
  assert.deepEqual([t.extraOnly, t.extraForOrderId], [true, a.orderId]);
});

test('下单后加料换过号：这张牌上再同牌加单，仍并进这桌的账单', async () => {
  const f = await setupStore();
  const a = (await placeOrder(f, { tokenNumber: 31 })).result;
  const lineId = (await admin().doc(`stores/${f.storeId}/orders/${a.orderId}`).get()).data()!.items[0].lineId as string;
  await f.kitchen.call('serveOrder', lifecycle(f, a.orderId, 1));
  await placeOrder(f, { tokenNumber: 31 }); // 31 号给了别的客人
  const x = (await placeOrder(f, { tokenNumber: 32, extraForOrderId: a.orderId, expectedTotalSen: 200, lines: [{ config: extraConfig('wanton_3'), quantity: 1, forLineId: lineId }] })).result;
  const c = (await placeOrder(f, { tokenNumber: 32, joinTokenOrderId: x.orderId })).result;
  assert.deepEqual([c.sharedToken, c.addOnToOrderId], [true, a.orderId]);
});
