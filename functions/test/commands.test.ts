/**
 * Emulator 命令集成测试：真实 Auth 身份 → Callable（asia-southeast1）→ Functions 事务 → Firestore。
 * 覆盖：下单即送厨（无付款流水）→ 厨房确认 → 出餐自动释放餐牌 → 同牌新单 → 旧单补登记收款；
 * 以及幂等、并发、越权、篡改，收款独立登记、取消与成本、撤回不抢牌、跨日收款（DESIGN 2026-10-23 §11）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { collection, doc, getDoc, getDocs } from 'firebase/firestore';
import {
  admin, cleanupClients, countDocs, newClient, noodle, orderPayload, pay, payPayload, placeOrder, setupStore, uuid,
} from './harness';
import { BOM_V1, defaultConfig, MENU_V1, normalizeConfig } from '../../src/domain';

after(cleanupClients);

const lifecycle = (f: { storeId: string }, orderId: string, expectedVersion: number, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, operationId: uuid(), orderId, expectedVersion, ...extra,
});

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
  assert.equal(cost.totalCostUnits, 11170);
  assert.equal((await s('tokens/18').get()).data()!.state, 'held');
  assert.equal((await s('registers/front-01').get()).data()!.lastAppliedSequence, 1);

  // 后厨读取真实网络响应：厨房投影无金额/成本/付款
  const ticketSnap = await getDoc(doc(f.kitchen.db, `stores/${f.storeId}/kitchenTickets/${orderId}`));
  const raw = JSON.stringify(ticketSnap.data());
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
  assert.equal((await s(`orderCosts/${p}`).get()).data()!.allocatedCostUnits, 2 * 425 + 3 * 220 + 1200 + 500, '已消耗成本保留');
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
  // 原单已收款：不能再挂加单
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 8, addOnToOrderId: root.orderId })), 'ADD_ON_NOT_ALLOWED');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 8, addOnToOrderId: uuid() })), 'NOT_FOUND');
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
