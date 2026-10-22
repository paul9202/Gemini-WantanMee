/**
 * 阶段 E Emulator 测试：账本 → 关账快照；写屏障与并发（F11）；关账后迟到离线单与更正版本（D13）；
 * 老板处理离线待核对；进货作废与更正；越权。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, cleanupClients, countDocs, noodle, orderPayload, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { costUnitsToSen, DEFAULT_FIXED_COST, fixedCostForDate, MENU_V1 } from '../../src/domain';

after(cleanupClients);

const doc = (f: StoreFixture, p: string) => admin().doc(`stores/${f.storeId}/${p}`).get().then((s) => s.data());
const lc = (f: StoreFixture, orderId: string, expectedVersion: number, extra: Record<string, unknown> = {}) => ({ storeId: f.storeId, operationId: uuid(), orderId, expectedVersion, ...extra });
const cash = (tenderedSen: number) => ({ method: 'cash' as const, tenderedSen, qrConfirmed: false });

function offlineEvent(f: StoreFixture, sequence: number, payload: Record<string, unknown>, type = 'offline_order_created', atMs = Date.now()) {
  return {
    eventId: uuid(), registerId: f.claim.registerId, deviceId: f.claim.deviceId, registerEpoch: f.claim.registerEpoch, sequence, shiftId: f.shiftId,
    type, occurredAtDeviceMs: atMs, lastServerOffsetMs: 0, payload,
  };
}
const offlineOrder = (orderId: string, tokenNumber: number, extra: Record<string, unknown> = {}) => ({
  clientOrderId: orderId, offlineReceiptNumber: `O-F01-${tokenNumber}`, tokenNumber, serviceMode: 'dine_in', menuVersion: MENU_V1.version,
  lines: [{ lineId: uuid(), config: noodle(), quantity: 1 }], totalSen: 700,
  payment: { method: 'cash', tenderedSen: 1000, qrExternalVerificationNote: null }, ...extra,
});
async function sync(f: StoreFixture, events: ReturnType<typeof offlineEvent>[]) {
  const r = await f.cashier.call<{ results: { status: string; reasonCode?: string; eventId: string }[] }>('syncOfflineEvents', { storeId: f.storeId, events });
  for (const [i, x] of r.results.entries()) if (x.status !== 'blocked') f.seq.value = Math.max(f.seq.value, events[i].sequence);
  return r.results;
}

test('F01–F06 一整天账本 → 关账：每个数字可核对；已耗材损耗不重复扣；作废支出不计；QR 不进钱箱', async () => {
  const f = await setupStore();
  const a = await placeOrder(f, { tokenNumber: 1, payment: cash(1000) }); // 小 700 现金
  const b = await placeOrder(f, { tokenNumber: 2, lines: [{ config: noodle({ size: 'medium' }), quantity: 1 }], expectedTotalSen: 900, payment: { method: 'qr_manual', tenderedSen: null, qrConfirmed: true } });
  const c = await placeOrder(f, { tokenNumber: 3, lines: [{ config: noodle({ size: 'large' }), quantity: 1 }], expectedTotalSen: 1100, payment: cash(1100) });
  const d = await placeOrder(f, { tokenNumber: 4, payment: cash(700) });
  // C：制作中取消（已耗材，成本保留）→ 老板现金退款
  await f.kitchen.call('startOrder', lc(f, c.result.orderId, 1));
  await f.cashier.call('requestCancel', lc(f, c.result.orderId, 2, { reason: '顾客离开' }));
  await f.kitchen.call('confirmKitchenCancel', lc(f, c.result.orderId, 3));
  await f.owner.call('confirmFullRefund', lc(f, c.result.orderId, 4, { amountSen: 1100, refundMethod: 'cash', reason: '现金已退' }));
  // D：待做取消（成本反转）→ 现金退款
  await f.cashier.call('requestCancel', lc(f, d.result.orderId, 1, { reason: '点错' }));
  await f.owner.call('confirmFullRefund', lc(f, d.result.orderId, 2, { amountSen: 700, refundMethod: 'cash', reason: '现金已退' }));
  // 支出：营业费 500、进货 3000 从钱箱付；一条录错后作废并更正
  await f.owner.call('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'opex', description: '煤气', amountSen: 500, paid: true, paymentSource: 'drawer' });
  const wrong = await f.owner.call<{ id: string }>('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'purchase', description: '面球（录错）', amountSen: 30000, paid: true, paymentSource: 'drawer' });
  assert.equal(await f.owner.code('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'purchase', description: '更正', amountSen: 3000, paid: true, paymentSource: 'drawer', correctionOf: wrong.id }), 'INVALID_TRANSITION', '未作废不能登记更正');
  await f.owner.call('voidLedgerEntry', { storeId: f.storeId, operationId: uuid(), kind: 'expense', id: wrong.id, reason: '金额多打一个零' });
  await f.owner.call('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'purchase', description: '面球', amountSen: 3000, paid: true, paymentSource: 'drawer', correctionOf: wrong.id });
  // 损耗：关联已耗材取消单（不重复扣）+ 掉落 1 个面球
  const w1 = await f.owner.call<{ alreadyAllocated: boolean }>('recordWastage', { storeId: f.storeId, operationId: uuid(), noodleHalfUnits: 4, wantonCount: 4, charSiewPortions: 1, reason: 'other', note: 'C 单取消', linkedOrderId: c.result.orderId });
  assert.equal(w1.alreadyAllocated, true);
  const w2 = await f.owner.call<{ alreadyAllocated: boolean; costUnits: number }>('recordWastage', { storeId: f.storeId, operationId: uuid(), noodleHalfUnits: 2, wantonCount: 0, charSiewPortions: 0, reason: 'dropped' });
  assert.deepEqual([w2.alreadyAllocated, w2.costUnits], [false, 850]);
  assert.equal(await f.owner.code('recordWastage', { storeId: f.storeId, operationId: uuid(), noodleHalfUnits: 0, wantonCount: 0, charSiewPortions: 0, reason: 'dropped' }), 'INVALID_ARGUMENT');
  // 收银不能记账
  assert.equal(await f.cashier.code('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'opex', description: 'x', amountSen: 1, paid: true, paymentSource: 'drawer' }), 'FORBIDDEN');

  const date = a.result.businessDate;
  // 有例外（餐牌待回收/未出餐）时不确认不能关账
  const base = { storeId: f.storeId, businessDate: date, countedCashSen: 7000, qrBankConfirmedSen: 900, note: '少两块' };
  assert.equal(await f.owner.code('closeBusinessDay', { ...base, operationId: uuid(), acknowledgeExceptions: false }), 'CLOSE_EXCEPTIONS');
  assert.equal(await f.cashier.code('closeBusinessDay', { ...base, operationId: uuid(), acknowledgeExceptions: true, exceptionReason: '结转' }), 'FORBIDDEN');
  const closed = await f.owner.call<{ version: number; figures: any; exceptions: any }>('closeBusinessDay', { ...base, operationId: uuid(), acknowledgeExceptions: true, exceptionReason: 'A、B 单明早继续，餐牌已登记' });
  const s = closed.figures.summary;
  assert.equal(closed.version, 1);
  assert.deepEqual([s.receipts.cashSen, s.receipts.qrSen, s.refunds.cashSen], [2500, 900, 1800]);
  assert.equal(s.netReceiptsSen, 1600);
  assert.equal(s.allocatedCostUnits, 3210 + 3635 + 4280, '待做取消的 D 单成本已反转');
  assert.equal(s.wastageCostUnits, 850, '已耗材的取消单损耗不重复扣');
  assert.equal(s.wastageAlreadyAllocatedCount, 1);
  assert.equal(s.otherOpexSen, 500);
  assert.equal(s.cash.purchasesPaidSen, 3000, '作废的 30000 不计');
  const fixed = fixedCostForDate(DEFAULT_FIXED_COST, date);
  assert.equal(s.fixedCostSen, fixed);
  assert.equal(s.estimatedProfitSen, 1600 - costUnitsToSen(11125 + 850) - fixed - 500);
  assert.equal(closed.figures.expectedCashSen, 10000 + 2500 - 1800 - 500 - 3000);
  assert.equal(closed.figures.cashDiffSen, -200);
  assert.equal(closed.figures.qrDiffSen, 0);
  assert.ok(closed.exceptions.unfinishedOrders.some((o: { id: string }) => o.id === a.result.orderId));
  // 快照落库且不可写；关账后写屏障
  const v1 = (await doc(f, `dailyReports/${date}/versions/1`))!;
  assert.equal(v1.figures.cashDiffSen, -200);
  assert.equal((await doc(f, `businessDays/${date}`))!.state, 'closed');
  assert.equal(await f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 9 })), 'DAY_CLOSED');
  assert.equal(await f.owner.code('recordExpense', { storeId: f.storeId, operationId: uuid(), category: 'opex', description: '迟到', amountSen: 100, paid: true, paymentSource: 'drawer' }), 'DAY_CLOSED');
  assert.equal(await f.owner.code('closeBusinessDay', { ...base, operationId: uuid(), acknowledgeExceptions: true, exceptionReason: '重复' }), 'DAY_CLOSED');
  // 出餐不是记账：关账后仍可完成昨天的单
  await f.kitchen.call('serveOrder', lc(f, a.result.orderId, 1));
  void b;
});

test('F11 关账与下单并发：新单要么被包含在快照里，要么被拒绝，不会被静默遗漏', async () => {
  for (let round = 0; round < 3; round++) {
    const f = await setupStore();
    const first = await placeOrder(f, { tokenNumber: 1 });
    const date = first.result.businessDate;
    const [orderCode, closeRes] = await Promise.all([
      f.cashier.code('createOrder', orderPayload(f, { tokenNumber: 2 })),
      f.owner.call<{ figures: any }>('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: date, countedCashSen: 0, qrBankConfirmedSen: 0, acknowledgeExceptions: true, exceptionReason: '并发测试' }),
    ]);
    const payments = await countDocs(f.storeId, 'payments');
    const inSnapshot = closeRes.figures.summary.receipts.totalSen / 700;
    if (orderCode === 'OK') assert.equal(inSnapshot, 2, `第 ${round} 轮：新单已提交，应在快照中`);
    else {
      assert.equal(orderCode, 'DAY_CLOSED');
      assert.equal(inSnapshot, 1);
    }
    assert.equal(payments, inSnapshot, '账本与快照一致');
  }
});

test('D13 关账后迟到的离线单：老板补入账 → 关账后待调整；更正版本 2 包含，版本 1 不变', async () => {
  const f = await setupStore();
  const first = await placeOrder(f, { tokenNumber: 1 });
  const date = first.result.businessDate;
  // 断网时收的 RM7 已经在钱箱里：实点 11400，版本 1 显示「多 RM7」
  const v1res = await f.owner.call<{ figures: any }>('closeBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: date, countedCashSen: 11400, qrBankConfirmedSen: 0, acknowledgeExceptions: true, exceptionReason: '1 号单未出餐' });
  assert.equal(v1res.figures.cashDiffSen, 700);
  const late = offlineEvent(f, f.seq.value + 1, offlineOrder(uuid(), 5));
  const r = await sync(f, [late]);
  assert.equal(r[0].reasonCode, 'DAY_CLOSED_LATE');
  assert.equal(await f.cashier.code('resolveOfflineReview', { storeId: f.storeId, operationId: uuid(), eventId: late.eventId, action: 'import', reason: '断网时收的现金' }), 'FORBIDDEN');
  const res = await f.owner.call<{ postCloseAdjustment: boolean; orderId: string }>('resolveOfflineReview', { storeId: f.storeId, operationId: uuid(), eventId: late.eventId, action: 'import', reason: '断网时收的现金，钱在钱箱' });
  assert.equal(res.postCloseAdjustment, true);
  assert.equal((await doc(f, `businessDays/${date}`))!.pendingAdjustments, 1);
  assert.equal((await doc(f, `orders/${res.orderId}`))!.tokenLock, 'history_only');
  assert.equal((await doc(f, `dailyReports/${date}/versions/1`))!.figures.summary.receipts.cashSen, 700, '版本 1 不变');
  assert.equal(await f.owner.code('restateBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: date, reason: '' }), 'INVALID_ARGUMENT');
  const v2 = await f.owner.call<{ version: number; restates: number; figures: any }>('restateBusinessDay', { storeId: f.storeId, operationId: uuid(), businessDate: date, reason: '补入断网单 O-F01-5' });
  assert.deepEqual([v2.version, v2.restates], [2, 1]);
  assert.equal(v2.figures.summary.receipts.cashSen, 1400);
  assert.equal(v2.figures.cashDiffSen, 0, '沿用原实点现金，补入后差额归零');
  assert.equal((await doc(f, `dailyReports/${date}/versions/1`))!.figures.summary.receipts.cashSen, 700);
  assert.equal((await doc(f, `dailyReports/${date}`))!.latestVersion, 2);
  assert.equal((await doc(f, `businessDays/${date}`))!.pendingAdjustments, 0);
});

test('待核对处理：餐牌冲突只补历史账；金额不符按实收入账；QR 须确认到账；菜单未知只能不入账；依附事件随后补上', async () => {
  const f = await setupStore();
  const online = await placeOrder(f, { tokenNumber: 9 });
  let seq = f.seq.value;
  const tokenConflictId = uuid();
  const priceId = uuid();
  const qrId = uuid();
  const events = [
    offlineEvent(f, ++seq, offlineOrder(tokenConflictId, 9)),
    offlineEvent(f, ++seq, { clientOrderId: tokenConflictId }, 'manual_served'),
    offlineEvent(f, ++seq, offlineOrder(priceId, 10, { totalSen: 600, payment: { method: 'cash', tenderedSen: 600, qrExternalVerificationNote: null } })),
    offlineEvent(f, ++seq, offlineOrder(qrId, 11, { payment: { method: 'qr_manual', tenderedSen: null, qrExternalVerificationNote: null } })),
    offlineEvent(f, ++seq, offlineOrder(uuid(), 12, { menuVersion: 'menu-unknown' })),
  ];
  const r = await sync(f, events);
  assert.deepEqual(r.map((x) => x.reasonCode), ['TOKEN_CONFLICT', 'DEPENDS_ON_REVIEW', 'PRICE_MISMATCH', 'PAYMENT_UNVERIFIED', 'MENU_UNKNOWN']);
  const resolve = (eventId: string, action: string, extra: Record<string, unknown> = {}) =>
    f.owner.code('resolveOfflineReview', { storeId: f.storeId, operationId: uuid(), eventId, action, reason: '老板已核对实体牌与钱箱', ...extra });
  assert.equal(await resolve(events[1].eventId, 'import'), 'REVIEW_NOT_ALLOWED', '先处理所属订单');
  assert.equal(await resolve(events[0].eventId, 'import'), 'OK');
  const tok = (await doc(f, 'tokens/09'))!;
  assert.equal(tok.orderId, online.result.orderId, '不抢占当前牌锁');
  assert.equal(await resolve(events[1].eventId, 'import'), 'OK');
  assert.equal((await doc(f, `orders/${tokenConflictId}`))!.fulfillmentStatus, 'served');
  assert.equal(await resolve(events[2].eventId, 'import'), 'OK');
  const price = (await doc(f, `orders/${priceId}`))!;
  assert.deepEqual([price.totalSen, price.priceVarianceSen], [600, -100]);
  assert.equal((await doc(f, `payments/${priceId}-p1`))!.amountSen, 600, '按实际收到的钱入账');
  assert.equal(await resolve(events[3].eventId, 'import'), 'REVIEW_NOT_ALLOWED');
  assert.equal(await resolve(events[3].eventId, 'import', { confirmPaymentReceived: true }), 'OK');
  assert.equal(await resolve(events[4].eventId, 'import'), 'REVIEW_NOT_ALLOWED');
  assert.equal(await resolve(events[4].eventId, 'dismiss'), 'OK');
  assert.equal(await resolve(events[4].eventId, 'dismiss'), 'INVALID_TRANSITION', '已处理不能重复处理');
  assert.equal((await doc(f, `offlineInbox/${events[4].eventId}`))!.resolution, 'dismissed');
  assert.equal(await countDocs(f.storeId, 'offlineInbox', 'status', 'needs_review'), 0);
});
