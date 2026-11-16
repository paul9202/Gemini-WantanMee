/**
 * 后厨改单 / 后厨直接取消（2026-11-16）Emulator 测试：真实身份 → Callable → 事务 → Firestore。
 * 覆盖：后厨改没收钱的单（订单、厨单原位、成本差额、记录）、收银也能改、版本 / 已出餐 / 没改动 / 金额不对被拒、
 * 收过钱改金额（冲掉原收款 cause=amend、回到待收款、记住已付多少、按新金额再收后提示清掉）、收过钱只改口味不动钱、
 * 后厨直接取消（未付不用收、牌释放、成本冲掉；已付应退款；收银不能用）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, cleanupClients, noodle, pay, placeOrder, setupStore, StoreFixture, uuid } from './harness';
import { defaultConfig, MENU_V1, normalizeConfig, registeredBreakdown } from '../../src/domain';
import type { PaymentDoc } from '../../src/domain/ledger';

after(cleanupClients);

const docOf = async (f: StoreFixture, p: string) => (await admin().doc(`stores/${f.storeId}/${p}`).get()).data();
const soup = normalizeConfig(MENU_V1, defaultConfig(MENU_V1, 'wanton_soup'));
const dryWanton = normalizeConfig(MENU_V1, defaultConfig(MENU_V1, 'dry_wanton'));
type L = { lineId: string; config: unknown; quantity: number; serviceMode: 'dine_in' | 'takeaway' };
const amendArgs = (f: StoreFixture, orderId: string, expectedVersion: number, lines: L[], expectedTotalSen: number, extra: Record<string, unknown> = {}) => ({
  storeId: f.storeId, operationId: uuid(), orderId, expectedVersion, menuVersion: MENU_V1.version, lines, expectedTotalSen, ...extra,
});
type AmendResult = { version: number; fromTotalSen: number; totalSen: number; paymentReversedSen: number; priorPaidSen: number | null; summary: string };

/** 红酱 / 黑酱面 ×2（a）+ 云吞汤（b）= RM21。 */
async function twoBowlsAndSoup(f: StoreFixture, tokenNumber: number, paid = false) {
  const { result } = await placeOrder(f, {
    tokenNumber, paid,
    lines: [{ lineId: 'a', config: noodle(), quantity: 2 }, { lineId: 'b', config: soup, quantity: 1 }], expectedTotalSen: 2100,
  });
  return result.orderId;
}

test('后厨改没收钱的单：订单、厨单原位换内容、成本差额、改单记录；之后按新金额收款', async () => {
  const f = await setupStore();
  const id = await twoBowlsAndSoup(f, 7);
  const before = (await docOf(f, `kitchenTickets/${id}`))!;
  const costBefore = (await docOf(f, `orderCosts/${id}`))!.allocatedCostUnits as number;

  const lines: L[] = [
    { lineId: 'a', config: noodle({ size: 'large', noodleType: 'mee_poh' }), quantity: 1, serviceMode: 'dine_in' },
    { lineId: 'b', config: soup, quantity: 1, serviceMode: 'dine_in' },
    { lineId: 'c', config: dryWanton, quantity: 1, serviceMode: 'dine_in' },
  ];
  const r = await f.kitchen.call<AmendResult>('amendOrder', amendArgs(f, id, 1, lines, 2500));
  assert.deepEqual([r.version, r.fromTotalSen, r.totalSen, r.paymentReversedSen, r.priorPaidSen], [2, 2100, 2500, 0, null]);
  assert.equal(r.summary, '黑酱面 · 大 2→1 碗 小→大 细面→面薄；加 干捞云吞 · 10粒');

  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([o.totalSen, o.version, o.amendCount, o.paymentState, o.items.length, o.fulfillmentStatus, o.tokenNumber], [2500, 2, 1, 'unpaid', 3, 'preparing', 7]);
  assert.deepEqual([o.lastAmend.role, o.lastAmend.fromTotalSen, o.lastAmend.toTotalSen, o.amendHistory.length], ['kitchen', 2100, 2500, 1]);

  const t = (await docOf(f, `kitchenTickets/${id}`))!;
  assert.deepEqual([t.totalSen, t.version, t.lines.length, t.amendCount, t.amendedByRole], [2500, 2, 3, 1, 'kitchen']);
  assert.deepEqual(t.amendMarks, { a: 'mod', c: 'add' });
  assert.equal(t.acceptedAtEffectiveMs, before.acceptedAtEffectiveMs, '接单时间不变：不排到最后');
  assert.equal(t.lines[0].noodleType, 'mee_poh');

  const cost = (await docOf(f, `orderCosts/${id}`))!;
  const ev = (await admin().collection(`stores/${f.storeId}/costEvents`).where('orderId', '==', id).get()).docs.map((d) => d.data()).find((d) => String(d.id).endsWith('-amend'))!;
  assert.equal(ev.costUnits, (cost.allocatedCostUnits as number) - costBefore, '成本按差额补一笔');

  // 收银按新金额收款；旧金额被拒。
  assert.equal(await f.cashier.code('recordPayment', { storeId: f.storeId, operationId: uuid(), ...f.claim, orderId: id, amountSen: 2100 }), 'AMOUNT_MISMATCH');
  await pay(f, id, 2500);
  assert.equal((await docOf(f, `orders/${id}`))!.paymentState, 'paid');
});

test('改单被拒：版本过期、没改动、金额不对、删光、已出餐；收银也能改', async () => {
  const f = await setupStore();
  const id = await twoBowlsAndSoup(f, 8);
  const same: L[] = [{ lineId: 'a', config: noodle(), quantity: 2, serviceMode: 'dine_in' }, { lineId: 'b', config: soup, quantity: 1, serviceMode: 'dine_in' }];
  assert.equal(await f.kitchen.code('amendOrder', amendArgs(f, id, 1, same, 2100)), 'NOTHING_CHANGED');
  const less: L[] = [same[0], { ...same[1], quantity: 2 }];
  assert.equal(await f.kitchen.code('amendOrder', amendArgs(f, id, 1, less, 2100)), 'PRICE_MISMATCH');
  assert.equal(await f.kitchen.code('amendOrder', amendArgs(f, id, 1, [], 0)), 'INVALID_ARGUMENT');
  const r = await f.cashier.call<AmendResult>('amendOrder', amendArgs(f, id, 1, less, 2800));
  assert.equal(r.version, 2);
  assert.equal(await f.kitchen.code('amendOrder', amendArgs(f, id, 1, same, 2100)), 'STALE_VERSION');
  // 撤回 = 带改前内容再改一次。
  const undo = await f.kitchen.call<AmendResult>('amendOrder', amendArgs(f, id, 2, same, 2100, { undo: true }));
  assert.deepEqual([undo.version, undo.totalSen], [3, 2100]);
  assert.equal((await docOf(f, `orders/${id}`))!.lastAmend.undo, true);

  await f.kitchen.call('serveOrder', { storeId: f.storeId, operationId: uuid(), orderId: id, expectedVersion: 3 });
  assert.equal(await f.kitchen.code('amendOrder', amendArgs(f, id, 4, less, 2800)), 'AMEND_NOT_ALLOWED');
});

test('收过钱改金额：冲掉原收款（amend）、回到待收款、记住已付多少；按新金额收齐后提示清掉；日结不算两单', async () => {
  const f = await setupStore();
  const id = await twoBowlsAndSoup(f, 9, true);
  assert.equal((await docOf(f, `kitchenTickets/${id}`))!.paidBeforeServe, true);
  const fewer: L[] = [{ lineId: 'a', config: noodle(), quantity: 1, serviceMode: 'dine_in' }, { lineId: 'b', config: soup, quantity: 1, serviceMode: 'dine_in' }];
  const r = await f.kitchen.call<AmendResult>('amendOrder', amendArgs(f, id, 1, fewer, 1400));
  assert.deepEqual([r.paymentReversedSen, r.priorPaidSen, r.totalSen], [2100, 2100, 1400]);

  const rev = (await docOf(f, `payments/${id}-p1-rev`))!;
  assert.deepEqual([rev.kind, rev.cause, rev.amountSen, rev.reversesPaymentId], ['reversal', 'amend', -2100, `${id}-p1`]);
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([o.paymentState, o.paidSen, o.amendPriorPaidSen, o.totalSen], ['unpaid', 0, 2100, 1400]);
  const t = (await docOf(f, `kitchenTickets/${id}`))!;
  assert.deepEqual([t.paidBeforeServe, t.priorPaidSen], [false, 2100], '后厨卡片不再写「已付」，写客人已付多少');

  await pay(f, id, 1400);
  const paid = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([paid.paymentState, paid.paidSen, paid.amendPriorPaidSen], ['paid', 1400, null]);
  const pays = (await admin().collection(`stores/${f.storeId}/payments`).where('orderId', '==', id).get()).docs.map((d) => d.data() as PaymentDoc);
  const b = registeredBreakdown(pays);
  assert.deepEqual([b.manualCount, b.manualSen, b.correctionsSen], [1, 1400, 0]);
});

test('收过钱只改口味（金额不变）：钱不动', async () => {
  const f = await setupStore();
  const id = await twoBowlsAndSoup(f, 10, true);
  const spicy: L[] = [{ lineId: 'a', config: noodle({ spice: 'none' }), quantity: 2, serviceMode: 'dine_in' }, { lineId: 'b', config: soup, quantity: 1, serviceMode: 'dine_in' }];
  const r = await f.kitchen.call<AmendResult>('amendOrder', amendArgs(f, id, 1, spicy, 2100));
  assert.deepEqual([r.paymentReversedSen, r.priorPaidSen], [0, null]);
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([o.paymentState, o.paidSen], ['paid', 2100]);
  assert.equal((await docOf(f, `kitchenTickets/${id}`))!.paidBeforeServe, true);
});

test('后厨直接取消：未付不用收、牌释放、成本冲掉；已付应退款；收银不能用', async () => {
  const f = await setupStore();
  const id = await twoBowlsAndSoup(f, 11);
  const args = (orderId: string, consumed: boolean) => ({ storeId: f.storeId, operationId: uuid(), orderId, expectedVersion: 1, reason: '客人不要了', consumed });
  assert.equal(await f.cashier.code('kitchenCancelOrder', args(id, false)), 'FORBIDDEN');
  const r = await f.kitchen.call<{ fulfillmentStatus: string; paymentState: string }>('kitchenCancelOrder', args(id, false));
  assert.deepEqual([r.fulfillmentStatus, r.paymentState], ['cancelled', 'not_due']);
  const o = (await docOf(f, `orders/${id}`))!;
  assert.deepEqual([o.cancelReason, o.cancelCostDecision, o.cancelledBy.role, o.costAllocated], ['客人不要了', 'not_made', 'kitchen', false]);
  assert.equal((await docOf(f, 'tokens/11'))!.state, 'available', '牌空出来');
  assert.equal((await docOf(f, `kitchenTickets/${id}`))!.fulfillmentStatus, 'cancelled');
  assert.equal((await docOf(f, `orderCosts/${id}`))!.allocatedCostUnits, 0);

  const paidId = await twoBowlsAndSoup(f, 12, true);
  const p = await f.kitchen.call<{ paymentState: string }>('kitchenCancelOrder', args(paidId, true));
  assert.equal(p.paymentState, 'refund_due', '已付：照旧由老板在订单页退款');
  assert.equal((await docOf(f, `orders/${paidId}`))!.costAllocated, true, '已经下锅：成本照算');
});
