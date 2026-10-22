/**
 * 已收款订单的统一写入：订单（无 BOM）、支付、私有成本、厨房投影。
 * 在线 createOrder 与离线补同步共用，保证两种来源的字段一致；餐牌、序号、票号由调用方负责。
 */
import { Timestamp, Transaction } from 'firebase-admin/firestore';
import { BomVersion } from '../../../src/domain/bom';
import { OrderTotals } from '../../../src/domain/cart';
import { buildKitchenTicket, KitchenRouting, TimeQuality } from '../../../src/domain/kitchen';
import { LineConfig, lineNameZh, linePhotoId, linePortions } from '../../../src/domain/lineItem';
import { MenuVersion, ServiceMode } from '../../../src/domain/menu';
import { newAcceptedState } from '../../../src/domain/orderLifecycle';
import { PaymentMethod } from '../../../src/domain/payment';
import { linePictograms } from '../../../src/domain/pictograms';
import type { StoreRefs } from './command';

export interface AcceptedOrderInput {
  storeId: string;
  orderId: string;
  receiptNumber: string;
  offlineReceiptNumber: string | null;
  tokenNumber: number;
  serviceMode: ServiceMode;
  source: 'online' | 'offline';
  kitchenRouting: KitchenRouting;
  menu: MenuVersion;
  bom: BomVersion;
  lines: { lineId: string; config: LineConfig; quantity: number }[];
  totals: OrderTotals;
  payment: { method: PaymentMethod; tenderedSen: number | null; changeSen: number | null; qrExternalVerificationNote: string | null };
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
  extra?: Record<string, unknown>;
}

export function writeAcceptedOrder(tx: Transaction, store: StoreRefs, a: AcceptedOrderInput) {
  const life = newAcceptedState(a.totals.totalSen);
  const paymentId = `${a.orderId}-p1`;
  const items = a.lines.map((l, i) => {
    const p = linePortions(a.menu, l.config);
    return {
      lineId: l.lineId, ...l.config, quantity: l.quantity,
      unitPriceSen: a.totals.lines[i].unitPriceSen, lineTotalSen: a.totals.lines[i].lineTotalSen,
      noodleHalfUnits: p.noodleHalfUnits, wantonCount: p.wantonCount,
      nameZh: lineNameZh(a.menu, l.config), photoId: linePhotoId(l.config),
      pictogramIds: linePictograms(a.menu, l.config, a.serviceMode).map((x) => x.id),
    };
  });
  tx.create(store.order(a.orderId), {
    schemaVersion: 2, storeId: a.storeId, id: a.orderId, receiptNumber: a.receiptNumber, offlineReceiptNumber: a.offlineReceiptNumber,
    tokenNumber: a.tokenNumber, serviceMode: a.serviceMode, source: a.source, kitchenRouting: a.kitchenRouting,
    ...life,
    items, totalSen: a.totals.totalSen, portionCount: a.totals.portionCount,
    paymentMethod: a.payment.method, cashTenderedSen: a.payment.method === 'cash' ? a.payment.tenderedSen : null, changeSen: a.payment.changeSen,
    acceptedAtEffective: Timestamp.fromMillis(a.acceptedAtEffectiveMs), acceptedAtEffectiveMs: a.acceptedAtEffectiveMs,
    deviceAcceptedAtMs: a.deviceAcceptedAtMs, cloudReceivedAtMs: a.cloudReceivedAtMs,
    kitchenAckAtMs: null, timeQuality: a.timeQuality, businessDate: a.businessDate, menuVersion: a.menu.version,
    registerId: a.registerId, registerEpoch: a.registerEpoch, shiftId: a.shiftId, sequence: a.sequence,
    createdBy: a.createdBy, updatedAtMs: a.cloudReceivedAtMs,
    ...a.extra,
  });
  tx.create(store.payment(paymentId), {
    id: paymentId, orderId: a.orderId, method: a.payment.method, amountSen: a.totals.totalSen,
    tenderedSen: a.payment.method === 'cash' ? a.payment.tenderedSen : null, changeSen: a.payment.changeSen,
    qrExternalVerificationNote: a.payment.qrExternalVerificationNote,
    confirmedBy: a.createdBy, businessDate: a.businessDate, occurredAtMs: a.acceptedAtEffectiveMs, source: a.source,
    registerId: a.registerId, shiftId: a.shiftId,
  });
  tx.create(store.orderCost(a.orderId), {
    orderId: a.orderId, bomVersion: a.bom.version, businessDate: a.businessDate,
    lines: a.totals.lines.map((l) => ({ lineId: l.lineId, unitCostUnits: l.unitCostUnits, lineCostUnits: l.lineCostUnits })),
    ingredientCostUnits: a.totals.ingredientCostUnits, packagingCostUnits: a.totals.packagingCostUnits, totalCostUnits: a.totals.totalCostUnits,
    allocatedCostUnits: a.totals.totalCostUnits,
    allocationEvents: [{ id: a.allocationEventId, type: 'allocate', costUnits: a.totals.totalCostUnits, businessDate: a.businessDate, atMs: a.cloudReceivedAtMs }],
    pendingCalibration: a.bom.pendingCalibration,
  });
  tx.create(store.ticket(a.orderId), {
    ...buildKitchenTicket(a.menu, {
      orderId: a.orderId, tokenNumber: a.tokenNumber, serviceMode: a.serviceMode, kitchenRouting: a.kitchenRouting, fulfillmentStatus: 'queued',
      kitchenCancelRequested: false, acceptedAtEffectiveMs: a.acceptedAtEffectiveMs, startedAtMs: null, servedAtMs: null, timeQuality: a.timeQuality,
      businessDate: a.businessDate, version: life.version, lines: a.lines,
    }),
    kitchenAckAtMs: null,
    receiptNumber: a.receiptNumber,
    offlineReceiptNumber: a.offlineReceiptNumber,
  });
  return { paymentId };
}

export function receiptNumberFor(businessDate: string, seq: number): string {
  return `${businessDate.replace(/-/g, '').slice(2)}-${String(seq).padStart(3, '0')}`;
}
