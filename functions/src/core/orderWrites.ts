/**
 * 接单的统一写入：订单（无 BOM）、私有成本、厨房投影；收款登记另行写入（writePaymentRegistration）。
 * 在线 createOrder 与离线补同步共用，保证两种来源的字段一致；餐牌、序号、票号由调用方负责。
 * 新订单默认待收款、不产生付款流水；只有旧格式离线日志（下单即收款）才按原渠道写付款。
 * schemaVersion 3：paymentState 可为 unpaid / not_due；旧读取方不得把未付款新单当已付。
 */
import { Timestamp, Transaction } from 'firebase-admin/firestore';
import { BomVersion } from '../../../src/domain/bom';
import { CartLine, OrderTotals } from '../../../src/domain/cart';
import { buildKitchenTicket, KitchenRouting, TimeQuality } from '../../../src/domain/kitchen';
import { lineNameZh, linePhotoId, linePortions } from '../../../src/domain/lineItem';
import { MenuVersion, orderServiceMode, ServiceMode } from '../../../src/domain/menu';
import { newAcceptedState } from '../../../src/domain/orderLifecycle';
import { LegacyPaymentMethod, paymentIdFor } from '../../../src/domain/payment';
import { linePictograms } from '../../../src/domain/pictograms';
import type { StoreRefs } from './command';

export interface AcceptedOrderInput {
  storeId: string;
  orderId: string;
  receiptNumber: string;
  offlineReceiptNumber: string | null;
  tokenNumber: number;
  /** 默认就餐方式；订单文档上的 serviceMode 由各行得出（可能为 mixed）。 */
  serviceMode: ServiceMode;
  source: 'online' | 'offline';
  kitchenRouting: KitchenRouting;
  menu: MenuVersion;
  bom: BomVersion;
  lines: CartLine[];
  totals: OrderTotals;
  /** 只有旧格式离线日志（下单即收款）才有；新订单为 null。 */
  legacyPayment: { method: LegacyPaymentMethod; tenderedSen: number | null; changeSen: number | null; qrExternalVerificationNote: string | null } | null;
  acceptedAtEffectiveMs: number;
  deviceAcceptedAtMs: number;
  cloudReceivedAtMs: number;
  timeQuality: TimeQuality;
  businessDate: string;
  registerId: string;
  registerEpoch: number;
  shiftId: string;
  sequence: number;
  createdBy: string;
  allocationEventId: string;
  /** 加单：挂到哪张未收款的原单上，收款时与原单一次结账。 */
  addOnTo?: AddOnLink | null;
  extra?: Record<string, unknown>;
}

/** 加单关联（指向最早那张原单；加单的加单也指向同一张）。 */
export interface AddOnLink {
  orderId: string;
  tokenNumber: number;
  receiptNumber: string | null;
}

export function writeAcceptedOrder(tx: Transaction, store: StoreRefs, a: AcceptedOrderInput) {
  const legacy = a.legacyPayment;
  const life = newAcceptedState({ acceptedAtMs: a.acceptedAtEffectiveMs, kitchenRouting: a.kitchenRouting, legacyPaidSen: legacy ? a.totals.totalSen : null });
  const paymentId = legacy ? paymentIdFor(a.orderId, 1) : null;
  const items = a.lines.map((l, i) => {
    const p = linePortions(a.menu, l.config);
    return {
      lineId: l.lineId, ...l.config, quantity: l.quantity, serviceMode: l.serviceMode,
      unitPriceSen: a.totals.lines[i].unitPriceSen, lineTotalSen: a.totals.lines[i].lineTotalSen,
      noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount,
      nameZh: lineNameZh(a.menu, l.config), photoId: linePhotoId(l.config),
      pictogramIds: linePictograms(a.menu, l.config, l.serviceMode).map((x) => x.id),
    };
  });
  tx.create(store.order(a.orderId), {
    schemaVersion: 3, storeId: a.storeId, id: a.orderId, receiptNumber: a.receiptNumber, offlineReceiptNumber: a.offlineReceiptNumber,
    tokenNumber: a.tokenNumber, serviceMode: orderServiceMode(a.lines.map((l) => l.serviceMode), a.serviceMode), source: a.source, kitchenRouting: a.kitchenRouting,
    ...life,
    items, totalSen: a.totals.totalSen, portionCount: a.totals.portionCount,
    paymentMethod: legacy?.method ?? null, cashTenderedSen: legacy?.method === 'cash' ? legacy.tenderedSen : null, changeSen: legacy?.changeSen ?? null,
    paymentSeq: legacy ? 1 : 0, paymentId, paidAtMs: legacy ? a.acceptedAtEffectiveMs : null, paymentBusinessDate: legacy ? a.businessDate : null,
    tokenReleasedAtMs: null, tokenReleaseSource: null, addOnTo: a.addOnTo ?? null,
    acceptedAtEffective: Timestamp.fromMillis(a.acceptedAtEffectiveMs), acceptedAtEffectiveMs: a.acceptedAtEffectiveMs,
    deviceAcceptedAtMs: a.deviceAcceptedAtMs, cloudReceivedAtMs: a.cloudReceivedAtMs,
    kitchenAckAtMs: null, timeQuality: a.timeQuality, businessDate: a.businessDate, menuVersion: a.menu.version,
    registerId: a.registerId, registerEpoch: a.registerEpoch, shiftId: a.shiftId, sequence: a.sequence,
    createdBy: a.createdBy, updatedAtMs: a.cloudReceivedAtMs,
    ...a.extra,
  });
  if (legacy && paymentId) {
    tx.create(store.payment(paymentId), {
      id: paymentId, orderId: a.orderId, kind: 'payment', method: legacy.method, amountSen: a.totals.totalSen,
      tenderedSen: legacy.method === 'cash' ? legacy.tenderedSen : null, changeSen: legacy.changeSen,
      qrExternalVerificationNote: legacy.qrExternalVerificationNote,
      confirmedBy: a.createdBy, businessDate: a.businessDate, orderBusinessDate: a.businessDate, occurredAtMs: a.acceptedAtEffectiveMs, source: a.source,
      registerId: a.registerId, shiftId: a.shiftId,
    });
  }
  tx.create(store.orderCost(a.orderId), {
    orderId: a.orderId, bomVersion: a.bom.version, businessDate: a.businessDate,
    lines: a.totals.lines.map((l) => ({ lineId: l.lineId, unitCostUnits: l.unitCostUnits, lineCostUnits: l.lineCostUnits })),
    ingredientCostUnits: a.totals.ingredientCostUnits, packagingCostUnits: a.totals.packagingCostUnits, totalCostUnits: a.totals.totalCostUnits,
    allocatedCostUnits: a.totals.totalCostUnits,
    allocationEvents: [{ id: a.allocationEventId, type: 'allocate', costUnits: a.totals.totalCostUnits, businessDate: a.businessDate, atMs: a.cloudReceivedAtMs }],
    pendingCalibration: a.bom.pendingCalibration,
  });
  // 成本账本：每笔分配/反转一条记录，带自己的营业日，供日结与报表按日查询。
  tx.create(store.costEvent(a.allocationEventId), {
    id: a.allocationEventId, orderId: a.orderId, businessDate: a.businessDate, costUnits: a.totals.totalCostUnits, kind: 'allocate', atMs: a.cloudReceivedAtMs,
  });
  tx.create(store.ticket(a.orderId), {
    ...buildKitchenTicket(a.menu, {
      orderId: a.orderId, tokenNumber: a.tokenNumber, serviceMode: a.serviceMode, kitchenRouting: a.kitchenRouting, fulfillmentStatus: life.fulfillmentStatus,
      kitchenCancelRequested: false, acceptedAtEffectiveMs: a.acceptedAtEffectiveMs, startedAtMs: life.startedAtMs, startedSource: life.startedSource,
      servedAtMs: null, timeQuality: a.timeQuality,
      businessDate: a.businessDate, version: life.version, lines: a.lines,
    }),
    kitchenAckAtMs: null,
    // 厨房只需知道是谁的加单（原餐牌），不含金额。
    addOnTo: a.addOnTo ? { tokenNumber: a.addOnTo.tokenNumber } : null,
    receiptNumber: a.receiptNumber,
    offlineReceiptNumber: a.offlineReceiptNumber,
  });
  return { paymentId, life };
}

export interface PaymentRegistration {
  orderId: string;
  /** 同一订单第几次登记（更正后可再登记）。 */
  seq: number;
  amountSen: number;
  /** 登记（确认收到）所属营业日；可能晚于订单营业日。 */
  businessDate: string;
  orderBusinessDate: string;
  occurredAtMs: number;
  recordedAtMs: number;
  confirmedBy: string;
  source: 'online' | 'offline';
  registerId: string | null;
  operationId: string | null;
  offlineEventId: string | null;
}

/**
 * 收款登记：不分渠道的人工全额确认。确定性 ID（orderId-p{seq}）+ tx.create 保证并发确认只生成一笔。
 * 只改订单的付款字段，不碰制作版本、厨房投影、餐牌与成本。
 */
export function writePaymentRegistration(tx: Transaction, store: StoreRefs, r: PaymentRegistration) {
  const id = paymentIdFor(r.orderId, r.seq);
  tx.create(store.payment(id), {
    id, orderId: r.orderId, kind: 'payment', method: 'unspecified', confirmationMode: 'manual', amountSen: r.amountSen,
    tenderedSen: null, changeSen: null, confirmedBy: r.confirmedBy, businessDate: r.businessDate, orderBusinessDate: r.orderBusinessDate,
    occurredAtMs: r.occurredAtMs, recordedAtMs: r.recordedAtMs, source: r.source, registerId: r.registerId,
    operationId: r.operationId, offlineEventId: r.offlineEventId,
  });
  tx.update(store.order(r.orderId), {
    paymentState: 'paid', paidSen: r.amountSen, paymentMethod: 'unspecified', paymentSeq: r.seq, paymentId: id,
    paidAtMs: r.occurredAtMs, paymentBusinessDate: r.businessDate, paymentConfirmedBy: r.confirmedBy, updatedAtMs: r.recordedAtMs,
  });
  return id;
}

export function receiptNumberFor(businessDate: string, seq: number): string {
  return `${businessDate.replace(/-/g, '').slice(2)}-${String(seq).padStart(3, '0')}`;
}
