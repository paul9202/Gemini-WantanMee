/**
 * 收款登记（与下单、出餐分离）。
 * - recordPayment：员工确认整单全额已收到。不选渠道、不输入实收找零，不执行扣款或转账。
 *   绑定订单 ID 操作（餐牌复用后仍是原单），可在出餐前或出餐后、甚至跨营业日补登记；
 *   收款计入登记日，关联原订单，不改写原营业日冻结报表、不重发厨单、不重扣成本。
 *   同 operationId 重试返回原结果（runCommand）；不同 operationId 并发确认同一订单只成功一次
 *   （事务内检查 paymentState + 确定性收款 ID）。
 * - reversePayment：老板更正误登记。保留原收款，追加负数调整，订单回到待收款；不是退款，不重新送厨。
 * - writeOffPayment / reinstateWrittenOff：老板放弃追收 / 之后又收到钱时恢复待收款。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import {
  OrderLifecycleState, PaymentError, registerPayment, reinstateWrittenOff as reinstateRule, reversePayment as reverseRule, writeOffUnpaid as writeOffRule,
} from '../../../src/domain/orderLifecycle';
import { paymentIdFor } from '../../../src/domain/payment';
import { runCommand } from '../core/command';
import { CommandError, ReasonCode } from '../core/errors';
import { int, obj, str, storeId, uuid } from '../core/input';
import { writePaymentRegistration } from '../core/orderWrites';
import { loadStoreConfig, markDayActivity, parseRegisterClaim, REGISTER_CLAIM_FIELDS, requireActiveRegister, requireDayOpen } from '../core/store';

const PAYMENT_ERROR: Record<PaymentError, ReasonCode> = {
  ALREADY_PAID: 'ALREADY_PAID', ORDER_CANCELLED: 'ORDER_CANCELLED', CANCEL_PENDING: 'CANCEL_PENDING', AMOUNT_MISMATCH: 'AMOUNT_MISMATCH', NOT_PAID: 'NOT_PAID',
  WRITTEN_OFF: 'WRITTEN_OFF', NOT_UNPAID: 'NOT_UNPAID',
};

export function paymentStateOf(order: Record<string, unknown>): OrderLifecycleState {
  return {
    fulfillmentStatus: order.fulfillmentStatus, paymentState: order.paymentState, paidSen: (order.paidSen as number) ?? 0,
    refundedSen: (order.refundedSen as number) ?? 0, kitchenCancelRequested: Boolean(order.kitchenCancelRequested),
    cancelReason: (order.cancelReason as string | null) ?? null, startedAtMs: (order.startedAtMs as number | null) ?? null,
    startedSource: (order.startedSource as OrderLifecycleState['startedSource']) ?? null, servedAtMs: (order.servedAtMs as number | null) ?? null,
    servedBy: (order.servedBy as string | null) ?? null, preServe: (order.preServe as OrderLifecycleState['preServe']) ?? null,
    costAllocated: order.costAllocated !== false, version: order.version as number,
  } as OrderLifecycleState;
}

/** 已用过的收款序号。旧订单（schemaVersion ≤ 2）没有 paymentSeq，但下单时已写过 p1。 */
export function paymentSeqOf(order: Record<string, unknown>): number {
  return (order.paymentSeq as number | undefined) ?? (order.paymentMethod ? 1 : 0);
}

export interface RecordPaymentResult {
  orderId: string;
  paymentId: string;
  amountSen: number;
  businessDate: string;
  orderBusinessDate: string;
  paymentState: 'paid';
  paidAtMs: number;
}

export async function recordPayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'orderId', 'amountSen']);
  const input = {
    storeId: storeId(o), operationId: uuid(o, 'operationId'), claim: parseRegisterClaim(o),
    orderId: uuid(o, 'orderId'), amountSen: int(o, 'amountSen', 1, 10_000_000),
  };
  return runCommand<RecordPaymentResult>(db, {
    type: 'recordPayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      // ---- 读取 ----
      const config = await loadStoreConfig(tx, store);
      // 主点单平板登记：校验主收银机资格（设备 + epoch），与下单同一资格。
      await requireActiveRegister(tx, store, config, input.claim);
      const orderSnap = await tx.get(store.order(input.orderId));
      const order = orderSnap.data();
      if (!orderSnap.exists || !order) throw new CommandError('NOT_FOUND', '订单不存在');
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);

      // ---- 校验 ----
      const r = registerPayment(paymentStateOf(order), { amountSen: input.amountSen, orderTotalSen: order.totalSen as number });
      if (!r.ok) {
        throw new CommandError(PAYMENT_ERROR[r.error], r.error, {
          paymentState: order.paymentState, paidAtMs: order.paidAtMs ?? null, totalSen: order.totalSen,
        });
      }

      // ---- 写入 ----
      const seq = paymentSeqOf(order) + 1;
      const paymentId = writePaymentRegistration(tx, store, {
        orderId: input.orderId, seq, amountSen: input.amountSen, businessDate, orderBusinessDate: order.businessDate as string,
        occurredAtMs: nowMs, recordedAtMs: nowMs, confirmedBy: actor.uid, source: 'online', registerId: input.claim.registerId,
        operationId: input.operationId, offlineEventId: null,
      });
      markDayActivity(tx, store, businessDate, day, nowMs);
      const result: RecordPaymentResult = {
        orderId: input.orderId, paymentId, amountSen: input.amountSen, businessDate, orderBusinessDate: order.businessDate as string,
        paymentState: 'paid', paidAtMs: nowMs,
      };
      return {
        result,
        audit: {
          entityId: input.orderId,
          before: { paymentState: order.paymentState },
          after: { paymentState: 'paid', paymentId, amountSen: input.amountSen, businessDate, crossDay: businessDate !== order.businessDate },
        },
      };
    },
  });
}

export async function reversePayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'reversePayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND', '订单不存在');
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);
      const r = reverseRule(paymentStateOf(order));
      if (!r.ok) throw new CommandError(PAYMENT_ERROR[r.error], r.error);
      const seq = paymentSeqOf(order);
      const original = (order.paymentId as string | null | undefined) ?? paymentIdFor(input.orderId, Math.max(seq, 1));
      const reversalId = `${original}-rev`;
      tx.create(store.payment(reversalId), {
        id: reversalId, orderId: input.orderId, kind: 'reversal', reversesPaymentId: original, method: order.paymentMethod ?? 'unspecified',
        amountSen: -(order.paidSen as number), reason: input.reason, confirmedBy: actor.uid, businessDate,
        orderBusinessDate: order.businessDate, occurredAtMs: nowMs, recordedAtMs: nowMs, source: 'online', operationId: input.operationId,
      });
      tx.update(store.order(input.orderId), {
        paymentState: r.state.paymentState, paidSen: 0, paymentId: null, paymentSeq: Math.max(seq, 1), paidAtMs: null, paymentBusinessDate: null,
        lastPaymentReversal: { reversalId, reversesPaymentId: original, reason: input.reason, by: actor.uid, atMs: nowMs }, updatedAtMs: nowMs,
      });
      markDayActivity(tx, store, businessDate, day, nowMs);
      return {
        result: { orderId: input.orderId, reversalId, paymentState: r.state.paymentState },
        audit: { entityId: input.orderId, before: { paymentState: order.paymentState, paidSen: order.paidSen }, after: { paymentState: r.state.paymentState, reason: input.reason } },
      };
    },
  });
}

/**
 * 老板放弃追收：仅限仍待收款的有效订单，必须写原因。记录金额、操作者、时间与营业日，
 * 订单退出待登记收款与日结例外，但历史订单保留；报表单独列「未收回金额」。
 * 不标已付款、不计实收、不动成本与餐牌。
 */
export async function writeOffPayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'writeOffPayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND', '订单不存在');
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);
      const r = writeOffRule(paymentStateOf(order));
      if (!r.ok) throw new CommandError(PAYMENT_ERROR[r.error], r.error);
      const n = ((order.writeOffSeq as number | undefined) ?? 0) + 1;
      const id = `${input.orderId}-w${n}`;
      tx.create(store.writeOff(id), {
        id, orderId: input.orderId, kind: 'write_off', amountSen: order.totalSen, reason: input.reason, recordedBy: actor.uid,
        businessDate, orderBusinessDate: order.businessDate, occurredAtMs: nowMs, operationId: input.operationId,
      });
      tx.update(store.order(input.orderId), {
        paymentState: 'written_off', writeOffSeq: n,
        writeOff: { id, amountSen: order.totalSen, reason: input.reason, by: actor.uid, atMs: nowMs, businessDate }, updatedAtMs: nowMs,
      });
      markDayActivity(tx, store, businessDate, day, nowMs);
      return {
        result: { orderId: input.orderId, writeOffId: id, amountSen: order.totalSen as number, businessDate, paymentState: 'written_off' },
        audit: { entityId: input.orderId, before: { paymentState: order.paymentState }, after: { paymentState: 'written_off', amountSen: order.totalSen, reason: input.reason } },
      };
    },
  });
}

/** 放弃追收后又收到钱：老板恢复为待收款（追加反向记录），再由主点单平板正常登记收款。 */
export async function reinstateWrittenOff(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'reinstateWrittenOff', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      const config = await loadStoreConfig(tx, store);
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND', '订单不存在');
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);
      const r = reinstateRule(paymentStateOf(order));
      if (!r.ok) throw new CommandError(PAYMENT_ERROR[r.error], r.error);
      const original = (order.writeOff as { id: string } | null | undefined)?.id ?? `${input.orderId}-w${order.writeOffSeq ?? 1}`;
      const id = `${original}-reinstate`;
      tx.create(store.writeOff(id), {
        id, orderId: input.orderId, kind: 'reinstate', reversesWriteOffId: original, amountSen: -(order.totalSen as number), reason: input.reason,
        recordedBy: actor.uid, businessDate, orderBusinessDate: order.businessDate, occurredAtMs: nowMs, operationId: input.operationId,
      });
      tx.update(store.order(input.orderId), {
        paymentState: 'unpaid', writeOff: null,
        lastWriteOffReinstate: { id, reversesWriteOffId: original, reason: input.reason, by: actor.uid, atMs: nowMs }, updatedAtMs: nowMs,
      });
      markDayActivity(tx, store, businessDate, day, nowMs);
      return {
        result: { orderId: input.orderId, reinstateId: id, paymentState: 'unpaid' },
        audit: { entityId: input.orderId, before: { paymentState: 'written_off' }, after: { paymentState: 'unpaid', reason: input.reason } },
      };
    },
  });
}
