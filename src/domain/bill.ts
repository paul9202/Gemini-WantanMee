/**
 * 同桌账单：一桌（同一轮占用同一张餐牌）的单合起来算钱。每张单仍是独立订单、全额收款，这里只做汇总，不改任何金额。
 * 账单 ID 是组长单的 ID：order.addOnTo.orderId，没有就是订单自己。
 * 还要收 = 未收款、未取消、没有取消待确认、本机也没登记过的单；已收款的不会再收一次。
 */
import type { Sen } from './money';
import type { Fulfillment, PaymentState } from './orderLifecycle';

export interface BillOrder {
  id: string;
  totalSen: number;
  paidSen?: number;
  paymentState: PaymentState;
  fulfillmentStatus: Fulfillment;
  kitchenCancelRequested?: boolean;
  addOnTo?: { orderId: string } | null;
}

export interface BillSummary {
  /** 现在一键要收的单（金额为整单）。 */
  payable: { orderId: string; amountSen: Sen }[];
  dueSen: Sen;
  /** 已收（含本机已登记待同步）。 */
  paidSen: Sen;
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
  const out: BillSummary = { payable: [], dueSen: 0, paidSen: 0, refundDueSen: 0, writtenOffSen: 0, cancelPendingSen: 0 };
  for (const o of orders) {
    if (o.paymentState === 'paid') out.paidSen += o.paidSen ?? o.totalSen;
    else if (o.paymentState === 'refund_due') out.refundDueSen += o.paidSen ?? o.totalSen;
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
