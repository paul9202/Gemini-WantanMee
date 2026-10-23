/**
 * 04 §3 在线场景中可在领域层验证的部分：O06–O10、幂等与厨房投影隔离；
 * 以及 2026-10-23 营业流程改版（DESIGN §11）：下单即制作中、出餐 / 取消自动释放餐牌、收款独立登记。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, applyLifecycle, buildKitchenTicket, canonicalJson, checkPayment, createTokenBoard, decideOperation,
  defaultConfig, emptyCart, holdToken, isAwaitingPayment, KitchenTicket, LifecycleContext, MENU_V1, newAcceptedState,
  normalizeConfig, OrderLifecycleState, payloadHash, registerPayment, releaseHeldToken, releaseToken, reholdToken, reversePayment,
  sortFifo, suggestNextToken, summarizeKitchen, TOKEN_MAX, TokenBoard, UNDO_SERVE_WINDOW_MS, writeOffUnpaid, reinstateWrittenOff,
} from './index';

const menu = MENU_V1;
const accepted = (): OrderLifecycleState => newAcceptedState({ acceptedAtMs: 1_000, kitchenRouting: 'digital' });
const paidOrder = (totalSen = 900): OrderLifecycleState => {
  const r = registerPayment(accepted(), { amountSen: totalSen, orderTotalSen: totalSen });
  assert.ok(r.ok);
  return r.state;
};

test('旧格式离线日志的收款核对仍可用：现金不足 / QR 未核对被拒', () => {
  const ok = checkPayment({ method: 'cash', dueSen: 1800, tenderedSen: 2000, qrConfirmed: false, qrExternalVerificationNote: null }, { online: false, qrConfigured: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.changeSen, 200);
  assert.deepEqual(checkPayment({ method: 'cash', dueSen: 1800, tenderedSen: 1500, qrConfirmed: false, qrExternalVerificationNote: null }, { online: false, qrConfigured: true }).blocks, ['CASH_INSUFFICIENT']);
  const qr = { method: 'qr_manual' as const, dueSen: 900, tenderedSen: null, qrExternalVerificationNote: null };
  assert.deepEqual(checkPayment({ ...qr, qrConfirmed: true }, { online: false, qrConfigured: true }).blocks, ['QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION']);
});

test('§11-1 无付款记录也可下单：电子单直接制作中（自动开始），待收款；人工单仍待做', () => {
  const s = newAcceptedState({ acceptedAtMs: 5_000, kitchenRouting: 'digital' });
  assert.equal(s.fulfillmentStatus, 'preparing');
  assert.equal(s.startedAtMs, 5_000);
  assert.equal(s.startedSource, 'auto', '自动来源，不冒充人工开工');
  assert.equal(s.paymentState, 'unpaid');
  assert.equal(s.paidSen, 0);
  assert.ok(isAwaitingPayment(s));
  const manual = newAcceptedState({ acceptedAtMs: 5_000, kitchenRouting: 'manual' });
  assert.equal(manual.fulfillmentStatus, 'queued');
  assert.equal(manual.startedSource, null);
  const legacy = newAcceptedState({ acceptedAtMs: 5_000, kitchenRouting: 'manual', legacyPaidSen: 1800 });
  assert.equal(legacy.paymentState, 'paid', '旧格式离线日志下单即收款，按原事实导入');
  assert.equal(legacy.paidSen, 1800);
});

test('§11-2/6 先登记后出餐、先出餐后登记都完整；出餐不标付款；收款不改制作版本', () => {
  // 先登记
  const early = registerPayment(accepted(), { amountSen: 900, orderTotalSen: 900 });
  assert.ok(early.ok);
  assert.equal(early.state.version, 1, '收款不让后厨的出餐操作过期');
  const servedAfter = applyLifecycle(early.state, { type: 'serve' }, ctx());
  assert.ok(servedAfter.ok);
  assert.equal(servedAfter.state.paymentState, 'paid');
  // 先出餐
  const served = applyLifecycle(accepted(), { type: 'serve' }, ctx());
  assert.ok(served.ok);
  assert.equal(served.state.paymentState, 'unpaid', '出餐不推断为已付款');
  assert.ok(isAwaitingPayment(served.state));
  const late = registerPayment(served.state, { amountSen: 900, orderTotalSen: 900 });
  assert.ok(late.ok);
  assert.equal(late.state.fulfillmentStatus, 'served');
  assert.equal(late.state.paidSen, 900);
});

test('§11-5 收款只能全额登记一次；取消单 / 取消待确认 / 金额不符不能登记', () => {
  const once = paidOrder(900);
  const again = registerPayment(once, { amountSen: 900, orderTotalSen: 900 });
  assert.equal(!again.ok && again.error, 'ALREADY_PAID');
  assert.equal((() => { const r = registerPayment(accepted(), { amountSen: 800, orderTotalSen: 900 }); return r.ok ? 'ok' : r.error; })(), 'AMOUNT_MISMATCH');
  const req = applyLifecycle(accepted(), { type: 'request_cancel', reason: '打错' }, ctx({ actorRole: 'cashier', actorUid: 'c1' }));
  assert.ok(req.ok);
  assert.equal((() => { const r = registerPayment(req.state, { amountSen: 900, orderTotalSen: 900 }); return r.ok ? 'ok' : r.error; })(), 'CANCEL_PENDING');
  const done = applyLifecycle(req.state, { type: 'confirm_kitchen_cancel', consumed: false }, ctx({ expectedVersion: 2 }));
  assert.ok(done.ok);
  assert.equal((() => { const r = registerPayment(done.state, { amountSen: 900, orderTotalSen: 900 }); return r.ok ? 'ok' : r.error; })(), 'ORDER_CANCELLED');
});

test('误登记更正：回到待收款、不是退款；已退款不能更正；取消单更正后无需收款', () => {
  const r = reversePayment(paidOrder());
  assert.ok(r.ok);
  assert.equal(r.state.paymentState, 'unpaid');
  assert.equal(r.state.refundedSen, 0);
  assert.equal(reversePayment(accepted()).ok, false, '未付款不能更正');
  const req = applyLifecycle(paidOrder(), { type: 'request_cancel', reason: 'x' }, ctx({ actorRole: 'cashier' }));
  assert.ok(req.ok);
  const cancelled = applyLifecycle(req.state, { type: 'confirm_kitchen_cancel', consumed: true }, ctx({ expectedVersion: 2 }));
  assert.ok(cancelled.ok);
  assert.equal(cancelled.state.paymentState, 'refund_due');
  const fix = reversePayment(cancelled.state);
  assert.ok(fix.ok);
  assert.equal(fix.state.paymentState, 'not_due');
});

test('餐牌：循环建议下一个可用牌；全满返回 null', () => {
  let board = createTokenBoard();
  assert.equal(suggestNextToken(board, null), 1);
  assert.equal(suggestNextToken(board, 50), 1);
  board = holdToken(board, 19, 'o19').ok ? (holdToken(board, 19, 'o19') as { board: typeof board }).board : board;
  assert.equal(suggestNextToken(board, 18), 20, '跳过占用牌');
  for (let n = 1; n <= TOKEN_MAX; n++) {
    const r = holdToken(board, n, `o${n}`);
    if (r.ok) board = r.board;
  }
  assert.equal(suggestNextToken(board, 10), null);
});

const must = (r: { ok: boolean; board?: TokenBoard } | null): TokenBoard => {
  assert.ok(r && r.ok);
  return (r as { board: TokenBoard }).board;
};

test('§11-3 出餐即自动释放餐牌；未出餐的牌不可被新单占用；只释放仍属于本单的牌', () => {
  let board = must(holdToken(createTokenBoard(), 18, 'A'));
  assert.equal(holdToken(board, 18, 'B').ok, false, '仍在制作中：同牌不能有两张有效电子单');
  assert.ok(holdToken(board, 18, 'A').ok, '同一订单重复占牌幂等');
  board = must(releaseHeldToken(board, 18, 'A'));
  assert.equal(board[18].state, 'available');
  assert.equal(board[18].lastReleasedOrderId, 'A');
  board = must(holdToken(board, 18, 'C'));
  assert.equal(releaseHeldToken(board, 18, 'A'), null, '旧单重试出餐不能释放已属于新单的牌');
  assert.equal(board[18].orderId, 'C');
});

test('旧版待回收牌：仍可由前台逐张明确释放；未出餐的不能普通回收', () => {
  const legacy: TokenBoard = { ...createTokenBoard(), 7: { number: 7, state: 'awaiting_return', orderId: 'OLD', version: 3 } };
  assert.equal(releaseToken(legacy, 7, 'OTHER').ok, false);
  const ok = releaseToken(legacy, 7, 'OLD');
  assert.ok(ok.ok);
  const held = must(holdToken(createTokenBoard(), 8, 'A'));
  assert.equal(releaseToken(held, 8, 'A').ok, false);
});

test('餐牌版本冲突：过期版本被拒绝', () => {
  const r = holdToken(createTokenBoard(), 3, 'A', 5);
  assert.equal(!r.ok && r.error, 'STALE_VERSION');
});

const ctx = (patch: Partial<LifecycleContext> = {}): LifecycleContext => ({
  nowMs: 1_000_000, actorUid: 'k1', actorRole: 'kitchen', expectedVersion: 1, tokenReclaimable: true, dayClosed: false, ...patch,
});

test('O07 过期版本操作被拒绝，单次生效', () => {
  const s = accepted();
  const first = applyLifecycle(s, { type: 'serve' }, ctx());
  assert.ok(first.ok);
  const second = applyLifecycle(first.state, { type: 'serve' }, ctx({ actorUid: 'k2', expectedVersion: 1 }));
  assert.equal(!second.ok && second.error, 'STALE_VERSION');
  const third = applyLifecycle(first.state, { type: 'serve' }, ctx({ expectedVersion: 2 }));
  assert.equal(!third.ok && third.error, 'INVALID_TRANSITION');
});

test('开始制作只剩旧版待做单可用；新单已制作中不能再开始', () => {
  assert.equal(applyLifecycle(accepted(), { type: 'start' }, ctx()).ok, false);
  const legacyQueued: OrderLifecycleState = { ...accepted(), fulfillmentStatus: 'queued', startedAtMs: null, startedSource: null };
  const r = applyLifecycle(legacyQueued, { type: 'start' }, ctx());
  assert.ok(r.ok);
  assert.equal(r.state.startedSource, 'manual');
});

test('O08 30 秒内撤回：恢复制作中与原自动开始时间，重新占回原牌；不反转收款', () => {
  const served = applyLifecycle(paidOrder(), { type: 'serve' }, ctx({ nowMs: 5_000 }));
  assert.ok(served.ok);
  assert.deepEqual(served.effects, ['token_release', 'kitchen_projection_update']);
  const undo = applyLifecycle(served.state, { type: 'undo_serve' }, ctx({ nowMs: 5_000 + UNDO_SERVE_WINDOW_MS - 1, expectedVersion: 2 }));
  assert.ok(undo.ok);
  assert.equal(undo.state.fulfillmentStatus, 'preparing');
  assert.equal(undo.state.startedAtMs, 1_000);
  assert.equal(undo.state.paymentState, 'paid', '出餐撤回不反转已确认的收款');
  assert.deepEqual(undo.effects, ['token_rehold', 'kitchen_projection_update']);
  assert.equal(applyLifecycle(undo.state, { type: 'undo_serve' }, ctx({ expectedVersion: 3 })).ok, false);
});

test('O09/§11-9 撤回超时 / 牌已复用 / 已关账 / 非原操作者：拒绝，不抢牌', () => {
  const served = applyLifecycle(accepted(), { type: 'serve' }, ctx({ nowMs: 0 }));
  assert.ok(served.ok);
  const e = (c: Partial<LifecycleContext>) => {
    const r = applyLifecycle(served.state, { type: 'undo_serve' }, ctx({ expectedVersion: 2, nowMs: 10_000, ...c }));
    return r.ok ? 'ok' : r.error;
  };
  assert.equal(e({ nowMs: UNDO_SERVE_WINDOW_MS }), 'UNDO_WINDOW_EXPIRED');
  assert.equal(e({ tokenReclaimable: false }), 'TOKEN_REASSIGNED');
  assert.equal(e({ dayClosed: true }), 'DAY_CLOSED');
  assert.equal(e({ actorUid: 'other-kitchen' }), 'FORBIDDEN');
  assert.equal(e({ actorUid: 'boss', actorRole: 'owner' }), 'ok');
  // 牌层面：出餐释放后被新单占用（甚至新单已出餐再释放），旧单都不能重新占回。
  let board = must(holdToken(createTokenBoard(), 7, 'A'));
  board = must(releaseHeldToken(board, 7, 'A'));
  assert.ok(reholdToken(board, 7, 'A').ok, '原牌空闲且未被复用：可重新占回');
  board = must(holdToken(board, 7, 'B'));
  assert.equal((() => { const r = reholdToken(board, 7, 'A'); return r.ok ? 'ok' : r.error; })(), 'TOKEN_REASSIGNED');
  board = must(releaseHeldToken(board, 7, 'B'));
  assert.equal(reholdToken(board, 7, 'A').ok, false, '牌空闲但期间给过别的单：仍不恢复');
});

test('§11-3/7/8 取消：申请期间继续占牌且不能出餐；后厨确认「未做」反转成本、「已消耗」保留；成立即释放牌；未付不退款', () => {
  const req = applyLifecycle(accepted(), { type: 'request_cancel', reason: '打错' }, ctx({ actorRole: 'cashier', actorUid: 'c1' }));
  assert.ok(req.ok);
  assert.equal(req.state.fulfillmentStatus, 'preparing');
  assert.equal(req.state.kitchenCancelRequested, true);
  assert.ok(!req.effects.includes('token_release'), '取消待确认期间不提前释放牌');
  assert.equal(applyLifecycle(req.state, { type: 'serve' }, ctx({ expectedVersion: 2 })).ok, false, '取消待确认不能当普通完成');

  const notMade = applyLifecycle(req.state, { type: 'confirm_kitchen_cancel', consumed: false }, ctx({ expectedVersion: 2 }));
  assert.ok(notMade.ok);
  assert.equal(notMade.state.fulfillmentStatus, 'cancelled');
  assert.equal(notMade.state.costAllocated, false);
  assert.ok(notMade.effects.includes('cost_reverse'));
  assert.ok(notMade.effects.includes('token_release'));
  assert.equal(notMade.state.paymentState, 'not_due', '未付款取消：不退款，也不再待收');
  assert.equal(isAwaitingPayment(notMade.state), false);

  const consumed = applyLifecycle(req.state, { type: 'confirm_kitchen_cancel', consumed: true }, ctx({ expectedVersion: 2 }));
  assert.ok(consumed.ok);
  assert.equal(consumed.state.costAllocated, true, '已消耗成本保留');
  assert.ok(!consumed.effects.includes('cost_reverse'));
  assert.ok(consumed.effects.includes('token_release'));

  // 已付款取消：应退款；实际退款登记后才完成。
  const paidReq = applyLifecycle(paidOrder(), { type: 'request_cancel', reason: '顾客离开' }, ctx({ actorRole: 'cashier' }));
  assert.ok(paidReq.ok);
  const paidCancel = applyLifecycle(paidReq.state, { type: 'confirm_kitchen_cancel', consumed: false }, ctx({ expectedVersion: 2 }));
  assert.ok(paidCancel.ok);
  assert.equal(paidCancel.state.paymentState, 'refund_due', '取消不等于已退款');
  const refund = applyLifecycle(paidCancel.state, { type: 'confirm_full_refund', amountSen: 900 }, ctx({ actorRole: 'owner', expectedVersion: 3 }));
  assert.ok(refund.ok);
  assert.equal(refund.state.paymentState, 'refunded');
  // 未付款取消的单不能登记退款。
  assert.equal(applyLifecycle(notMade.state, { type: 'confirm_full_refund', amountSen: 900 }, ctx({ actorRole: 'owner', expectedVersion: 3 })).ok, false);

  // 旧版 / 人工待做单：立即取消，成立即释放牌。
  const queued = newAcceptedState({ acceptedAtMs: 0, kitchenRouting: 'manual' });
  const now = applyLifecycle(queued, { type: 'request_cancel', reason: 'x' }, ctx({ actorRole: 'cashier' }));
  assert.ok(now.ok);
  assert.deepEqual(now.effects, ['cost_reverse', 'token_release', 'kitchen_projection_update']);
});

test('出餐后整单退款：保留出餐与成本；只有老板；必须全额', () => {
  const served = applyLifecycle(paidOrder(1800), { type: 'serve' }, ctx());
  assert.ok(served.ok);
  assert.equal(applyLifecycle(served.state, { type: 'request_cancel', reason: 'x' }, ctx({ actorRole: 'cashier', expectedVersion: 2 })).ok, false);
  const partial = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 900 }, ctx({ actorRole: 'owner', expectedVersion: 2 }));
  assert.equal(!partial.ok && partial.error, 'REFUND_MUST_BE_FULL');
  assert.equal((() => { const r = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 1800 }, ctx({ actorRole: 'cashier', expectedVersion: 2 })); return r.ok ? 'ok' : r.error; })(), 'FORBIDDEN');
  const refund = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 1800 }, ctx({ actorRole: 'owner', expectedVersion: 2 }));
  assert.ok(refund.ok);
  assert.equal(refund.state.fulfillmentStatus, 'served', '保留真实出餐历史');
  assert.equal(refund.state.costAllocated, true);
  assert.equal(applyLifecycle(refund.state, { type: 'confirm_full_refund', amountSen: 0 }, ctx({ actorRole: 'owner', expectedVersion: 3 })).ok, false);
});

test('权限：后厨不能取消/退款，收银不能出餐', () => {
  const s = accepted();
  assert.equal(applyLifecycle(s, { type: 'request_cancel', reason: 'x' }, ctx()).ok, false);
  assert.equal(applyLifecycle(s, { type: 'serve' }, ctx({ actorRole: 'cashier' })).ok, false);
});

function ticket(id: string, at: number, status: KitchenTicket['fulfillmentStatus'], lines: { cfg: ReturnType<typeof defaultConfig>; q: number }[], routing: KitchenTicket['kitchenRouting'] = 'digital', cancelRequested = false) {
  return buildKitchenTicket(menu, {
    orderId: id, tokenNumber: 1, serviceMode: 'dine_in', kitchenRouting: routing, fulfillmentStatus: status, kitchenCancelRequested: cancelRequested,
    acceptedAtEffectiveMs: at, startedAtMs: status === 'preparing' ? at : null, startedSource: status === 'preparing' ? 'auto' : null,
    servedAtMs: null, timeQuality: 'server', businessDate: '2026-10-22', version: 1,
    lines: lines.map((l, i) => ({ lineId: `${id}-${i}`, config: l.cfg, quantity: l.q })),
  });
}

test('O10/§11-1 顶部合计包括全部有效未出餐电子单（新单都是制作中）；取消待确认冻结；人工单与已出餐不计', () => {
  const thinMed = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'black'), size: 'medium' });
  const pohSmall = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'red'), noodleType: 'mee_poh' });
  const kosong = normalizeConfig(menu, { ...defaultConfig(menu, 'soup_noodle'), isKosong: true });
  const ws15 = normalizeConfig(menu, { ...defaultConfig(menu, 'wanton_soup'), size: 'w15' });
  const tickets = [
    ticket('A', 3, 'preparing', [{ cfg: thinMed, q: 2 }, { cfg: kosong, q: 1 }]),
    ticket('B', 1, 'preparing', [{ cfg: pohSmall, q: 1 }]),
    ticket('C', 2, 'queued', [{ cfg: ws15, q: 1 }]),
    ticket('D', 0, 'queued', [{ cfg: thinMed, q: 5 }], 'manual'),
    ticket('E', 0, 'served', [{ cfg: thinMed, q: 5 }]),
    ticket('F', 4, 'preparing', [{ cfg: thinMed, q: 9 }], 'digital', true),
  ];
  const { active, cancelPending, manualPending } = summarizeKitchen(tickets);
  assert.equal(active.orders, 3, '全部制作中的新单 + 旧版待做单都计入，不会显示 0');
  assert.equal(active.portions, 5);
  assert.equal(active.thinEggHalfUnits, 3 * 2 + 2, '2×中(1.5) + Kosong 小(1) 细面');
  assert.equal(active.meePohHalfUnits, 2);
  assert.equal(active.wantons, 2 * 3 + 0 + 3 + 15);
  assert.equal(active.kosong, 1);
  assert.deepEqual(active.sauce, { black: 2, white: 0, red: 1 });
  assert.equal(active.soupNoodle, 1);
  assert.equal(active.wantonSoup, 1);
  assert.equal(cancelPending, 1, '取消待确认单单独列出，不计入合计');
  assert.equal(manualPending, 1);
  assert.deepEqual(sortFifo(tickets).map((t) => t.orderId), ['D', 'E', 'B', 'C', 'A', 'F'], '等得最久在前');
});

test('厨房投影不含售价、付款、成本字段', () => {
  const cfg = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle'), addOns: ['char_siew'], note: '分开装' });
  const t = ticket('X', 0, 'preparing', [{ cfg, q: 2 }]);
  const json = JSON.stringify(t);
  assert.ok(!/sen|cost|price|paid|payment|refund|amount/i.test(json), json);
  assert.equal(t.lines[0].photoId, 'dish.dry_noodle.black');
  assert.ok(t.lines[0].pictograms.some((p) => p.id === 'addon:char_siew'));
  assert.equal(t.startedSource, 'auto');
});

test('O03 幂等：同 operationId 同 payload 返回原结果，不同 payload 冲突', async () => {
  const cart = addLine(menu, emptyCart(), defaultConfig(menu, 'dry_noodle'), 'l1');
  const payload = { clientOrderId: 'o-1', tokenNumber: 18, cart };
  const h1 = await payloadHash(payload);
  const h2 = await payloadHash(JSON.parse(JSON.stringify({ tokenNumber: 18, cart, clientOrderId: 'o-1' })));
  assert.equal(h1, h2, '键顺序不影响 hash');
  const record = { operationId: 'op-1', payloadHash: h1, result: { orderId: 'o-1', paymentId: 'p-1' } };
  for (let i = 0; i < 10; i++) {
    const d = decideOperation(record, h2);
    assert.equal(d.kind, 'replay');
    assert.deepEqual(d.kind === 'replay' && d.result, { orderId: 'o-1', paymentId: 'p-1' });
  }
  const changed = await payloadHash({ ...payload, tokenNumber: 19 });
  assert.equal(decideOperation(record, changed).kind, 'conflict');
  assert.equal(decideOperation(undefined, h1).kind, 'new');
  assert.throws(() => canonicalJson({ a: Number.NaN }));
});

test('放弃追收：仅待收款有效单；不是已付款；之后须先恢复待收款才能登记；取消待确认 / 已付 / 已取消不行', () => {
  const served = applyLifecycle(accepted(), { type: 'serve' }, ctx());
  assert.ok(served.ok);
  const w = writeOffUnpaid(served.state);
  assert.ok(w.ok);
  assert.equal(w.state.paymentState, 'written_off');
  assert.equal(w.state.paidSen, 0, '不计实收');
  assert.equal(w.state.costAllocated, true, '不动成本');
  assert.equal(isAwaitingPayment(w.state), false, '退出待登记收款');
  assert.equal((() => { const r = registerPayment(w.state, { amountSen: 900, orderTotalSen: 900 }); return r.ok ? 'ok' : r.error; })(), 'WRITTEN_OFF');
  assert.equal(writeOffUnpaid(w.state).ok, false, '不能重复放弃');
  const back = reinstateWrittenOff(w.state);
  assert.ok(back.ok);
  assert.equal(back.state.paymentState, 'unpaid');
  assert.ok(registerPayment(back.state, { amountSen: 900, orderTotalSen: 900 }).ok);
  assert.equal(writeOffUnpaid(paidOrder()).ok, false);
  const req = applyLifecycle(accepted(), { type: 'request_cancel', reason: 'x' }, ctx({ actorRole: 'cashier' }));
  assert.ok(req.ok);
  assert.equal((() => { const r = writeOffUnpaid(req.state); return r.ok ? 'ok' : r.error; })(), 'CANCEL_PENDING');
  assert.equal(reinstateWrittenOff(accepted()).ok, false);
});

test('后厨「继续做，拒绝取消」：结束申请、恢复可出餐；不改付款、不释放牌；无申请时不能拒绝；收银不能拒绝', () => {
  const req = applyLifecycle(accepted(), { type: 'request_cancel', reason: '打错' }, ctx({ actorRole: 'cashier' }));
  assert.ok(req.ok);
  assert.equal(applyLifecycle(req.state, { type: 'reject_cancel' }, ctx({ actorRole: 'cashier', expectedVersion: 2 })).ok, false);
  const rej = applyLifecycle(req.state, { type: 'reject_cancel' }, ctx({ expectedVersion: 2 }));
  assert.ok(rej.ok);
  assert.deepEqual(rej.effects, ['kitchen_projection_update'], '不释放牌、不退款、不动成本');
  assert.deepEqual([rej.state.fulfillmentStatus, rej.state.kitchenCancelRequested, rej.state.paymentState, rej.state.cancelReason], ['preparing', false, 'unpaid', null]);
  assert.ok(registerPayment(rej.state, { amountSen: 900, orderTotalSen: 900 }).ok, '拒绝后可正常登记收款');
  const served = applyLifecycle(rej.state, { type: 'serve' }, ctx({ expectedVersion: 3 }));
  assert.ok(served.ok, '拒绝后可正常出餐');
  assert.equal(applyLifecycle(accepted(), { type: 'reject_cancel' }, ctx()).ok, false);
});
