/**
 * 出餐即记收款（老板开关 payOnServe）。三条出餐路径共用：后厨「完成出餐」、离线人工出餐补同步、老板核对补入人工出餐。
 * 客人多数吃完才付钱，送餐的人照后厨卡片上的金额收；按出餐的同一事务把这张单记为已收款
 * （confirmationMode=auto_on_serve，不是员工确认到账），日结单独列出，请老板和钱箱现金加 QR 到账核对。
 *
 * 规则：
 * - 开关关、订单不是待收款（已付 / 已取消 / 已放弃追收）、金额为 0、registerPayment 不允许、记账那天在关账中或已关账 → 不记，出餐照常。
 * - 钱的问题绝不让出餐失败：这里只返回 null，不抛错。
 * - planAutoPay 只读（营业日文档），必须在事务写入之前调用；applyAutoPay 只写，返回订单付款字段，由调用方并进它那一次订单更新。
 */
import { DocumentData, Transaction } from 'firebase-admin/firestore';
import { registerPayment } from '../../../src/domain/orderLifecycle';
import { paymentSeqOf, paymentStateOf } from '../commands/payment';
import type { StoreRefs } from './command';
import { paymentRegistrationWrites } from './orderWrites';
import { markDayActivity, StoreConfig } from './store';

export interface AutoPayPlan {
  orderId: string;
  seq: number;
  amountSen: number;
  /** 这笔收款计入哪一天（在线出餐 = 今天；离线人工出餐 = 出餐那天；老板核对补入 = 今天）。 */
  bookingDate: string;
  orderBusinessDate: string;
  day: { exists: boolean };
}

export async function planAutoPay(
  tx: Transaction, store: StoreRefs,
  p: { config: StoreConfig; order: DocumentData; orderId: string; bookingDate: string },
): Promise<AutoPayPlan | null> {
  const { config, order } = p;
  if (!config.payOnServe) return null;
  if (order.paymentState !== 'unpaid') return null;
  const totalSen = order.totalSen as number;
  if (typeof totalSen !== 'number' || totalSen <= 0) return null;
  if (!registerPayment(paymentStateOf(order), { amountSen: totalSen, orderTotalSen: totalSen }).ok) return null;
  const daySnap = await tx.get(store.businessDay(p.bookingDate));
  const day = daySnap.data();
  // 那天在关账中 / 已关账：不改冻结的账，订单留在待收款，由前台照旧确认。
  if (day && day.state !== 'open') return null;
  return {
    orderId: p.orderId, seq: paymentSeqOf(order) + 1, amountSen: totalSen, bookingDate: p.bookingDate,
    orderBusinessDate: order.businessDate as string, day: { exists: daySnap.exists },
  };
}

/**
 * 离线收款确认 / 老板核对补入的收款，碰上出餐时已自动记了同一笔：不重复入账，
 * 而是把那笔「出餐自动记」升级为「前台确认」（同一条收款流水，金额不变）。
 */
export function canUpgradeAutoPayment(order: DocumentData, amountSen: number): boolean {
  return order.paymentState === 'paid' && order.paymentConfirmationMode === 'auto_on_serve'
    && typeof order.paymentId === 'string' && amountSen === order.paidSen;
}

export function upgradeAutoPayment(
  tx: Transaction, store: StoreRefs, orderId: string, order: DocumentData,
  w: { actorUid: string; nowMs: number; cashierAtMs: number; paymentDayOpen: boolean },
) {
  // 那笔收款所属营业日已关账：流水保持冻结时的样子（日结重算才对得上），只在订单上记前台已确认。
  if (w.paymentDayOpen) {
    tx.update(store.payment(order.paymentId as string), { confirmationMode: 'manual', upgradedFromAuto: true, upgradedBy: w.actorUid, upgradedAtMs: w.nowMs });
  }
  // 收银确认的时间早于出餐：前台先收了钱、出餐又按一次——可能真的收了两次，订单页提示老板核对（只是提示）。
  const before = typeof order.servedAtMs === 'number' && w.cashierAtMs < order.servedAtMs;
  tx.update(store.order(orderId), {
    paymentConfirmationMode: 'manual', paymentConfirmedBy: w.actorUid, servePaymentId: null, updatedAtMs: w.nowMs,
    ...(before ? { alsoCollectedBeforeServe: true } : {}),
  });
  return { alsoCollectedBeforeServe: before };
}

export function applyAutoPay(
  tx: Transaction, store: StoreRefs, plan: AutoPayPlan,
  w: { nowMs: number; occurredAtMs: number; actorUid: string; source: 'serve' | 'offline' | 'review'; operationId: string | null; offlineEventId: string | null },
) {
  const { id, orderPatch } = paymentRegistrationWrites(tx, store, {
    orderId: plan.orderId, seq: plan.seq, amountSen: plan.amountSen, businessDate: plan.bookingDate, orderBusinessDate: plan.orderBusinessDate,
    occurredAtMs: w.occurredAtMs, recordedAtMs: w.nowMs, confirmedBy: w.actorUid, source: w.source, registerId: null,
    operationId: w.operationId, offlineEventId: w.offlineEventId, confirmationMode: 'auto_on_serve',
  });
  // 和人工登记一样记一次营业日活动：与关账在同一文档上串行。
  markDayActivity(tx, store, plan.bookingDate, plan.day, w.nowMs);
  return { paymentId: id, amountSen: plan.amountSen, orderPatch };
}
