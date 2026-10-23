/**
 * 老板处理待核对的离线记录（03 §7.3 第 8 步）。原事件不覆盖，只追加处理结果。
 * - import：订单按原单号补入账，一律只补历史账、不抢占当前餐牌锁，仍为人工单不送厨；
 *   金额不符时按实际收到的钱入账并记录差额（不追收）；QR 无核实依据时须老板确认银行已到账；
 *   落在已关账营业日时计入「关账后待调整」，原关账版本不变，需另做更正版本。
 * - 收款确认事件：原订单已入账且仍待收款时，按订单 ID 补登记一次全额收款；计入处理当天的营业日
 *   （原营业日已关账时不改写其冻结报表），关联原订单。已登记过的不重复入账。
 * - dismiss：不入账，保留原记录与原因。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { computeTotals } from '../../../src/domain/cart';
import { LineConfig, parseLineConfig } from '../../../src/domain/lineItem';
import { loadBom, loadMenu } from '../core/catalog';
import { effectiveTimeMs, OfflineEvent, OfflineReviewReason } from '../../../src/domain/offline';
import { runCommand } from '../core/command';
import { CommandError } from '../core/errors';
import { bad, obj, str, storeId, uuid } from '../core/input';
import { receiptNumberFor, writeAcceptedOrder, writePaymentRegistration } from '../core/orderWrites';
import { registerPayment } from '../../../src/domain/orderLifecycle';
import { paymentSeqOf, paymentStateOf } from './payment';
import { loadStoreConfig } from '../core/store';

/** 老板核对后可以补入账的原因；菜单无法核实、配置非法、订单号冲突等只能「不入账」。 */
export const IMPORTABLE_ORDER_REASONS: OfflineReviewReason[] = [
  'REGISTER_REVOKED', 'TIME_ANOMALY', 'OFFLINE_CAPABILITY_EXPIRED', 'TOKEN_CONFLICT', 'PAYMENT_UNVERIFIED', 'PRICE_MISMATCH', 'DAY_CLOSED_LATE',
];

export interface ReviewResult {
  eventId: string;
  resolution: 'imported' | 'dismissed';
  orderId?: string;
  receiptNumber?: string;
  businessDate?: string;
  postCloseAdjustment?: boolean;
  priceVarianceSen?: number;
}

export async function resolveOfflineReview(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'eventId', 'action', 'reason', 'confirmPaymentReceived']);
  if (o.action !== 'import' && o.action !== 'dismiss') throw bad('action 非法');
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), eventId: uuid(o, 'eventId'), action: o.action as 'import' | 'dismiss',
    reason: str(o, 'reason', 200, 2), confirmPaymentReceived: o.confirmPaymentReceived === true,
  };
  return runCommand<ReviewResult>(db, {
    type: 'resolveOfflineReview', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const inboxRef = store.inbox(input.eventId);
      const inbox = (await tx.get(inboxRef)).data();
      if (!inbox || inbox.status !== 'needs_review') throw new CommandError('INVALID_TRANSITION', '这条记录不在待核对状态');
      const e = inbox.payload as OfflineEvent;
      const reasonCode = inbox.reasonCode as OfflineReviewReason;
      const resolved = (resolution: ReviewResult['resolution'], extra: Record<string, unknown> = {}) => tx.update(inboxRef, {
        status: 'resolved', resolution, resolutionReason: input.reason, resolvedBy: actor.uid, resolvedAtMs: nowMs, ...extra,
      });

      if (input.action === 'dismiss') {
        resolved('dismissed');
        return { result: { eventId: input.eventId, resolution: 'dismissed' as const }, audit: { entityId: input.eventId, after: { resolution: 'dismissed', reason: input.reason } } };
      }

      const config = await loadStoreConfig(tx, store);
      const orderId = e.payload.clientOrderId;
      const order = (await tx.get(store.order(orderId))).data();

      if (e.type === 'offline_order_created') {
        if (!IMPORTABLE_ORDER_REASONS.includes(reasonCode)) throw new CommandError('REVIEW_NOT_ALLOWED', '这类记录只能核对后不入账');
        if (reasonCode === 'PAYMENT_UNVERIFIED' && !input.confirmPaymentReceived) throw new CommandError('REVIEW_NOT_ALLOWED', '请先确认银行端已经到账');
        if (order) throw new CommandError('REVIEW_NOT_ALLOWED', '订单号已存在');
        const p = e.payload;
        const menu = await loadMenu(tx, store, p.menuVersion);
        const bom = await loadBom(tx, store, config.activeBomVersion);
        if (!menu || !bom) throw new CommandError('REVIEW_NOT_ALLOWED', '菜单版本无法核实');
        const lines: { lineId: string; config: LineConfig; quantity: number }[] = [];
        for (const l of p.lines) {
          const parsed = parseLineConfig({ ...menu, soldOut: [] }, l.config);
          if (!parsed.ok) throw new CommandError('REVIEW_NOT_ALLOWED', '餐品配置不符合菜单');
          lines.push({ lineId: l.lineId, config: parsed.value, quantity: l.quantity });
        }
        const computed = computeTotals(menu, bom, { serviceMode: p.serviceMode, lines });
        if (computed.totalSen !== p.totalSen && reasonCode !== 'PRICE_MISMATCH') throw new CommandError('REVIEW_NOT_ALLOWED', '金额与菜单不符');
        const totals = { ...computed, totalSen: p.totalSen };
        const at = effectiveTimeMs(e);
        const businessDate = businessDateOf(at, config.businessDay);
        const daySnap = await tx.get(store.businessDay(businessDate));
        const day = daySnap.data();
        const postClose = Boolean(day && day.state !== 'open');
        const reportSnap = postClose ? await tx.get(store.dailyReport(businessDate)) : null;
        const receiptSeq = ((day?.receiptSeq as number) ?? 0) + 1;
        const receiptNumber = receiptNumberFor(businessDate, receiptSeq);
        const changeSen = p.payment?.method === 'cash' && p.payment.tenderedSen !== null ? p.payment.tenderedSen - p.totalSen : null;
        writeAcceptedOrder(tx, store, {
          storeId: store.root.id, orderId, receiptNumber, offlineReceiptNumber: p.offlineReceiptNumber, tokenNumber: p.tokenNumber,
          serviceMode: p.serviceMode, source: 'offline', kitchenRouting: 'manual', menu, bom, lines, totals,
          // 新格式离线单未付款：只补订单，收款另由收款确认事件或前台登记。
          legacyPayment: p.payment ? {
            method: p.payment.method, tenderedSen: p.payment.tenderedSen, changeSen,
            qrExternalVerificationNote: p.payment.qrExternalVerificationNote ?? (input.confirmPaymentReceived ? `老板确认到账：${input.reason}` : null),
          } : null,
          acceptedAtEffectiveMs: at, deviceAcceptedAtMs: e.occurredAtDeviceMs, cloudReceivedAtMs: nowMs, timeQuality: 'device_estimated',
          businessDate, registerId: e.registerId, registerEpoch: e.registerEpoch, shiftId: e.shiftId, sequence: e.sequence,
          createdBy: actor.uid, allocationEventId: `${e.eventId}-alloc`,
          extra: {
            offlineEventId: e.eventId, tokenLock: 'history_only', manualHandoffAtMs: null, servedManually: false,
            priceVarianceSen: p.totalSen - computed.totalSen, reviewedImport: { reasonCode, reason: input.reason, by: actor.uid, atMs: nowMs },
            postCloseAdjustment: postClose,
          },
        });
        if (postClose) {
          tx.update(store.businessDay(businessDate), { pendingAdjustments: ((day!.pendingAdjustments as number) ?? 0) + 1, receiptSeq });
          if (reportSnap?.exists) tx.update(store.dailyReport(businessDate), { pendingAdjustments: ((reportSnap.data()!.pendingAdjustments as number) ?? 0) + 1 });
        } else if (daySnap.exists) {
          tx.update(store.businessDay(businessDate), { receiptSeq, lastActivityAtMs: nowMs });
        } else {
          tx.set(store.businessDay(businessDate), { state: 'open', receiptSeq, lastActivityAtMs: nowMs });
        }
        resolved('imported', { result: { ...(inbox.result as object), status: 'accepted', orderId, receiptNumber } });
        return {
          result: { eventId: input.eventId, resolution: 'imported' as const, orderId, receiptNumber, businessDate, postCloseAdjustment: postClose, priceVarianceSen: p.totalSen - computed.totalSen },
          audit: { entityId: orderId, after: { resolution: 'imported', reasonCode, reason: input.reason } },
        };
      }

      // 依附于离线单的人工事件：所属订单已入账后才能补上。
      if (e.type === 'sequence_void') throw new CommandError('REVIEW_NOT_ALLOWED', '作废序号记录只能核对后不入账');
      if (e.type === 'offline_payment_recorded') {
        if (!order) throw new CommandError('REVIEW_NOT_ALLOWED', '请先处理所属订单');
        const r = registerPayment(paymentStateOf(order), { amountSen: e.payload.amountSen, orderTotalSen: order.totalSen as number });
        if (!r.ok) throw new CommandError('REVIEW_NOT_ALLOWED', r.error === 'ALREADY_PAID' ? '这张单已登记收款，不重复入账' : '订单状态或金额不允许登记');
        const today = businessDateOf(nowMs, config.businessDay);
        const todaySnap = await tx.get(store.businessDay(today));
        if (todaySnap.exists && todaySnap.data()?.state !== 'open') throw new CommandError('DAY_CLOSED', '今天已关账');
        writePaymentRegistration(tx, store, {
          orderId, seq: paymentSeqOf(order) + 1, amountSen: e.payload.amountSen, businessDate: today, orderBusinessDate: order.businessDate as string,
          occurredAtMs: effectiveTimeMs(e), recordedAtMs: nowMs, confirmedBy: actor.uid, source: 'offline', registerId: e.registerId,
          operationId: input.operationId, offlineEventId: e.eventId,
        });
        tx.set(store.businessDay(today), { state: 'open', lastActivityAtMs: nowMs }, { merge: true });
        resolved('imported', { result: { ...(inbox.result as object), status: 'accepted', orderId } });
        return { result: { eventId: input.eventId, resolution: 'imported' as const, orderId, businessDate: today }, audit: { entityId: orderId, after: { resolution: 'imported', type: e.type, reason: input.reason } } };
      }
      if (!order || order.source !== 'offline') throw new CommandError('REVIEW_NOT_ALLOWED', '请先处理所属订单');
      const at = effectiveTimeMs(e);
      if (e.type === 'manual_handoff') {
        tx.update(store.order(orderId), { manualHandoffAtMs: order.manualHandoffAtMs ?? at, updatedAtMs: nowMs });
      } else if (e.type === 'manual_served') {
        if (order.kitchenRouting !== 'manual') throw new CommandError('REVIEW_NOT_ALLOWED', '已转电子厨单，出餐以后厨屏为准');
        if (order.fulfillmentStatus !== 'served') {
          const version = (order.version as number) + 1;
          // 补核对的人工单一律 history_only：不占牌，也就不释放任何牌。
          tx.update(store.order(orderId), { fulfillmentStatus: 'served', servedAtMs: at, servedBy: actor.uid, servedManually: true, preServe: null, version, updatedAtMs: nowMs });
          tx.update(store.ticket(orderId), { fulfillmentStatus: 'served', servedAtMs: at, version });
        }
      } else if (e.type === 'token_returned') {
        if (order.tokenLock !== 'history_only') throw new CommandError('REVIEW_NOT_ALLOWED', '请在收银端回收餐牌');
        tx.update(store.order(orderId), { tokenReturnedAtMs: order.tokenReturnedAtMs ?? at, updatedAtMs: nowMs });
      }
      resolved('imported', { result: { ...(inbox.result as object), status: 'accepted', orderId } });
      return { result: { eventId: input.eventId, resolution: 'imported' as const, orderId }, audit: { entityId: orderId, after: { resolution: 'imported', type: e.type } } };
    },
  });
}
