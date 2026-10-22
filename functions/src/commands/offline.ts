/**
 * 离线补同步（03 §7.3）与人工单转电子厨单。
 *
 * syncOfflineEvents：主收银机上传本机不可变事件；每个事件一次事务、以 eventId 幂等收件。
 * - 同设备按序号应用；缺号时本条及其后全部 blocked（保留收件，可重试），绝不越过依赖。
 * - 不能自动接纳的事件（换机 epoch、时间异常、菜单未知、价格不符、牌冲突、关账后迟到……）
 *   进入 needs_review：保留原始金额与餐牌，不静默改价/换牌/丢单；序号照常前进。
 * - 离线单一律 kitchenRouting=manual，不进入后厨电子队列、不触发新单提示。
 * - 已人工出餐的离线单导入为 served；只有尚未制作的才可由收银核实后转电子厨单。
 */
import { Firestore, Transaction } from 'firebase-admin/firestore';
import { BOM_VERSIONS } from '../../../src/domain/bom';
import { businessDateOf } from '../../../src/domain/businessDay';
import { computeTotals } from '../../../src/domain/cart';
import { canonicalJson, isUuid, payloadHash } from '../../../src/domain/idempotency';
import { isValidQuantity, parseLineConfig, LineConfig } from '../../../src/domain/lineItem';
import { MENU_VERSIONS, SERVICE_MODES } from '../../../src/domain/menu';
import {
  effectiveTimeMs, OfflineEvent, OfflineEventResult, OfflineOrderPayload, OfflineReviewReason, TIME_SKEW_LIMIT_MS,
} from '../../../src/domain/offline';
import { checkPayment } from '../../../src/domain/payment';
import { holdToken, isTokenNumber, markAwaitingReturn, releaseToken, TokenBoard } from '../../../src/domain/tokens';
import { runCommand, storeRefs, StoreRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, int, obj, str, storeId, uuid } from '../core/input';
import { loadStoreConfig, StoreConfig } from '../core/store';
import { receiptNumberFor, writeAcceptedOrder } from '../core/orderWrites';

export const MAX_EVENTS_PER_BATCH = 25;
const MAX_BATCH_BYTES = 200_000;

// ---------- 输入解析（不可信） ----------

function parseEvent(raw: unknown, i: number): OfflineEvent {
  const o = obj(raw, ['eventId', 'registerId', 'deviceId', 'registerEpoch', 'sequence', 'shiftId', 'type', 'occurredAtDeviceMs', 'lastServerOffsetMs', 'payload'], `events[${i}]`);
  const base = {
    eventId: uuid(o, 'eventId'), registerId: str(o, 'registerId', 40), deviceId: str(o, 'deviceId', 64),
    registerEpoch: int(o, 'registerEpoch', 0, 1_000_000), sequence: int(o, 'sequence', 1, Number.MAX_SAFE_INTEGER),
    shiftId: str(o, 'shiftId', 80), occurredAtDeviceMs: int(o, 'occurredAtDeviceMs', 0, Number.MAX_SAFE_INTEGER),
    lastServerOffsetMs: int(o, 'lastServerOffsetMs', -86_400_000 * 365, 86_400_000 * 365),
  };
  const type = o.type;
  if (type === 'offline_order_created') {
    const p = obj(o.payload, ['clientOrderId', 'offlineReceiptNumber', 'tokenNumber', 'serviceMode', 'menuVersion', 'lines', 'totalSen', 'payment'], `events[${i}].payload`);
    const pay = obj(p.payment, ['method', 'tenderedSen', 'qrExternalVerificationNote'], `events[${i}].payload.payment`);
    if (!Array.isArray(p.lines) || p.lines.length < 1 || p.lines.length > 30) throw bad('lines 需 1–30 行');
    const lines = p.lines.map((l, j) => {
      const line = obj(l, ['lineId', 'config', 'quantity'], `lines[${j}]`);
      if (!isValidQuantity(line.quantity)) throw bad(`lines[${j}].quantity 非法`);
      return { lineId: str(line, 'lineId', 64), config: line.config as LineConfig, quantity: line.quantity as number };
    });
    const method = pay.method;
    if (method !== 'cash' && method !== 'qr_manual') throw bad('payment.method 非法');
    const tendered = pay.tenderedSen === null || pay.tenderedSen === undefined ? null : int(pay, 'tenderedSen', 0, 10_000_000);
    const note = pay.qrExternalVerificationNote;
    if (note !== null && note !== undefined && (typeof note !== 'string' || note.length > 200)) throw bad('qrExternalVerificationNote 非法');
    if (typeof p.serviceMode !== 'string' || !SERVICE_MODES.includes(p.serviceMode as never)) throw bad('serviceMode 非法');
    return {
      ...base, type,
      payload: {
        clientOrderId: uuid(p, 'clientOrderId'), offlineReceiptNumber: str(p, 'offlineReceiptNumber', 40),
        tokenNumber: int(p, 'tokenNumber', 1, 50), serviceMode: p.serviceMode as OfflineOrderPayload['serviceMode'],
        menuVersion: str(p, 'menuVersion', 64), lines, totalSen: int(p, 'totalSen', 0, 10_000_000),
        payment: { method, tenderedSen: tendered, qrExternalVerificationNote: (note as string | null | undefined) ?? null },
      },
    };
  }
  if (type === 'manual_handoff' || type === 'manual_served') {
    const p = obj(o.payload, ['clientOrderId'], `events[${i}].payload`);
    return { ...base, type, payload: { clientOrderId: uuid(p, 'clientOrderId') } };
  }
  if (type === 'sequence_void') {
    const p = obj(o.payload, ['clientOrderId', 'operationId'], `events[${i}].payload`);
    return { ...base, type, payload: { clientOrderId: uuid(p, 'clientOrderId'), operationId: uuid(p, 'operationId') } };
  }
  if (type === 'token_returned') {
    const p = obj(o.payload, ['clientOrderId', 'tokenNumber'], `events[${i}].payload`);
    return { ...base, type, payload: { clientOrderId: uuid(p, 'clientOrderId'), tokenNumber: int(p, 'tokenNumber', 1, 50) } };
  }
  throw bad(`未知事件类型 ${String(type)}`);
}

// ---------- 单事件处理 ----------

interface Applied {
  status: OfflineEventResult['status'];
  reasonCode?: OfflineReviewReason;
  orderId?: string;
  receiptNumber?: string;
  /** 是否推进收银机序号（换机 epoch 的旧日志不推进新主机的序号）。 */
  advance: boolean;
  writes?: (tx: Transaction) => void;
}

const review = (reasonCode: OfflineReviewReason, orderId?: string, advance = true): Applied => ({ status: 'needs_review', reasonCode, orderId, advance });

async function decide(
  tx: Transaction, store: StoreRefs, config: StoreConfig, e: OfflineEvent, later: OfflineEvent[], nowMs: number, actorUid: string,
): Promise<Applied> {
  const at = effectiveTimeMs(e);
  const orderId = e.payload.clientOrderId;

  // ---- 读取 ----
  const voidedOpSnap = e.type === 'sequence_void' ? await tx.get(store.operation(e.payload.operationId)) : null;
  const regSnap = await tx.get(store.register(e.registerId));
  const reg = regSnap.data();
  const shift = (await tx.get(store.shift(e.shiftId))).data();
  const orderSnap = await tx.get(store.order(orderId));
  const order = orderSnap.data();
  const tokenNo = e.type === 'offline_order_created' || e.type === 'token_returned' ? e.payload.tokenNumber : (order?.tokenNumber as number | undefined);
  const tokenSnap = tokenNo ? await tx.get(store.token(tokenNo)) : null;
  const token = tokenSnap?.data();
  const businessDate = businessDateOf(at, config.businessDay);
  const daySnap = e.type === 'offline_order_created' ? await tx.get(store.businessDay(businessDate)) : null;
  const ticketRef = store.ticket(orderId);

  // ---- 主收银机资格与序号 ----
  if (!reg || reg.activeDeviceId !== e.deviceId || reg.epoch !== e.registerEpoch || config.activeRegisterId !== e.registerId) {
    return review('REGISTER_REVOKED', orderId, false);
  }
  const expected = ((reg.lastAppliedSequence as number) ?? 0) + 1;
  if (e.sequence > expected) return { status: 'blocked', reasonCode: 'SEQUENCE_GAP', advance: false };
  if (e.sequence < expected) return review('SEQUENCE_REUSED', orderId, false);

  // ---- 按事件类型 ----
  if (e.type === 'sequence_void') {
    // 被作废的在线命令若其实已提交，序号早已被占用，前面的检查会判为 SEQUENCE_REUSED。
    if (voidedOpSnap?.exists) return review('SEQUENCE_REUSED', orderId);
    return { status: 'accepted', advance: true };
  }

  if (e.type === 'offline_order_created') {
    const p = e.payload;
    if (!shift || shift.registerId !== e.registerId) return review('OFFLINE_CAPABILITY_EXPIRED', orderId);
    if (at > nowMs + TIME_SKEW_LIMIT_MS || at < (shift.openedAtMs as number) - TIME_SKEW_LIMIT_MS) return review('TIME_ANOMALY', orderId);
    if (at > (shift.offlineCapabilityExpiresAtMs as number)) return review('OFFLINE_CAPABILITY_EXPIRED', orderId);
    if (orderSnap.exists) return review('ORDER_ID_CONFLICT', orderId);
    const menu = MENU_VERSIONS[p.menuVersion];
    const bom = BOM_VERSIONS[config.activeBomVersion];
    if (!menu || !bom) return review('MENU_UNKNOWN', orderId);
    const lines: { lineId: string; config: LineConfig; quantity: number }[] = [];
    for (const l of p.lines) {
      const parsed = parseLineConfig({ ...menu, soldOut: [] }, l.config); // 离线时只能用缓存售罄状态，成交事实优先，售罄差异由老板核对
      if (!parsed.ok) return review('INVALID_MODIFIER', orderId);
      lines.push({ lineId: l.lineId, config: parsed.value, quantity: l.quantity });
    }
    const totals = computeTotals(menu, bom, { serviceMode: p.serviceMode, lines });
    if (totals.totalSen !== p.totalSen) return review('PRICE_MISMATCH', orderId);
    const payCheck = checkPayment(
      { method: p.payment.method, dueSen: totals.totalSen, tenderedSen: p.payment.tenderedSen, qrConfirmed: p.payment.method === 'qr_manual', qrExternalVerificationNote: p.payment.qrExternalVerificationNote },
      { online: false, qrConfigured: true },
    );
    if (!payCheck.ok) return review('PAYMENT_UNVERIFIED', orderId);
    const day = daySnap?.data();
    if (day && day.state !== 'open') return review('DAY_CLOSED_LATE', orderId);

    // 餐牌：可用则占用；若被占用但同批稍后有本单的回收事件（离线期间已出餐回收），只补历史账、不抢占当前牌锁。
    let tokenLock: 'held' | 'history_only' = 'held';
    let heldToken = null;
    if (!token || !isTokenNumber(p.tokenNumber)) return review('TOKEN_CONFLICT', orderId);
    const board: TokenBoard = { [p.tokenNumber]: { number: p.tokenNumber, state: token.state, orderId: token.orderId, version: token.version } };
    const held = holdToken(board, p.tokenNumber, orderId);
    if (held.ok) heldToken = held.token;
    else if (later.some((x) => x.type === 'token_returned' && x.payload.clientOrderId === orderId)) tokenLock = 'history_only';
    else return review('TOKEN_CONFLICT', orderId);

    const receiptSeq = ((day?.receiptSeq as number) ?? 0) + 1;
    const receiptNumber = receiptNumberFor(businessDate, receiptSeq);
    return {
      status: 'accepted', orderId, receiptNumber, advance: true,
      writes: (w) => {
        writeAcceptedOrder(w, store, {
          storeId: store.root.id, orderId, receiptNumber, offlineReceiptNumber: p.offlineReceiptNumber, tokenNumber: p.tokenNumber,
          serviceMode: p.serviceMode, source: 'offline', kitchenRouting: 'manual', menu, bom, lines, totals,
          payment: { method: p.payment.method, tenderedSen: p.payment.tenderedSen, changeSen: payCheck.changeSen, qrExternalVerificationNote: p.payment.qrExternalVerificationNote },
          acceptedAtEffectiveMs: at, deviceAcceptedAtMs: e.occurredAtDeviceMs, cloudReceivedAtMs: nowMs, timeQuality: 'device_estimated',
          businessDate, registerId: e.registerId, registerEpoch: e.registerEpoch, shiftId: e.shiftId, sequence: e.sequence,
          createdBy: actorUid, allocationEventId: `${e.eventId}-alloc`,
          extra: { offlineEventId: e.eventId, tokenLock, manualHandoffAtMs: null, servedManually: false, menuVersionCurrent: config.activeMenuVersion },
        });
        if (heldToken) w.set(store.token(p.tokenNumber), { ...heldToken, updatedAtMs: nowMs });
        w.set(store.businessDay(businessDate), { state: 'open', receiptSeq, updatedAtMs: nowMs }, { merge: true });
      },
    };
  }

  // 其余事件依赖订单已入账。
  if (!order) return review('DEPENDS_ON_REVIEW', orderId);
  if (order.source !== 'offline') return review('ORDER_STATE', orderId);

  if (e.type === 'manual_handoff') {
    if (order.manualHandoffAtMs) return { status: 'accepted', orderId, advance: true };
    return { status: 'accepted', orderId, advance: true, writes: (w) => w.update(store.order(orderId), { manualHandoffAtMs: at, updatedAtMs: nowMs }) };
  }

  if (e.type === 'manual_served') {
    if (order.fulfillmentStatus === 'served') return { status: 'accepted', orderId, advance: true };
    // 已转为电子厨单：由后厨屏负责出餐，人工出餐记录需老板核对，避免人工与后厨各做一份。
    if (order.kitchenRouting !== 'manual') return review('ORDER_STATE', orderId);
    if (order.fulfillmentStatus !== 'queued' && order.fulfillmentStatus !== 'preparing') return review('ORDER_STATE', orderId);
    let tokenWrite: ((w: Transaction) => void) | null = null;
    if (order.tokenLock !== 'history_only' && token) {
      const board: TokenBoard = { [order.tokenNumber]: { number: order.tokenNumber, state: token.state, orderId: token.orderId, version: token.version } };
      const r = markAwaitingReturn(board, order.tokenNumber, orderId);
      if (!r.ok) return review('TOKEN_CONFLICT', orderId);
      tokenWrite = (w) => w.set(store.token(order.tokenNumber), { ...r.token, updatedAtMs: nowMs });
    }
    const version = (order.version as number) + 1;
    return {
      status: 'accepted', orderId, advance: true,
      writes: (w) => {
        // 人工出餐：真实出餐时间为设备估计时间；不可撤回（preServe=null），不进入电子队列。
        w.update(store.order(orderId), { fulfillmentStatus: 'served', servedAtMs: at, servedBy: actorUid, servedManually: true, preServe: null, version, updatedAtMs: nowMs });
        w.update(ticketRef, { fulfillmentStatus: 'served', servedAtMs: at, version });
        tokenWrite?.(w);
      },
    };
  }

  // token_returned
  if (order.tokenLock === 'history_only') {
    return { status: 'accepted', orderId, advance: true, writes: (w) => w.update(store.order(orderId), { tokenReturnedAtMs: at, updatedAtMs: nowMs }) };
  }
  if (!token) return review('TOKEN_CONFLICT', orderId);
  if (token.state === 'available' && order.tokenReturnedAtMs) return { status: 'accepted', orderId, advance: true };
  const board: TokenBoard = { [e.payload.tokenNumber]: { number: e.payload.tokenNumber, state: token.state, orderId: token.orderId, version: token.version } };
  const r = releaseToken(board, e.payload.tokenNumber, orderId);
  if (!r.ok) return review('TOKEN_CONFLICT', orderId);
  return {
    status: 'accepted', orderId, advance: true,
    writes: (w) => {
      w.set(store.token(e.payload.tokenNumber), { ...r.token, updatedAtMs: nowMs, lastReleasedOrderId: orderId });
      w.update(store.order(orderId), { tokenReturnedAtMs: at, updatedAtMs: nowMs });
    },
  };
}

async function processEvent(db: Firestore, sid: string, e: OfflineEvent, later: OfflineEvent[], actorUid: string): Promise<OfflineEventResult> {
  const store = storeRefs(db, sid);
  const hash = await payloadHash(e);
  return db.runTransaction(async (tx) => {
    const inboxRef = store.inbox(e.eventId);
    const existing = (await tx.get(inboxRef)).data();
    if (existing && existing.payloadHash !== hash) {
      return { eventId: e.eventId, sequence: e.sequence, status: 'rejected', reasonCode: 'EVENT_CONFLICT' } as OfflineEventResult;
    }
    if (existing && existing.status !== 'blocked') return existing.result as OfflineEventResult; // 重复上传：返回原结果

    const config = await loadStoreConfig(tx, store);
    const nowMs = Date.now();
    const d = await decide(tx, store, config, e, later, nowMs, actorUid);
    const result: OfflineEventResult = { eventId: e.eventId, sequence: e.sequence, status: d.status };
    if (d.reasonCode) result.reasonCode = d.reasonCode;
    if (d.orderId) result.orderId = d.orderId;
    if (d.receiptNumber) result.receiptNumber = d.receiptNumber;

    d.writes?.(tx);
    if (d.status !== 'blocked' && d.advance) {
      tx.update(store.register(e.registerId), { lastAppliedSequence: e.sequence, lastSeenAtMs: nowMs });
    }
    const amountSen = e.type === 'offline_order_created' ? e.payload.totalSen : null;
    tx.set(inboxRef, {
      eventId: e.eventId, registerId: e.registerId, deviceId: e.deviceId, registerEpoch: e.registerEpoch, sequence: e.sequence,
      type: e.type, payloadHash: hash, payload: JSON.parse(canonicalJson(e)), status: d.status, reasonCode: d.reasonCode ?? null,
      result, amountSen, receivedAtMs: existing?.receivedAtMs ?? nowMs, processedAtMs: nowMs, uploadedBy: actorUid,
    });
    if (d.status !== 'blocked') {
      tx.set(store.audit(`offline-${e.eventId}`), {
        operationId: e.eventId, action: `offline:${e.type}`, actorUid, actorRole: 'register-sync', entityId: d.orderId ?? null,
        before: null, after: { status: d.status, reasonCode: d.reasonCode ?? null }, atMs: nowMs,
      });
    }
    return result;
  });
}

export async function syncOfflineEvents(db: Firestore, uid: string | undefined, raw: unknown) {
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  const o = obj(raw, ['storeId', 'events']);
  const sid = storeId(o);
  if (!Array.isArray(o.events) || o.events.length < 1 || o.events.length > MAX_EVENTS_PER_BATCH) throw bad(`events 需 1–${MAX_EVENTS_PER_BATCH} 条`);
  if (JSON.stringify(o.events).length > MAX_BATCH_BYTES) throw bad('批次过大');
  const events = o.events.map(parseEvent).sort((a, b) => a.sequence - b.sequence);
  if (new Set(events.map((e) => e.eventId)).size !== events.length) throw bad('eventId 重复');

  const member = (await storeRefs(db, sid).member(uid).get()).data();
  if (!member || member.active !== true) throw new CommandError('NOT_A_MEMBER');
  if (member.role !== 'cashier' && member.role !== 'owner') throw new CommandError('FORBIDDEN');

  const results: OfflineEventResult[] = [];
  let blocked = false;
  for (const [i, e] of events.entries()) {
    if (blocked) {
      results.push({ eventId: e.eventId, sequence: e.sequence, status: 'blocked', reasonCode: 'SEQUENCE_GAP' });
      continue;
    }
    const r = await processEvent(db, sid, e, events.slice(i + 1), uid);
    results.push(r);
    if (r.status === 'blocked') blocked = true;
  }
  return { results };
}

/** 收银核实厨房尚未制作后，把人工单转为电子厨单；后厨会看到醒目标识。 */
export async function routeManualOrderToKitchen(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'expectedVersion', 'note']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), expectedVersion: int(o, 'expectedVersion', 1, 1_000_000), note: str(o, 'note', 200, 2) };
  if (!isUuid(input.orderId)) throw bad('orderId 非法');
  return runCommand(db, {
    type: 'routeManualOrderToKitchen', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs }) => {
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND');
      if (order.version !== input.expectedVersion) throw new CommandError('STALE_VERSION');
      if (order.kitchenRouting !== 'manual' || order.fulfillmentStatus !== 'queued') throw new CommandError('INVALID_TRANSITION', '只有尚未制作的人工单可以转电子厨单');
      const version = (order.version as number) + 1;
      tx.update(store.order(input.orderId), { kitchenRouting: 'digital', routedFromManual: true, routeNote: input.note, routedAtMs: nowMs, version, updatedAtMs: nowMs });
      tx.update(store.ticket(input.orderId), { kitchenRouting: 'digital', routedFromManual: true, version });
      return { result: { orderId: input.orderId, version }, audit: { entityId: input.orderId, before: { kitchenRouting: 'manual' }, after: { kitchenRouting: 'digital' } } };
    },
  });
}
