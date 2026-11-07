/**
 * 收款登记（与下单、出餐分离）。
 * - recordPayment：员工确认整单全额已收到。不选渠道、不输入实收找零，不执行扣款或转账。
 *   绑定订单 ID 操作（餐牌复用后仍是原单），可在出餐前或出餐后、甚至跨营业日补登记；
 *   收款计入登记日，关联原订单，不改写原营业日冻结报表、不重发厨单、不重扣成本。
 *   同 operationId 重试返回原结果（runCommand）；不同 operationId 并发确认同一订单只成功一次
 *   （事务内检查 paymentState + 确定性收款 ID）。
 * - recordGroupPayment：原单与它的加单（客人吃完再加打包）一次结账。同一事务逐单检查并逐单写收款，
 *   任何一单不能登记就整组都不登记；每单仍有自己的收款记录，更正 / 报表照旧按订单。
 * - reversePayment：老板更正误登记。保留原收款，追加负数调整（cause=correction），订单回到待收款；不是退款，不重新送厨。
 * - markNotPaid：客人没付就走了（多为出餐自动记的收款）。冲正（cause=not_paid）+ 放弃追收，一次完成。
 * - writeOffPayment / reinstateWrittenOff：老板放弃追收 / 之后又收到钱时恢复待收款。
 * 出餐前人工确认收款时，同一事务在厨单标 paidBeforeServe（后厨显示「已付 · 不用收」）；出餐前冲正则改回。
 * 已收款被拒（ALREADY_PAID）时带上这笔是前台确认还是出餐自动记的，前台据此提醒不要再收。
 */
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import {
  OrderLifecycleState, PaymentError, registerPayment, reinstateWrittenOff as reinstateRule, reversePayment as reverseRule, writeOffUnpaid as writeOffRule,
} from '../../../src/domain/orderLifecycle';
import { runCommand } from '../core/command';
import { CommandError, ReasonCode } from '../core/errors';
import { bad, int, obj, str, storeId, uuid } from '../core/input';
import { paymentReversalWrites, peekTicket, writePaymentRegistration } from '../core/orderWrites';
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

/**
 * ALREADY_PAID 的补充说明：这笔是前台确认的还是出餐自动记的（旧单没有字段 = manual），
 * 前台据此提示「刚出餐，已经自动记收款，不要再收这一碗」。
 */
function alreadyPaidDetails(orderId: string, order: Record<string, unknown>) {
  return {
    orderId, tokenNumber: (order.tokenNumber as number | undefined) ?? null,
    confirmationMode: (order.paymentConfirmationMode as string | null | undefined) ?? 'manual', paidSen: (order.paidSen as number | undefined) ?? 0,
  };
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
      const ticket = await peekTicket(tx, store, input.orderId);

      // ---- 校验 ----
      const r = registerPayment(paymentStateOf(order), { amountSen: input.amountSen, orderTotalSen: order.totalSen as number });
      if (!r.ok) {
        throw new CommandError(PAYMENT_ERROR[r.error], r.error, {
          paymentState: order.paymentState, paidAtMs: order.paidAtMs ?? null, totalSen: order.totalSen,
          ...(r.error === 'ALREADY_PAID' ? alreadyPaidDetails(input.orderId, order) : {}),
        });
      }

      // ---- 写入 ----
      const seq = paymentSeqOf(order) + 1;
      const paymentId = writePaymentRegistration(tx, store, {
        orderId: input.orderId, seq, amountSen: input.amountSen, businessDate, orderBusinessDate: order.businessDate as string,
        occurredAtMs: nowMs, recordedAtMs: nowMs, confirmedBy: actor.uid, source: 'online', registerId: input.claim.registerId,
        operationId: input.operationId, offlineEventId: null, ticket,
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

export const MAX_GROUP_ORDERS = 10;

export interface RecordGroupPaymentResult {
  orders: { orderId: string; paymentId: string; amountSen: number }[];
  amountSen: number;
  businessDate: string;
  paidAtMs: number;
}

export async function recordGroupPayment(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', ...REGISTER_CLAIM_FIELDS, 'orders']);
  if (!Array.isArray(o.orders) || o.orders.length < 1 || o.orders.length > MAX_GROUP_ORDERS) throw bad(`orders 需 1–${MAX_GROUP_ORDERS} 单`);
  const orders = o.orders.map((x, i) => {
    const r = obj(x, ['orderId', 'amountSen'], `orders[${i}]`);
    return { orderId: uuid(r, 'orderId'), amountSen: int(r, 'amountSen', 1, 10_000_000) };
  });
  if (new Set(orders.map((x) => x.orderId)).size !== orders.length) throw bad('orderId 重复');
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), claim: parseRegisterClaim(o), orders };
  return runCommand<RecordGroupPaymentResult>(db, {
    type: 'recordGroupPayment', storeId: input.storeId, operationId: input.operationId, uid, roles: ['cashier', 'owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      // ---- 读取 ----
      const config = await loadStoreConfig(tx, store);
      await requireActiveRegister(tx, store, config, input.claim);
      const docs = [];
      for (const x of input.orders) {
        const snap = await tx.get(store.order(x.orderId));
        const order = snap.data();
        if (!snap.exists || !order) throw new CommandError('NOT_FOUND', '订单不存在', { orderId: x.orderId });
        docs.push({ ...x, order });
      }
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);
      const tickets = await Promise.all(input.orders.map((x) => peekTicket(tx, store, x.orderId)));

      // ---- 校验（全部通过才写） ----
      // 只能是同一组：原单与挂在它上面的加单。
      const roots = new Set(docs.map((d) => (d.order.addOnTo as { orderId: string } | null | undefined)?.orderId ?? d.orderId));
      if (roots.size !== 1) throw bad('只能合并结账同一张原单与它的加单');
      const checks = docs.map((d) => ({ d, r: registerPayment(paymentStateOf(d.order), { amountSen: d.amountSen, orderTotalSen: d.order.totalSen as number }) }));
      // 已收款优先报：多半是后厨刚出餐自动记了收款，前台要据此提醒「不要再收这一碗」。
      const failed = checks.find((c) => !c.r.ok && c.r.error === 'ALREADY_PAID') ?? checks.find((c) => !c.r.ok);
      if (failed && !failed.r.ok) {
        const { d, r } = failed;
        throw new CommandError(PAYMENT_ERROR[r.error], r.error, {
          orderId: d.orderId, paymentState: d.order.paymentState, paidAtMs: d.order.paidAtMs ?? null, totalSen: d.order.totalSen,
          ...(r.error === 'ALREADY_PAID' ? alreadyPaidDetails(d.orderId, d.order) : {}),
        });
      }

      // ---- 写入 ----
      const paid = docs.map((d, i) => ({
        orderId: d.orderId, amountSen: d.amountSen,
        paymentId: writePaymentRegistration(tx, store, {
          orderId: d.orderId, seq: paymentSeqOf(d.order) + 1, amountSen: d.amountSen, businessDate, orderBusinessDate: d.order.businessDate as string,
          occurredAtMs: nowMs, recordedAtMs: nowMs, confirmedBy: actor.uid, source: 'online', registerId: input.claim.registerId,
          operationId: input.operationId, offlineEventId: null, ticket: tickets[i],
        }),
      }));
      markDayActivity(tx, store, businessDate, day, nowMs);
      const amountSen = paid.reduce((s, p) => s + p.amountSen, 0);
      return {
        result: { orders: paid, amountSen, businessDate, paidAtMs: nowMs },
        audit: { entityId: [...roots][0], after: { paymentState: 'paid', orders: paid, amountSen, businessDate } },
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
      const ticket = await peekTicket(tx, store, input.orderId);
      const r = reverseRule(paymentStateOf(order));
      if (!r.ok) throw new CommandError(PAYMENT_ERROR[r.error], r.error);
      // 误登记更正（cause=correction）：出餐前更正的，后厨卡片改回要收钱。
      const { reversalId, orderPatch } = paymentReversalWrites(tx, store, {
        orderId: input.orderId, order, seq: paymentSeqOf(order), cause: 'correction', reason: input.reason, actorUid: actor.uid,
        businessDate, nowMs, operationId: input.operationId, ticket,
      });
      tx.update(store.order(input.orderId), { ...orderPatch, paymentState: r.state.paymentState });
      markDayActivity(tx, store, businessDate, day, nowMs);
      return {
        result: { orderId: input.orderId, reversalId, paymentState: r.state.paymentState },
        audit: { entityId: input.orderId, before: { paymentState: order.paymentState, paidSen: order.paidSen }, after: { paymentState: r.state.paymentState, reason: input.reason } },
      };
    },
  });
}

/**
 * 客人没付就走了（老板）：已记收款的单（多为出餐自动记的）其实没收到钱。一次操作、同一事务里
 * 先冲正这笔收款（`-rev`，cause=not_paid），再按放弃追收记一条 write_off，订单最后是 written_off。
 * 与先「更正收款」再「放弃追收」两步的结果相同；只有一条 operation / 审计。已退款、已取消的单不行。
 */
export async function markNotPaid(db: Firestore, uid: string | undefined, raw: unknown) {
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'reason']);
  const input = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), reason: str(o, 'reason', 200, 2) };
  return runCommand(db, {
    type: 'markNotPaid', storeId: input.storeId, operationId: input.operationId, uid, roles: ['owner'], payload: input,
    run: async ({ tx, store, nowMs, actor }) => {
      // ---- 读取 ----
      const config = await loadStoreConfig(tx, store);
      const order = (await tx.get(store.order(input.orderId))).data();
      if (!order) throw new CommandError('NOT_FOUND', '订单不存在');
      const businessDate = businessDateOf(nowMs, config.businessDay);
      const day = await requireDayOpen(tx, store, businessDate);
      const ticket = await peekTicket(tx, store, input.orderId);

      // ---- 校验：只限已付款、没退过款、没取消的单 ----
      const state = paymentStateOf(order);
      if (state.fulfillmentStatus === 'cancelled') throw new CommandError('ORDER_CANCELLED');
      if (state.paymentState !== 'paid') throw new CommandError('NOT_PAID');
      if (state.refundedSen > 0) throw new CommandError('ALREADY_REFUNDED');
      const rev = reverseRule(state);
      if (!rev.ok) throw new CommandError(PAYMENT_ERROR[rev.error], rev.error);
      const wo = writeOffRule(rev.state);
      if (!wo.ok) throw new CommandError(PAYMENT_ERROR[wo.error], wo.error);

      // ---- 写入 ----
      const { reversalId, original, orderPatch } = paymentReversalWrites(tx, store, {
        orderId: input.orderId, order, seq: paymentSeqOf(order), cause: 'not_paid', reason: input.reason, actorUid: actor.uid,
        businessDate, nowMs, operationId: input.operationId, ticket,
      });
      // 放弃追收记录与 writeOffPayment 完全一样（金额 = 整单金额），日结照旧列入「未收回金额」。
      const n = ((order.writeOffSeq as number | undefined) ?? 0) + 1;
      const writeOffId = `${input.orderId}-w${n}`;
      tx.create(store.writeOff(writeOffId), {
        id: writeOffId, orderId: input.orderId, kind: 'write_off', amountSen: order.totalSen, reason: input.reason, recordedBy: actor.uid,
        businessDate, orderBusinessDate: order.businessDate, occurredAtMs: nowMs, operationId: input.operationId,
      });
      tx.update(store.order(input.orderId), {
        ...orderPatch,
        paymentState: 'written_off', writeOffSeq: n,
        writeOff: { id: writeOffId, amountSen: order.totalSen, reason: input.reason, by: actor.uid, atMs: nowMs, businessDate },
      });
      markDayActivity(tx, store, businessDate, day, nowMs);
      return {
        result: { orderId: input.orderId, paymentState: 'written_off' as const, reversalId, writeOffId, amountSen: order.totalSen as number, businessDate },
        audit: {
          entityId: input.orderId,
          before: { paymentState: order.paymentState, paidSen: order.paidSen, paymentConfirmationMode: order.paymentConfirmationMode ?? 'manual', paymentId: original },
          after: { paymentState: 'written_off', reversalId, writeOffId, reason: input.reason },
        },
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
