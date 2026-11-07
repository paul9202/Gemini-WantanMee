/**
 * 同桌账单：一桌（同一轮占用同一张餐牌）的单合起来算钱。每张单仍是独立订单、全额收款，这里只做汇总，不改任何金额。
 * 账单 ID 是组长单的 ID：order.addOnTo.orderId，没有就是订单自己。
 * 还要收 = 未收款、未取消、没有取消待确认、本机也没登记过的单；已收款的不会再收一次。
 */
import type { Sen } from './money';
import type { Fulfillment, PaymentState } from './orderLifecycle';
import type { ConfirmationMode } from './payment';

export interface BillOrder {
  id: string;
  totalSen: number;
  paidSen?: number;
  paymentState: PaymentState;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested?: boolean;
  addOnTo?: { orderId: string } | null;
  /** 这笔收款怎么来的；旧单没有这个字段 = 前台人工确认。 */
  paymentConfirmationMode?: ConfirmationMode | null;
}

export interface BillSummary {
  /** 现在一键要收的单（金额为整单）。 */
  payable: { orderId: string; amountSen: Sen }[];
  dueSen: Sen;
  /** 已收（含本机已登记待同步）。 */
  paidSen: Sen;
  /**
   * 已收里出餐时自动记的部分（门店开了「出餐即记收款」）。这部分不是前台确认收到钱，
   * 显示时不能说成「客人在前台付了」。
   */
  autoPaidSen: Sen;
  refundDueSen: Sen;
  writtenOffSen: Sen;
  /** 取消待后厨确认：暂不计入要收的钱。 */
  cancelPendingSen: Sen;
}

export function billIdOf(o: { id: string; addOnTo?: { orderId: string } | null }): string {
  return o.addOnTo?.orderId ?? o.id;
}

/** localPaid：本机已登记、待同步的订单 ID。 */
export function summarizeBill(orders: BillOrder[], localPaid: ReadonlySet<string> = new Set()): BillSummary {
  const out: BillSummary = { payable: [], dueSen: 0, paidSen: 0, autoPaidSen: 0, refundDueSen: 0, writtenOffSen: 0, cancelPendingSen: 0 };
  for (const o of orders) {
    if (o.paymentState === 'paid') {
      out.paidSen += o.paidSen ?? o.totalSen;
      if (o.paymentConfirmationMode === 'auto_on_serve') out.autoPaidSen += o.paidSen ?? o.totalSen;
    } else if (o.paymentState === 'refund_due') out.refundDueSen += o.paidSen ?? o.totalSen;
    else if (o.paymentState === 'written_off') out.writtenOffSen += o.totalSen;
    else if (o.paymentState === 'unpaid' && o.fulfillmentStatus !== 'cancelled') {
      if (localPaid.has(o.id)) out.paidSen += o.totalSen;
      else if (o.kitchenCancelRequested) out.cancelPendingSen += o.totalSen;
      else {
        out.payable.push({ orderId: o.id, amountSen: o.totalSen });
        out.dueSen += o.totalSen;
      }
    }
  }
  return out;
}

/** 前台点收款时服务器回「已登记收款」，而且是出餐时自动记的：送餐的人可能已经收过这一碗的钱。 */
export interface PaidAtServeConflict {
  orderId: string;
  tokenNumber: number | null;
  paidSen: Sen;
}

/**
 * 读 ALREADY_PAID 的 details（服务器给 orderId / tokenNumber / confirmationMode / paidSen）。
 * 只有 confirmationMode 是 auto_on_serve 才返回；旧服务器没给 details、或是前台确认过的，返回 null（照旧当作已登记）。
 */
export function paidAtServeConflict(details: Record<string, unknown> | null | undefined): PaidAtServeConflict | null {
  if (!details || details.confirmationMode !== 'auto_on_serve' || typeof details.orderId !== 'string') return null;
  const paidSen = typeof details.paidSen === 'number' && Number.isFinite(details.paidSen) ? details.paidSen : 0;
  const tokenNumber = typeof details.tokenNumber === 'number' ? details.tokenNumber : null;
  return { orderId: details.orderId, tokenNumber, paidSen };
}
