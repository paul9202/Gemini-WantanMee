/**
 * 出餐即记收款（门店开关 payOnServe）Emulator 测试：真实身份 → Callable → 事务 → Firestore。
 * 覆盖：老板开关、出餐自动记收款（流水 p1 auto_on_serve、订单字段、结果 autoPaidSen）、已付 / 金额 0 / 当天关账不记、
 * 30 秒内撤回一起冲正（cause=undo_serve）、更正后人工收款撤回不动、与前台并发只一笔、ALREADY_PAID 说明来源、
 * 合并收款仍全有或全无、客人没付就走了（冲正 + 放弃追收一次完成）、厨单「已付 · 不用收」、
 * 离线人工出餐自动记、离线收款确认升级为前台确认（收银早于出餐时提示核对）、老板核对补入人工出餐自动记。
 * 其余测试文件里开关保持缺省关，原有「出餐不标已付款」用例照旧。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { doc, getDoc } from 'firebase/firestore';
import { admin, cleanupClients, countDocs, noodle, pay, payPayload, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { MENU_V1 } from '../../src/domain';

after(cleanupClients);

const lifecycle = (f: { storeId: string }, orderId: string, expectedVersion: number) => ({ storeId: f.storeId, operationId: uuid(), orderId, expectedVersion });
const docOf = async (f: StoreFixture, p: string) => (await admin().doc(`stores/${f.storeId}/${p}`).get()).data();
const setPayOnServe = (f: StoreFixture, enabled: boolean) => f.owner.call<{ enabled: boolean }>('setPayOnServe', { storeId: f.storeId, operationId: uuid(), enabled });

async function storeWithPayOnServe() {
  const f = await setupStore();
  await setPayOnServe(f, true);
  return f;
}

type ServeResult = { paymentState: string; autoPaidSen: number; fulfillmentStatus: string; version: number };
type UndoResult = { paymentState: string; autoPaymentReversedSen: number; fulfillmentStatus: string };

/** 调用并返回 HttpsError.details（成功时返回 null）。 */
async function details(c: StoreFixture['cashier'], name: string, data: unknown): Promise<Record<string, unknown> | null> {
  try {
    await c.call(name, data);
    return null;
  } catch (e: any) {
    return e?.details ?? { error: String(e) };
  }
}

test('开关：只有老板能开关；写在 config/public，缺省关；关着时出餐不记收款', async () => {
  const f = await setupStore();
  assert.equal((await docOf(f, 'config/public'))!.payOnServe, undefined, '缺省没有字段 = 关');
  const off = (await placeOrder(f, { tokenNumber: 3 })).result.orderId;
  const served = await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, off, 1));
  assert.deepEqual([served.paymentState, served.autoPaidSen], ['unpaid', 0], '关着：出餐不标已付款');
  assert.equal(await countDocs(f.storeId, 'payments'), 0);

  const args = { storeId: f.storeId, operationId: uuid(), enabled: true };
  assert.equal(await f.cashier.code('setPayOnServe', args), 'FORBIDDEN');
  assert.equal(await f.kitchen.code('setPayOnServe', args), 'FORBIDDEN');
  assert.equal(await f.owner.code('setPayOnServe', { ...args, operationId: uuid(), enabled: 'yes' }), 'INVALID_ARGUMENT');
  const r = await f.owner.call<{ enabled: boolean }>('setPayOnServe', { ...args, reason: '平板都更新了' });
  assert.equal(r.enabled, true);
  const cfg = (await docOf(f, 'config/public'))!;
  assert.deepEqual([cfg.payOnServe, cfg.payOnServeUpdatedBy, typeof cfg.payOnServeUpdatedAtMs], [true, f.owner.uid, 'number']);
  assert.equal(cfg.name, '豪云吞面', 'merge：不动其它配置');
  const audit = (await docOf(f, `auditEvents/${args.operationId}`))!;
  assert.deepEqual([audit.entityId, audit.before.payOnServe, audit.after.payOnServe], ['config/public', false, true]);
  await setPayOnServe(f, false);
  assert.equal((await docOf(f, 'config/public'))!.payOnServe, false);
});

test('出餐即记收款：收款流水 p1（auto_on_serve、不经收银机）、订单付款字段、结果 autoPaidSen；厨单仍是要收钱', async () => {
  const f = await storeWithPayOnServe();
  const { result } = await placeOrder(f, { tokenNumber: 5, lines: [{ config: noodle(), quantity: 2 }], expectedTotalSen: 1400 });
  const id = result.orderId;
  const ticket = (await getDoc(doc(f.kitchen.db, `stores/${f.storeId}/kitchenTickets/${id}`))).data()!;
  assert.deepEqual([ticket.totalSen, ticket.paidBeforeServe], [1400, false], '后厨卡片写金额');

  const served = await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, id, 1));
  assert.deepEqual([served.fulfillmentStatus, served.paymentState, served.autoPaidSen, served.version], ['served', 'paid', 1400, 2]);
  const p = (await docOf(f, `payments/${id}-p1`))!;
  assert.deepEqual(
    [p.kind, p.confirmationMode, p.method, p.amountSen, p.registerId, p.confirmedBy, p.source, p.businessDate, p.orderBusinessDate],
    ['payment', 'auto_on_serve', 'unspecified', 1400, null, f.kitchen.uid, 'serve', result.businessDate, result.businessDate],
  );
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual(
    [o.paymentState, o.paidSen, o.paymentId, o.paymentSeq, o.paymentBusinessDate, o.paymentConfirmedBy, o.paymentConfirmationMode, o.servePaymentId, o.fulfillmentStatus],
    ['paid', 1400, `${id}-p1`, 1, result.businessDate, f.kitchen.uid, 'auto_on_serve', `${id}-p1`, 'served'],
  );
  assert.equal(o.paidAtMs, o.servedAtMs, '收款时间 = 出餐时间');
  assert.equal((await docOf(f, 'tokens/05'))!.state, 'available', '出餐照常释放牌');
  const t = (await docOf(f, `kitchenTickets/${id}`))!;
  assert.deepEqual([t.fulfillmentStatus, t.paidBeforeServe], ['served', false], '自动记的不标「已付 · 不用收」');
  assert.ok((await docOf(f, `businessDays/${result.businessDate}`))!.lastActivityAtMs > 0, '记当日账本活动');
  const audit = (await admin().collection(`stores/${f.storeId}/auditEvents`).where('action', '==', 'serveOrder').get()).docs[0].data();
  assert.deepEqual([audit.after.paymentState, audit.after.autoPaidSen, audit.after.autoPaymentId], ['paid', 1400, `${id}-p1`]);
  // 后厨仍不能读订单或收款
  await assert.rejects(getDoc(doc(f.kitchen.db, `stores/${f.storeId}/payments/${id}-p1`)), /permission/i);
});

test('出餐即记收款：已付款的单不再记；金额为 0 不记；当天已关账出餐照常、留在待收款', async () => {
  const f = await storeWithPayOnServe();
  // 先在收银确认收款：厨单显示「已付 · 不用收」，出餐不新增流水
  const paid = (await placeOrder(f, { tokenNumber: 6, paid: true })).result;
  assert.equal((await docOf(f, `kitchenTickets/${paid.orderId}`))!.paidBeforeServe, true);
  const s1 = await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, paid.orderId, 1));
  assert.deepEqual([s1.paymentState, s1.autoPaidSen], ['paid', 0]);
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', paid.orderId), 1);
  const po = (await docOf(f, `orders/${paid.orderId}`))!;
  assert.deepEqual([po.paymentConfirmationMode, po.servePaymentId], ['manual', null]);

  // 金额 0（模拟）：不记
  const zero = (await placeOrder(f, { tokenNumber: 7 })).result.orderId;
  await admin().doc(`stores/${f.storeId}/orders/${zero}`).update({ totalSen: 0 });
  const s2 = await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, zero, 1));
  assert.deepEqual([s2.fulfillmentStatus, s2.paymentState, s2.autoPaidSen], ['served', 'unpaid', 0]);
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', zero), 0);

  // 当天关账中：出餐照常，不记收款
  const late = (await placeOrder(f, { tokenNumber: 8 })).result;
  await admin().doc(`stores/${f.storeId}/businessDays/${late.businessDate}`).update({ state: 'closing' });
  const s3 = await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, late.orderId, 1));
  assert.deepEqual([s3.fulfillmentStatus, s3.paymentState, s3.autoPaidSen], ['served', 'unpaid', 0], '钱的问题不让出餐失败');
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', late.orderId), 0);
  assert.equal((await docOf(f, 'tokens/08'))!.state, 'available');
});

test('撤回出餐：自动记的收款一起冲正（-rev，cause=undo_serve，记今天）；订单回到待收款、序号保留，下次人工登记是 p2', async () => {
  const f = await storeWithPayOnServe();
  const { result } = await placeOrder(f, { tokenNumber: 9 });
  const id = result.orderId;
  await f.kitchen.call<ServeResult>('serveOrder', lifecycle(f, id, 1));
  assert.equal(await f.cashier.code('undoServe', lifecycle(f, id, 2)), 'FORBIDDEN', '撤回权限不变');
  const undo = await f.kitchen.call<UndoResult>('undoServe', lifecycle(f, id, 2));
  assert.deepEqual([undo.fulfillmentStatus, undo.paymentState, undo.autoPaymentReversedSen], ['preparing', 'unpaid', 700]);
  const rev = (await docOf(f, `payments/${id}-p1-rev`))!;
  assert.deepEqual([rev.kind, rev.reversesPaymentId, rev.amountSen, rev.cause, rev.businessDate, rev.confirmedBy], ['reversal', `${id}-p1`, -700, 'undo_serve', result.businessDate, f.kitchen.uid]);
  assert.equal((await docOf(f, `payments/${id}-p1`))!.amountSen, 700, '原流水保留');
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual(
    [o.paymentState, o.paidSen, o.paymentId, o.paymentSeq, o.paymentConfirmationMode, o.servePaymentId, o.paidAtMs, o.fulfillmentStatus],
    ['unpaid', 0, null, 1, null, null, null, 'preparing'],
  );
  assert.equal((await docOf(f, 'tokens/09'))!.state, 'held', '牌挂回');
  assert.equal((await docOf(f, `kitchenTickets/${id}`))!.paidBeforeServe, false);
  const again = await pay(f, id, 700);
  assert.equal(again.paymentId, `${id}-p2`);
  assert.equal((await docOf(f, `payments/${id}-p2`))!.confirmationMode, 'manual');
  assert.equal((await docOf(f, `kitchenTickets/${id}`))!.paidBeforeServe, true, '出餐前确认收款：已付不用收');
});

test('撤回出餐：那笔已被老板更正、前台重新人工登记 → 撤回不动人工收款，只清掉过期关联', async () => {
  const f = await storeWithPayOnServe();
  const id = (await placeOrder(f, { tokenNumber: 10 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, id, 1));
  await f.owner.call('reversePayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '记错了' });
  const rev = (await docOf(f, `payments/${id}-p1-rev`))!;
  assert.equal(rev.cause, 'correction');
  const mid = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([mid.paymentState, mid.paymentConfirmationMode, mid.servePaymentId], ['unpaid', null, null]);
  await pay(f, id, 700);
  const undo = await f.kitchen.call<UndoResult>('undoServe', lifecycle(f, id, 2));
  assert.deepEqual([undo.paymentState, undo.autoPaymentReversedSen], ['paid', 0]);
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([o.paymentState, o.paymentId, o.paymentConfirmationMode, o.servePaymentId], ['paid', `${id}-p2`, 'manual', null]);
  assert.equal(await countDocs(f.storeId, 'payments', 'orderId', id), 3, 'p1、p1-rev、p2，没有多出冲正');

  // servePaymentId 还在但已不是当前收款（模拟旧数据）：撤回只清关联
  const b = (await placeOrder(f, { tokenNumber: 11, paid: true })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, b, 1));
  await admin().doc(`stores/${f.storeId}/orders/${b}`).update({ servePaymentId: `${b}-p9` });
  const u2 = await f.kitchen.call<UndoResult>('undoServe', lifecycle(f, b, 2));
  assert.deepEqual([u2.paymentState, u2.autoPaymentReversedSen], ['paid', 0]);
  assert.equal((await docOf(f, `orders/${b}`))!.servePaymentId, null);
});

test('出餐与前台确认收款同时发生：只有一笔收款；前台被拒时说明是出餐自动记的', async () => {
  const f = await storeWithPayOnServe();
  for (const n of [12, 13, 14]) {
    const id = (await placeOrder(f, { tokenNumber: n })).result.orderId;
    const [serve, payCode] = await Promise.all([
      f.kitchen.code('serveOrder', lifecycle(f, id, 1)),
      f.cashier.code('recordPayment', payPayload(f, id, 700)),
    ]);
    assert.equal(serve, 'OK', '出餐总是成功');
    assert.ok(['OK', 'ALREADY_PAID'].includes(payCode), payCode);
    assert.equal(await countDocs(f.storeId, 'payments', 'orderId', id), 1, '只一笔');
    const o = (await docOf(f, `orders/${id}`))!;
    assert.deepEqual([o.paymentState, o.paidSen, o.fulfillmentStatus], ['paid', 700, 'served']);
    assert.equal(o.paymentConfirmationMode, payCode === 'OK' ? 'manual' : 'auto_on_serve');
  }

  // 出餐已自动记 → 前台再确认：ALREADY_PAID，details 带来源
  const c = (await placeOrder(f, { tokenNumber: 15 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, c, 1));
  const d = (await details(f.cashier, 'recordPayment', payPayload(f, c, 700)))!;
  assert.deepEqual([d.reasonCode, d.orderId, d.tokenNumber, d.confirmationMode, d.paidSen], ['ALREADY_PAID', c, 15, 'auto_on_serve', 700]);
  // 人工确认过的：confirmationMode manual
  const m = (await placeOrder(f, { tokenNumber: 16, paid: true })).result.orderId;
  const dm = (await details(f.cashier, 'recordPayment', payPayload(f, m, 700)))!;
  assert.deepEqual([dm.reasonCode, dm.confirmationMode], ['ALREADY_PAID', 'manual']);
  // 旧单没有 paymentConfirmationMode 字段：按 manual
  await admin().doc(`stores/${f.storeId}/orders/${m}`).update({ paymentConfirmationMode: null });
  assert.equal((await details(f.cashier, 'recordPayment', payPayload(f, m, 700)))!.confirmationMode, 'manual');
});

test('合并收款仍是全有或全无：原单出餐已自动记收款 → 整组被拒（说明是哪一张），加单单独收', async () => {
  const f = await storeWithPayOnServe();
  const root = (await placeOrder(f, { tokenNumber: 17 })).result;
  const add = (await placeOrder(f, { tokenNumber: 17, joinTokenOrderId: root.orderId, lines: [{ config: noodle(), quantity: 2 }], expectedTotalSen: 1400 })).result;
  assert.equal(add.addOnToOrderId, root.orderId);
  await f.kitchen.call('serveOrder', lifecycle(f, root.orderId, 1));
  const group = { storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: add.orderId, amountSen: 1400 }, { orderId: root.orderId, amountSen: 700 }] };
  const d = (await details(f.cashier, 'recordGroupPayment', group))!;
  assert.deepEqual([d.reasonCode, d.orderId, d.confirmationMode, d.paidSen, d.tokenNumber], ['ALREADY_PAID', root.orderId, 'auto_on_serve', 700, 17]);
  assert.equal((await docOf(f, `orders/${add.orderId}`))!.paymentState, 'unpaid', '整组不写');
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  await pay(f, add.orderId, 1400);
  assert.equal((await docOf(f, `orders/${add.orderId}`))!.paymentConfirmationMode, 'manual');
  // 原单已收款仍可明确挂加单（客人吃完再加打包）
  const late = (await placeOrder(f, { tokenNumber: 18, addOnToOrderId: root.orderId, serviceMode: 'takeaway' })).result;
  assert.deepEqual([late.addOnToOrderId, late.paymentState], [root.orderId, 'unpaid']);
});

test('客人没付就走了：仅老板、须原因；一次完成冲正（cause=not_paid）+ 放弃追收；只一条操作记录', async () => {
  const f = await storeWithPayOnServe();
  const { result } = await placeOrder(f, { tokenNumber: 19 });
  const id = result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, id, 1));
  const args = { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '客人没付就走了' };
  assert.equal(await f.cashier.code('markNotPaid', args), 'FORBIDDEN');
  assert.equal(await f.kitchen.code('markNotPaid', args), 'FORBIDDEN');
  assert.equal(await f.owner.code('markNotPaid', { ...args, operationId: uuid(), reason: 'x' }), 'INVALID_ARGUMENT', '原因至少 2 字');
  const r = await f.owner.call<{ orderId: string; paymentState: string; reversalId: string; writeOffId: string }>('markNotPaid', args);
  assert.deepEqual([r.orderId, r.paymentState, r.reversalId, r.writeOffId], [id, 'written_off', `${id}-p1-rev`, `${id}-w1`]);
  const replay = await f.owner.call<{ replayed: boolean; paymentState: string }>('markNotPaid', args);
  assert.deepEqual([replay.replayed, replay.paymentState], [true, 'written_off']);

  const rev = (await docOf(f, `payments/${id}-p1-rev`))!;
  assert.deepEqual([rev.kind, rev.cause, rev.amountSen, rev.reversesPaymentId, rev.reason], ['reversal', 'not_paid', -700, `${id}-p1`, '客人没付就走了']);
  const wo = (await docOf(f, `paymentWriteOffs/${id}-w1`))!;
  assert.deepEqual([wo.kind, wo.amountSen, wo.recordedBy, wo.businessDate], ['write_off', 700, f.owner.uid, result.businessDate]);
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual(
    [o.paymentState, o.paidSen, o.paymentId, o.paymentSeq, o.paymentConfirmationMode, o.servePaymentId, o.writeOffSeq, o.writeOff.id, o.fulfillmentStatus],
    ['written_off', 0, null, 1, null, null, 1, `${id}-w1`, 'served'],
  );
  assert.equal(await countDocs(f.storeId, 'operations', 'type', 'markNotPaid'), 1);
  assert.equal(await countDocs(f.storeId, 'auditEvents', 'action', 'markNotPaid'), 1);
  assert.equal(await f.owner.code('markNotPaid', { ...args, operationId: uuid() }), 'NOT_PAID', '已放弃追收不能再来一次');
  assert.equal(await f.cashier.code('recordPayment', payPayload(f, id, 700)), 'WRITTEN_OFF');

  // 未付款、已退款、已取消都不行；不写任何东西
  const unpaid = (await placeOrder(f, { tokenNumber: 20 })).result.orderId;
  assert.equal(await f.owner.code('markNotPaid', { ...args, operationId: uuid(), orderId: unpaid }), 'NOT_PAID');
  const refunded = (await placeOrder(f, { tokenNumber: 21 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, refunded, 1));
  await f.owner.call('confirmFullRefund', { ...lifecycle(f, refunded, 2), amountSen: 700, reason: '已退还顾客' });
  assert.equal(await f.owner.code('markNotPaid', { ...args, operationId: uuid(), orderId: refunded }), 'NOT_PAID');
  assert.equal(await countDocs(f.storeId, 'paymentWriteOffs'), 1);
  assert.equal(await countDocs(f.storeId, 'payments', 'kind', 'reversal'), 1);
});

test('厨单「已付 · 不用收」：出餐前确认收款标上，出餐前更正收款改回；出餐后更正不动厨单（开关关着也一样）', async () => {
  const f = await setupStore();
  const id = (await placeOrder(f, { tokenNumber: 22 })).result.orderId;
  const ticket = async () => (await getDoc(doc(f.kitchen.db, `stores/${f.storeId}/kitchenTickets/${id}`))).data()!;
  assert.equal((await ticket()).paidBeforeServe, false);
  await pay(f, id, 700);
  assert.equal((await ticket()).paidBeforeServe, true);
  await f.owner.call('reversePayment', { storeId: f.storeId, operationId: uuid(), orderId: id, reason: '点错单' });
  assert.equal((await ticket()).paidBeforeServe, false, '更正后后厨又显示要收钱');
  assert.equal((await docOf(f, `payments/${id}-p1-rev`))!.cause, 'correction');
  // 合并收款也标上
  const a = (await placeOrder(f, { tokenNumber: 23 })).result.orderId;
  const b = (await placeOrder(f, { tokenNumber: 23, joinTokenOrderId: a })).result.orderId;
  await f.cashier.call('recordGroupPayment', { storeId: f.storeId, operationId: uuid(), ...f.claim, orders: [{ orderId: a, amountSen: 700 }, { orderId: b, amountSen: 700 }] });
  for (const x of [a, b]) assert.equal((await docOf(f, `kitchenTickets/${x}`))!.paidBeforeServe, true);
  // 出餐后才收款 / 更正：厨单已出餐，不改
  const c = (await placeOrder(f, { tokenNumber: 24 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, c, 1));
  await pay(f, c, 700);
  assert.equal((await docOf(f, `kitchenTickets/${c}`))!.paidBeforeServe, false);
});

test('撤回出餐：卡片回到队列时按撤回后的付款状态重算「已付 · 不用收」，不重收也不漏收', async () => {
  // 开关关着：出餐后 30 秒内前台收了钱，再撤回 → 卡片显示已付。
  const f = await setupStore();
  const a = (await placeOrder(f, { tokenNumber: 25 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, a, 1));
  await pay(f, a, 700);
  await f.kitchen.call('undoServe', lifecycle(f, a, 2));
  assert.equal((await docOf(f, `kitchenTickets/${a}`))!.paidBeforeServe, true, '已收钱：撤回后不要再收');
  // 出餐前已付 → 出餐 → 老板更正 → 撤回 → 卡片显示要收。
  const b = (await placeOrder(f, { tokenNumber: 26 })).result.orderId;
  await pay(f, b, 700);
  await f.kitchen.call('serveOrder', lifecycle(f, b, 1));
  await f.owner.call('reversePayment', { storeId: f.storeId, operationId: uuid(), orderId: b, reason: '点错单' });
  await f.kitchen.call('undoServe', lifecycle(f, b, 2));
  assert.equal((await docOf(f, `kitchenTickets/${b}`))!.paidBeforeServe, false, '收款已更正：撤回后要收');
  // 开关打开：自动记的收款随撤回冲正 → 卡片显示要收。
  await setPayOnServe(f, true);
  const c = (await placeOrder(f, { tokenNumber: 27 })).result.orderId;
  await f.kitchen.call('serveOrder', lifecycle(f, c, 1));
  const u = await f.kitchen.call<UndoResult>('undoServe', lifecycle(f, c, 2));
  assert.equal(u.autoPaymentReversedSen, 700);
  assert.equal((await docOf(f, `kitchenTickets/${c}`))!.paidBeforeServe, false);
});

// ---------- 离线 / 老板核对 ----------

type Ev = Record<string, unknown> & { eventId: string; sequence: number };

function events(f: StoreFixture) {
  let seq = f.seq.value;
  const base = (type: string, payload: Record<string, unknown>, atMs?: number): Ev => ({
    eventId: uuid(), registerId: f.claim.registerId, deviceId: f.claim.deviceId, registerEpoch: f.claim.registerEpoch,
    sequence: ++seq, shiftId: f.shiftId, type, occurredAtDeviceMs: atMs ?? Date.now(), lastServerOffsetMs: 0, payload,
  });
  return {
    create: (orderId: string, tokenNumber: number) => base('offline_order_created', {
      clientOrderId: orderId, offlineReceiptNumber: `O-T01-${String(seq + 1).padStart(4, '0')}`, tokenNumber, serviceMode: 'dine_in',
      menuVersion: MENU_V1.version, lines: [{ lineId: uuid(), config: noodle({ size: 'medium' }), quantity: 1 }], totalSen: 900, payment: null,
    }),
    paid: (orderId: string, amountSen = 900, atMs?: number) => base('offline_payment_recorded', { clientOrderId: orderId, amountSen }, atMs),
    served: (orderId: string, atMs?: number) => base('manual_served', { clientOrderId: orderId }, atMs),
  };
}

async function sync(f: StoreFixture, evs: Ev[]) {
  const r = await f.cashier.call<{ results: { eventId: string; status: string; reasonCode?: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events: evs });
  for (const x of r.results) if (x.status !== 'blocked') f.seq.value = Math.max(f.seq.value, evs.find((e) => e.eventId === x.eventId)!.sequence);
  return r.results;
}

test('离线人工出餐：开关打开时也自动记收款（出餐那天、来源 offline）；重复上传不重复记', async () => {
  const f = await storeWithPayOnServe();
  const ev = events(f);
  const a = uuid();
  const servedAt = Date.now() - 60_000;
  const batch = [ev.create(a, 7), ev.served(a, servedAt)];
  assert.deepEqual((await sync(f, batch)).map((r) => r.status), ['accepted', 'accepted']);
  assert.deepEqual((await sync(f, batch)).map((r) => r.status), ['accepted', 'accepted']);
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  const p = (await docOf(f, `payments/${a}-p1`))!;
  assert.deepEqual([p.confirmationMode, p.source, p.registerId, p.amountSen, p.occurredAtMs, p.offlineEventId], ['auto_on_serve', 'offline', null, 900, servedAt, batch[1].eventId]);
  const o = (await docOf(f, `orders/${a}`))!;
  assert.deepEqual([o.paymentState, o.fulfillmentStatus, o.servedManually, o.paymentConfirmationMode, o.servePaymentId, o.paymentBusinessDate], ['paid', 'served', true, 'auto_on_serve', `${a}-p1`, o.businessDate]);
});

test('离线收款确认碰上出餐已自动记：不重复入账，升级为前台确认；收银早于出餐时提示核对；金额不符照旧待核对', async () => {
  const f = await storeWithPayOnServe();
  const ev = events(f);
  const a = uuid();
  const b = uuid();
  const c = uuid();
  const now = Date.now();
  await sync(f, [ev.create(a, 3), ev.served(a, now - 30_000), ev.create(b, 4), ev.served(b, now - 30_000), ev.create(c, 5), ev.served(c, now - 30_000)]);
  assert.equal(await countDocs(f.storeId, 'payments'), 3);

  // a：收银在出餐之前就记了收款（离线上传晚到）→ 可能收了两次
  const r = await sync(f, [ev.paid(a, 900, now - 60_000), ev.paid(b, 900, now - 10_000), ev.paid(c, 100)]);
  // c 金额不符：照旧待核对（已付款的单先报 ALREADY_PAID）
  assert.deepEqual(r.map((x) => [x.status, x.reasonCode ?? null]), [['accepted', null], ['accepted', null], ['needs_review', 'ALREADY_PAID']]);
  assert.equal(await countDocs(f.storeId, 'payments'), 3, '不新增收款');
  const pa = (await docOf(f, `payments/${a}-p1`))!;
  assert.deepEqual([pa.confirmationMode, pa.upgradedFromAuto, pa.upgradedBy, pa.amountSen], ['manual', true, f.cashier.uid, 900]);
  const oa = (await docOf(f, `orders/${a}`))!;
  assert.deepEqual([oa.paymentConfirmationMode, oa.paymentConfirmedBy, oa.servePaymentId, oa.alsoCollectedBeforeServe, oa.paidSen], ['manual', f.cashier.uid, null, true, 900]);
  const ob = (await docOf(f, `orders/${b}`))!;
  assert.deepEqual([ob.paymentConfirmationMode, ob.alsoCollectedBeforeServe], ['manual', undefined], '出餐后才收：正常');
  assert.equal((await docOf(f, `orders/${c}`))!.paymentConfirmationMode, 'auto_on_serve');
  // 已升级为前台确认的再来一条：照旧待核对
  const again = await sync(f, [events(f).paid(a, 900)]);
  assert.deepEqual(again.map((x) => [x.status, x.reasonCode]), [['needs_review', 'ALREADY_PAID']]);
});

test('老板核对补入人工出餐：开关打开时记今天的自动收款（来源 review）；补入的收款确认同样升级', async () => {
  const f = await storeWithPayOnServe();
  const online = await placeOrder(f, { tokenNumber: 9 });
  const ev = events(f);
  const a = uuid();
  const created = ev.create(a, 9);
  assert.deepEqual((await sync(f, [created])).map((x) => x.reasonCode), ['TOKEN_CONFLICT']);
  const served = ev.served(a, Date.now() - 20_000);
  assert.deepEqual((await sync(f, [served])).map((x) => x.reasonCode), ['DEPENDS_ON_REVIEW']);
  const paidEv = ev.paid(a, 900, Date.now() - 40_000);
  assert.deepEqual((await sync(f, [paidEv])).map((x) => x.reasonCode), ['DEPENDS_ON_REVIEW']);
  const resolve = (eventId: string) => f.owner.call<{ resolution: string; businessDate?: string }>('resolveOfflineReview', { storeId: f.storeId, operationId: uuid(), eventId, action: 'import', reason: '老板核对过' });
  await resolve(created.eventId);
  assert.equal(await countDocs(f.storeId, 'payments'), 0);
  await resolve(served.eventId);
  const p = (await docOf(f, `payments/${a}-p1`))!;
  assert.deepEqual([p.confirmationMode, p.source, p.registerId, p.businessDate, p.confirmedBy], ['auto_on_serve', 'review', null, online.result.businessDate, f.owner.uid]);
  const o = (await docOf(f, `orders/${a}`))!;
  assert.deepEqual([o.paymentState, o.fulfillmentStatus, o.paymentConfirmationMode], ['paid', 'served', 'auto_on_serve']);
  // 收款确认（时间早于出餐）补入：升级，不新增
  const r = await resolve(paidEv.eventId);
  assert.equal(r.resolution, 'imported');
  assert.equal(await countDocs(f.storeId, 'payments'), 1);
  const o2 = (await docOf(f, `orders/${a}`))!;
  assert.deepEqual([o2.paymentConfirmationMode, o2.servePaymentId, o2.alsoCollectedBeforeServe], ['manual', null, true]);
  assert.equal((await docOf(f, `payments/${a}-p1`))!.upgradedFromAuto, true);
});
