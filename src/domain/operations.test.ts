/** 04 §3 在线场景中可在领域层验证的部分：O01/O02/O06–O10、D11、幂等与厨房投影隔离。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLine, applyLifecycle, buildKitchenTicket, canonicalJson, checkPayment, createTokenBoard, decideOperation,
  defaultConfig, emptyCart, holdToken, KitchenTicket, LifecycleContext, markAwaitingReturn, MENU_V1, newAcceptedState,
  normalizeConfig, payloadHash, quickTenderOptions, releaseToken, revertToHeld, sortFifo, suggestNextToken,
  summarizeKitchen, TOKEN_MAX, UNDO_SERVE_WINDOW_MS,
} from './index';

const menu = MENU_V1;

test('O01 现金应收 RM18、实收 RM20 → 找零 RM2；少收不能确认', () => {
  const ok = checkPayment({ method: 'cash', dueSen: 1800, tenderedSen: 2000, qrConfirmed: false, qrExternalVerificationNote: null }, { online: true, qrConfigured: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.changeSen, 200);
  const short = checkPayment({ method: 'cash', dueSen: 1800, tenderedSen: 1500, qrConfirmed: false, qrExternalVerificationNote: null }, { online: true, qrConfigured: true });
  assert.deepEqual(short.blocks, ['CASH_INSUFFICIENT']);
  const empty = checkPayment({ method: 'cash', dueSen: 1800, tenderedSen: null, qrConfirmed: false, qrExternalVerificationNote: null }, { online: true, qrConfigured: true });
  assert.deepEqual(empty.blocks, ['CASH_NOT_ENTERED']);
  assert.deepEqual(quickTenderOptions(1600), [1600, 2000, 5000, 10000]);
});

test('O02/D11 QR 只选方式不会到账；离线 QR 需外部核实说明', () => {
  const base = { method: 'qr_manual' as const, dueSen: 900, tenderedSen: null, qrExternalVerificationNote: null };
  assert.deepEqual(checkPayment({ ...base, qrConfirmed: false }, { online: true, qrConfigured: true }).blocks, ['QR_NOT_CONFIRMED']);
  assert.equal(checkPayment({ ...base, qrConfirmed: true }, { online: true, qrConfigured: true }).ok, true);
  assert.deepEqual(checkPayment({ ...base, qrConfirmed: true }, { online: false, qrConfigured: true }).blocks, ['QR_OFFLINE_NEEDS_EXTERNAL_VERIFICATION']);
  assert.equal(checkPayment({ ...base, qrConfirmed: true, qrExternalVerificationNote: '老板手机银行已见到账' }, { online: false, qrConfigured: true }).ok, true);
  assert.ok(checkPayment({ ...base, qrConfirmed: true }, { online: true, qrConfigured: false }).blocks.includes('QR_NOT_CONFIGURED'));
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

test('O05/O06 同牌只能一张单持有；出餐后待回收仍不可用，实体回收后才可用', () => {
  let board = createTokenBoard();
  const a = holdToken(board, 18, 'A');
  assert.ok(a.ok);
  board = a.board;
  const b = holdToken(board, 18, 'B');
  assert.equal(b.ok, false);
  assert.equal(!b.ok && b.error, 'TOKEN_OCCUPIED');
  assert.ok(holdToken(board, 18, 'A').ok, '同一订单重复占牌幂等');
  // 未出餐不能普通回收
  assert.equal(releaseToken(board, 18, 'A').ok, false);
  const served = markAwaitingReturn(board, 18, 'A');
  assert.ok(served.ok);
  board = served.board;
  assert.equal(holdToken(board, 18, 'C').ok, false, '出餐后立即新开 18 号仍不可用');
  assert.equal(releaseToken(board, 18, 'B').ok, false, '其他订单不能回收');
  const released = releaseToken(board, 18, 'A');
  assert.ok(released.ok);
  board = released.board;
  assert.ok(holdToken(board, 18, 'C').ok);
});

test('餐牌版本冲突：过期版本被拒绝', () => {
  const board = createTokenBoard();
  const r = holdToken(board, 3, 'A', 5);
  assert.equal(!r.ok && r.error, 'STALE_VERSION');
});

const ctx = (patch: Partial<LifecycleContext> = {}): LifecycleContext => ({
  nowMs: 1_000_000, actorUid: 'k1', actorRole: 'kitchen', expectedVersion: 1, tokenStillHeldByOrder: true, dayClosed: false, ...patch,
});

test('O07 过期版本操作被拒绝，单次生效', () => {
  const s = newAcceptedState(900);
  const first = applyLifecycle(s, { type: 'serve' }, ctx());
  assert.ok(first.ok);
  // 另一台 KDS 拿着旧版本再点出餐
  const second = applyLifecycle(first.state, { type: 'serve' }, ctx({ actorUid: 'k2', expectedVersion: 1 }));
  assert.equal(!second.ok && second.error, 'STALE_VERSION');
  // 拿到新版本也不能重复出餐
  const third = applyLifecycle(first.state, { type: 'serve' }, ctx({ expectedVersion: 2 }));
  assert.equal(!third.ok && third.error, 'INVALID_TRANSITION');
});

test('O08 30 秒内撤回恢复原状态、原开始时间', () => {
  const s0 = newAcceptedState(900);
  const started = applyLifecycle(s0, { type: 'start' }, ctx({ nowMs: 1_000 }));
  assert.ok(started.ok);
  const served = applyLifecycle(started.state, { type: 'serve' }, ctx({ nowMs: 5_000, expectedVersion: 2 }));
  assert.ok(served.ok);
  assert.deepEqual(served.effects, ['token_awaiting_return', 'kitchen_projection_update']);
  const undo = applyLifecycle(served.state, { type: 'undo_serve' }, ctx({ nowMs: 5_000 + UNDO_SERVE_WINDOW_MS - 1, expectedVersion: 3 }));
  assert.ok(undo.ok);
  assert.equal(undo.state.fulfillmentStatus, 'preparing');
  assert.equal(undo.state.startedAtMs, 1_000);
  assert.equal(undo.state.servedAtMs, null);
  assert.deepEqual(undo.effects, ['token_revert_held', 'kitchen_projection_update']);
  // 重复撤回不会再次生效
  assert.equal(applyLifecycle(undo.state, { type: 'undo_serve' }, ctx({ expectedVersion: 4 })).ok, false);
});

test('O09 撤回超时 / 牌已回收或给了别人 / 已关账 / 非原操作者：拒绝并说明', () => {
  const served = applyLifecycle(newAcceptedState(900), { type: 'serve' }, ctx({ nowMs: 0 }));
  assert.ok(served.ok);
  const s = served.state;
  const e = (c: Partial<LifecycleContext>) => {
    const r = applyLifecycle(s, { type: 'undo_serve' }, ctx({ expectedVersion: 2, nowMs: 10_000, ...c }));
    return r.ok ? 'ok' : r.error;
  };
  assert.equal(e({ nowMs: UNDO_SERVE_WINDOW_MS }), 'UNDO_WINDOW_EXPIRED');
  assert.equal(e({ tokenStillHeldByOrder: false }), 'TOKEN_REASSIGNED');
  assert.equal(e({ dayClosed: true }), 'DAY_CLOSED');
  assert.equal(e({ actorUid: 'other-kitchen' }), 'FORBIDDEN');
  assert.equal(e({ actorUid: 'boss', actorRole: 'owner' }), 'ok');

  // 牌层面：待回收牌被回收后，撤回无法恢复占牌
  let board = createTokenBoard();
  board = (holdToken(board, 7, 'A') as { board: typeof board }).board;
  board = (markAwaitingReturn(board, 7, 'A') as { board: typeof board }).board;
  board = (releaseToken(board, 7, 'A') as { board: typeof board }).board;
  board = (holdToken(board, 7, 'B') as { board: typeof board }).board;
  const rev = revertToHeld(board, 7, 'A');
  assert.equal(!rev.ok && rev.error, 'TOKEN_NOT_HELD_BY_ORDER', '不抢占新订单牌号');
});

test('F03 待做取消反转成本；制作中取消需后厨确认且保留成本；出餐后整单退款保留出餐', () => {
  const queuedCancel = applyLifecycle(newAcceptedState(900), { type: 'request_cancel', reason: '顾客离开' }, ctx({ actorRole: 'cashier', actorUid: 'c1' }));
  assert.ok(queuedCancel.ok);
  assert.equal(queuedCancel.state.fulfillmentStatus, 'cancelled');
  assert.equal(queuedCancel.state.paymentState, 'refund_due', '取消不等于已退款');
  assert.equal(queuedCancel.state.costAllocated, false);
  assert.ok(queuedCancel.effects.includes('cost_reverse'));

  const started = applyLifecycle(newAcceptedState(900), { type: 'start' }, ctx());
  assert.ok(started.ok);
  const req = applyLifecycle(started.state, { type: 'request_cancel', reason: '打错' }, ctx({ actorRole: 'cashier', actorUid: 'c1', expectedVersion: 2 }));
  assert.ok(req.ok);
  assert.equal(req.state.fulfillmentStatus, 'preparing');
  assert.equal(req.state.kitchenCancelRequested, true);
  assert.equal(applyLifecycle(req.state, { type: 'serve' }, ctx({ expectedVersion: 3 })).ok, false, '取消待确认不能当普通完成');
  const conf = applyLifecycle(req.state, { type: 'confirm_kitchen_cancel' }, ctx({ expectedVersion: 3 }));
  assert.ok(conf.ok);
  assert.equal(conf.state.fulfillmentStatus, 'cancelled');
  assert.equal(conf.state.costAllocated, true, '已耗材成本保留');
  assert.ok(!conf.effects.includes('cost_reverse'));

  const served = applyLifecycle(newAcceptedState(1800), { type: 'serve' }, ctx());
  assert.ok(served.ok);
  assert.equal(applyLifecycle(served.state, { type: 'request_cancel', reason: 'x' }, ctx({ actorRole: 'cashier', expectedVersion: 2 })).ok, false);
  const partial = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 900 }, ctx({ actorRole: 'owner', expectedVersion: 2 }));
  assert.equal(!partial.ok && partial.error, 'REFUND_MUST_BE_FULL');
  const cashierRefund = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 1800 }, ctx({ actorRole: 'cashier', expectedVersion: 2 }));
  assert.equal(!cashierRefund.ok && cashierRefund.error, 'FORBIDDEN');
  const refund = applyLifecycle(served.state, { type: 'confirm_full_refund', amountSen: 1800 }, ctx({ actorRole: 'owner', expectedVersion: 2 }));
  assert.ok(refund.ok);
  assert.equal(refund.state.fulfillmentStatus, 'served', '保留真实出餐历史');
  assert.equal(refund.state.paymentState, 'refunded');
  assert.equal(refund.state.costAllocated, true);
  assert.equal(applyLifecycle(refund.state, { type: 'confirm_full_refund', amountSen: 0 }, ctx({ actorRole: 'owner', expectedVersion: 3 })).ok, false);
});

test('权限：后厨不能取消/退款，收银不能出餐', () => {
  const s = newAcceptedState(900);
  assert.equal(applyLifecycle(s, { type: 'request_cancel', reason: 'x' }, ctx()).ok, false);
  assert.equal(applyLifecycle(s, { type: 'serve' }, ctx({ actorRole: 'cashier' })).ok, false);
});

function ticket(id: string, at: number, status: KitchenTicket['fulfillmentStatus'], lines: { cfg: ReturnType<typeof defaultConfig>; q: number }[], routing: KitchenTicket['kitchenRouting'] = 'digital') {
  return buildKitchenTicket(menu, {
    orderId: id, tokenNumber: 1, serviceMode: 'dine_in', kitchenRouting: routing, fulfillmentStatus: status, kitchenCancelRequested: false,
    acceptedAtEffectiveMs: at, startedAtMs: null, servedAtMs: null, timeQuality: 'server', businessDate: '2026-10-22', version: 1,
    lines: lines.map((l, i) => ({ lineId: `${id}-${i}`, config: l.cfg, quantity: l.q })),
  });
}

test('O10 待下锅只计 queued；制作中单独统计；细面/面薄分开；Kosong 不重复计份；人工单不进主队列', () => {
  const thinMed = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'black'), size: 'medium' });
  const pohSmall = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle', 'red'), noodleType: 'mee_poh' });
  const kosong = normalizeConfig(menu, { ...defaultConfig(menu, 'soup_noodle'), isKosong: true });
  const ws15 = normalizeConfig(menu, { ...defaultConfig(menu, 'wanton_soup'), size: 'w15' });
  const tickets = [
    ticket('A', 3, 'queued', [{ cfg: thinMed, q: 2 }, { cfg: kosong, q: 1 }]),
    ticket('B', 1, 'queued', [{ cfg: pohSmall, q: 1 }]),
    ticket('C', 2, 'preparing', [{ cfg: ws15, q: 1 }]),
    ticket('D', 0, 'queued', [{ cfg: thinMed, q: 5 }], 'manual'),
    ticket('E', 0, 'served', [{ cfg: thinMed, q: 5 }]),
  ];
  const { queued, preparing, manualPending } = summarizeKitchen(tickets);
  assert.equal(queued.orders, 2);
  assert.equal(queued.portions, 4);
  assert.equal(queued.thinEggHalfUnits, 3 * 2 + 2, '2×中(1.5) + Kosong 小(1) 细面');
  assert.equal(queued.meePohHalfUnits, 2);
  assert.equal(queued.noodleHalfUnits, 10);
  assert.equal(queued.wantons, 2 * 3 + 0 + 3, '2×中面 3 粒 + Kosong 0 粒 + 面薄小 3 粒');
  assert.equal(queued.kosong, 1);
  assert.deepEqual(queued.sauce, { black: 2, white: 0, red: 1 });
  assert.equal(queued.soupNoodle, 1);
  assert.equal(preparing.orders, 1);
  assert.equal(preparing.wantons, 15);
  assert.equal(preparing.wantonSoup, 1);
  assert.equal(manualPending, 1);
  assert.deepEqual(sortFifo(tickets).map((t) => t.orderId), ['D', 'E', 'B', 'C', 'A'], '等得最久在前');
});

test('厨房投影不含售价、付款、成本字段', () => {
  const cfg = normalizeConfig(menu, { ...defaultConfig(menu, 'dry_noodle'), addOns: ['char_siew'], note: '分开装' });
  const t = ticket('X', 0, 'queued', [{ cfg, q: 2 }]);
  const json = JSON.stringify(t);
  assert.ok(!/sen|cost|price|paid|payment|refund|amount/i.test(json), json);
  assert.equal(t.lines[0].photoId, 'dish.dry_noodle.black');
  assert.ok(t.lines[0].pictograms.some((p) => p.id === 'addon:char_siew'));
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
