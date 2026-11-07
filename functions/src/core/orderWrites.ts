/**
 * 接单的统一写入：订单（无 BOM）、私有成本、厨房投影；收款登记另行写入（writePaymentRegistration）。
 * 在线 createOrder 与离线补同步共用，保证两种来源的字段一致；餐牌、序号、票号由调用方负责。
 * 新订单默认待收款、不产生付款流水；只有旧格式离线日志（下单即收款）才按原渠道写付款。
 * 厨房投影带售价合计 totalSen 与 paidBeforeServe（不论「出餐即记收款」开关是否打开都写），后厨据此显示要收多少钱。
 * schemaVersion 3：paymentState 可为 unpaid / not_due；旧读取方不得把未付款新单当已付。
 */
import { Timestamp, Transaction } from 'firebase-admin/firestore';
import { BomVersion } from '../../../src/domain/bom';
import { CartLine, OrderTotals } from '../../../src/domain/cart';
import { buildKitchenTicket, KitchenRouting, TimeQuality } from '../../../src/domain/kitchen';
import { lineNameZh, linePhotoId, linePortions } from '../../../src/domain/lineItem';
import { MenuVersion, orderServiceMode, ServiceMode } from '../../../src/domain/menu';
import { newAcceptedState } from '../../../src/domain/orderLifecycle';
import { ConfirmationMode, LegacyPaymentMethod, paymentIdFor, ReversalCause } from '../../../src/domain/payment';
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
  /** 同牌加单：挂在这桌客人已拿着的牌上（牌上还有别的单）。 */
  sharedToken?: boolean;
  /** 同牌加单继承的排队位置与后厨分组；只写在厨单上，接单时间不变。 */
  queue?: { queueAtMs: number; queueGroupId: string } | null;
  /** 下单后加料的小单：给哪一张单加的。 */
  extraForOrderId?: string | null;
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
    tokenReleasedAtMs: null, tokenReleaseSource: null, addOnTo: a.addOnTo ?? null, sharedToken: a.sharedToken ?? false, ...(a.extraForOrderId ? { extraOnly: true, extraForOrderId: a.extraForOrderId } : {}),
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
    // 后厨卡片写这张单要收多少钱（售价合计，送餐时照着收）；不含成本、单价与付款明细。
    // paidBeforeServe：出餐前已在收银确认收款 → 卡片显示「已付 · 不用收」。旧格式离线单下单即已收。
    totalSen: a.totals.totalSen,
    paidBeforeServe: Boolean(legacy),
    // 厨房只需知道是谁的加单（原餐牌）。
    addOnTo: a.addOnTo ? { tokenNumber: a.addOnTo.tokenNumber } : null,
    // 同牌加单：后厨据此提示「N 号再加的，和前面 N 号的一起送」。
    sharedToken: a.sharedToken ?? false,
    ...(a.queue ?? {}),
    ...(a.extraForOrderId ? { extraOnly: true, extraForOrderId: a.extraForOrderId } : {}),
    receiptNumber: a.receiptNumber,
    offlineReceiptNumber: a.offlineReceiptNumber,
  });
  return { paymentId, life };
}

/** 调用方在写入前读到的厨单：只用来判断要不要在厨单上标「已付 · 不用收」。 */
export interface TicketPeek {
  exists: boolean;
  fulfillmentStatus: string | null;
}

/** 在事务读取阶段读厨单（写入前调用）。 */
export async function peekTicket(tx: Transaction, store: StoreRefs, orderId: string): Promise<TicketPeek> {
  const snap = await tx.get(store.ticket(orderId));
  return { exists: snap.exists, fulfillmentStatus: (snap.data()?.fulfillmentStatus as string | undefined) ?? null };
}

/** 厨单还没出餐（排队 / 制作中）：收款或冲正要同步改厨单上的 paidBeforeServe。 */
export function ticketUnserved(t: TicketPeek | null | undefined): t is TicketPeek {
  return Boolean(t?.exists) && (t!.fulfillmentStatus === 'queued' || t!.fulfillmentStatus === 'preparing');
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
  /** serve：后厨出餐自动记的；review：老板核对离线记录时补的。 */
  source: 'online' | 'offline' | 'serve' | 'review';
  /** 出餐自动记收款不经收银机，为 null。 */
  registerId: string | null;
  operationId: string | null;
  offlineEventId: string | null;
  /** 缺省 manual（员工确认收到）；auto_on_serve 只由出餐自动记收款使用。 */
  confirmationMode?: ConfirmationMode;
  /** 写入前读到的厨单；出餐前人工确认收款时在厨单上标「已付 · 不用收」。 */
  ticket?: TicketPeek | null;
}

/**
 * 收款登记的写入（收款流水 + 厨单标记），返回订单要改的付款字段，由调用方并进它自己那一次订单更新。
 * 出餐命令自己也要改订单（制作字段），同一事务里只写一次订单，避免后写的覆盖先写的付款字段。
 */
export function paymentRegistrationWrites(tx: Transaction, store: StoreRefs, r: PaymentRegistration) {
  const id = paymentIdFor(r.orderId, r.seq);
  const mode: ConfirmationMode = r.confirmationMode ?? 'manual';
  tx.create(store.payment(id), {
    id, orderId: r.orderId, kind: 'payment', method: 'unspecified', confirmationMode: mode, amountSen: r.amountSen,
    tenderedSen: null, changeSen: null, confirmedBy: r.confirmedBy, businessDate: r.businessDate, orderBusinessDate: r.orderBusinessDate,
    occurredAtMs: r.occurredAtMs, recordedAtMs: r.recordedAtMs, source: r.source, registerId: r.registerId,
    operationId: r.operationId, offlineEventId: r.offlineEventId,
  });
  // 出餐前人工确认收款：后厨卡片改显示「已付 · 不用收」，送餐的人不会再收一次。
  // 自动记收款发生在出餐那一刻，厨单已出餐，不标。
  if (mode === 'manual' && ticketUnserved(r.ticket)) tx.update(store.ticket(r.orderId), { paidBeforeServe: true });
  const orderPatch: Record<string, unknown> = {
    paymentState: 'paid', paidSen: r.amountSen, paymentMethod: 'unspecified', paymentSeq: r.seq, paymentId: id,
    paidAtMs: r.occurredAtMs, paymentBusinessDate: r.businessDate, paymentConfirmedBy: r.confirmedBy,
    paymentConfirmationMode: mode,
    // 只有出餐自动记的收款才记 servePaymentId：撤回出餐时据此判断要不要一起撤回这笔收款。
    servePaymentId: mode === 'auto_on_serve' ? id : null,
    updatedAtMs: r.recordedAtMs,
  };
  return { id, orderPatch };
}

/**
 * 收款登记：不分渠道的全额确认（人工，或开关打开时出餐自动记）。确定性 ID（orderId-p{seq}）+ tx.create 保证并发只生成一笔。
 * 只改订单的付款字段与厨单的 paidBeforeServe，不碰制作版本、餐牌与成本。
 */
export function writePaymentRegistration(tx: Transaction, store: StoreRefs, r: PaymentRegistration) {
  const { id, orderPatch } = paymentRegistrationWrites(tx, store, r);
  tx.update(store.order(r.orderId), orderPatch);
  return id;
}

export interface PaymentReversal {
  orderId: string;
  order: Record<string, unknown>;
  /** 已用过的收款序号（paymentSeqOf）。 */
  seq: number;
  cause: ReversalCause;
  reason: string;
  actorUid: string;
  /** 冲正计入的营业日（今天）。 */
  businessDate: string;
  nowMs: number;
  operationId: string;
  /** 写入前读到的厨单；还没出餐时把「已付 · 不用收」改回要收。 */
  ticket?: TicketPeek | null;
}

/**
 * 收款冲正（误登记更正 / 撤回出餐 / 客人没付就走了）：保留原收款，追加 `{收款ID}-rev` 负数记录（cause 写原因类别），
 * 返回订单要改的付款字段（paymentState 由调用方决定）。三种冲正写法完全一样，日结按 cause 区分。
 */
export function paymentReversalWrites(tx: Transaction, store: StoreRefs, r: PaymentReversal) {
  const o = r.order;
  const original = (o.paymentId as string | null | undefined) ?? paymentIdFor(r.orderId, Math.max(r.seq, 1));
  const reversalId = `${original}-rev`;
  tx.create(store.payment(reversalId), {
    id: reversalId, orderId: r.orderId, kind: 'reversal', reversesPaymentId: original, method: o.paymentMethod ?? 'unspecified',
    amountSen: -(o.paidSen as number), reason: r.reason, cause: r.cause, confirmedBy: r.actorUid, businessDate: r.businessDate,
    orderBusinessDate: o.businessDate, occurredAtMs: r.nowMs, recordedAtMs: r.nowMs, source: 'online', operationId: r.operationId,
  });
  if (ticketUnserved(r.ticket)) tx.update(store.ticket(r.orderId), { paidBeforeServe: false });
  const orderPatch: Record<string, unknown> = {
    paidSen: 0, paymentId: null, paymentSeq: Math.max(r.seq, 1), paidAtMs: null, paymentBusinessDate: null,
    paymentConfirmationMode: null, servePaymentId: null,
    lastPaymentReversal: { reversalId, reversesPaymentId: original, reason: r.reason, cause: r.cause, by: r.actorUid, atMs: r.nowMs },
    updatedAtMs: r.nowMs,
  };
  return { reversalId, original, orderPatch };
}

export function receiptNumberFor(businessDate: string, seq: number): string {
  return `${businessDate.replace(/-/g, '').slice(2)}-${String(seq).padStart(3, '0')}`;
}
