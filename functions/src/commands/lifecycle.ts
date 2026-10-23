/**
 * 制作与退款命令：完成出餐、撤回出餐、请求取消、确认后厨取消、老板整单退款（开始制作只为旧版待做单保留）。
 * 状态转换全部交给领域状态机 applyLifecycle；这里负责读取依赖、落实副作用并保持投影一致。
 * 出餐 / 取消最终成立时在同一事务释放仍属于本单的餐牌；牌已属于新单时绝不改动。
 * 厨房命令不读写付款字段：出餐不标已付款。
 */
import { DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import {
  applyLifecycle, LifecycleCommand, LifecycleError, OrderLifecycleState,
} from '../../../src/domain/orderLifecycle';
import { reholdToken, releaseHeldToken, TokenBoard } from '../../../src/domain/tokens';
import { CommandContext, Role, runCommand } from '../core/command';
import { CommandError, ReasonCode } from '../core/errors';
import { bool, int, obj, oneOf, optStr, str, storeId, uuid } from '../core/input';
import { loadStoreConfig, markDayActivity, requireDayOpen } from '../core/store';

const LIFECYCLE_FIELDS: (keyof OrderLifecycleState)[] = [
  'fulfillmentStatus', 'paymentState', 'paidSen', 'refundedSen', 'kitchenCancelRequested', 'cancelReason',
  'startedAtMs', 'startedSource', 'servedAtMs', 'servedBy', 'preServe', 'costAllocated', 'version',
];

function lifecycleOf(order: DocumentData): OrderLifecycleState {
  const s = {} as Record<string, unknown>;
  for (const f of LIFECYCLE_FIELDS) s[f] = order[f] ?? null;
  s.paidSen = order.paidSen ?? 0;
  s.refundedSen = order.refundedSen ?? 0;
  s.kitchenCancelRequested = Boolean(order.kitchenCancelRequested);
  s.costAllocated = order.costAllocated !== false;
  return s as unknown as OrderLifecycleState;
}

const ERROR_MAP: Record<LifecycleError, ReasonCode> = {
  STALE_VERSION: 'STALE_VERSION', INVALID_TRANSITION: 'INVALID_TRANSITION', FORBIDDEN: 'FORBIDDEN',
  UNDO_WINDOW_EXPIRED: 'UNDO_WINDOW_EXPIRED', TOKEN_REASSIGNED: 'TOKEN_REASSIGNED', DAY_CLOSED: 'DAY_CLOSED',
  REASON_REQUIRED: 'REASON_REQUIRED', REFUND_MUST_BE_FULL: 'REFUND_MUST_BE_FULL', ALREADY_REFUNDED: 'ALREADY_REFUNDED',
};

type CommandName = 'startOrder' | 'serveOrder' | 'undoServe' | 'requestCancel' | 'confirmKitchenCancel' | 'rejectKitchenCancel' | 'confirmFullRefund';

const ROLES: Record<CommandName, Role[]> = {
  startOrder: ['kitchen', 'owner'],
  serveOrder: ['kitchen', 'owner'],
  undoServe: ['kitchen', 'owner'],
  requestCancel: ['cashier', 'owner'],
  confirmKitchenCancel: ['kitchen', 'owner'],
  rejectKitchenCancel: ['kitchen', 'owner'],
  confirmFullRefund: ['owner'],
};

function parse(name: CommandName, raw: unknown) {
  const extra = name === 'requestCancel' ? ['reason'] : name === 'confirmFullRefund' ? ['amountSen', 'refundMethod', 'reason'] : name === 'confirmKitchenCancel' ? ['consumed'] : name === 'rejectKitchenCancel' ? ['reason'] : [];
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'expectedVersion', ...extra]);
  const base = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), expectedVersion: int(o, 'expectedVersion', 1, 1_000_000) };
  let cmd: LifecycleCommand;
  let refund: { method: 'cash' | 'qr_manual' | 'unspecified'; reason: string } | null = null;
  let rejectReason: string | null = null;
  switch (name) {
    case 'startOrder': cmd = { type: 'start' }; break;
    case 'serveOrder': cmd = { type: 'serve' }; break;
    case 'undoServe': cmd = { type: 'undo_serve' }; break;
    // 自动制作中不证明已下锅：后厨须明确选择「未做」或「已消耗」。
    case 'confirmKitchenCancel': cmd = { type: 'confirm_kitchen_cancel', consumed: bool(o, 'consumed') }; break;
    // 「继续做，拒绝取消」：原因可选（例如「已送餐，顾客仍要」）。
    case 'rejectKitchenCancel': cmd = { type: 'reject_cancel' }; rejectReason = optStr(o, 'reason', 100); break;
    case 'requestCancel': cmd = { type: 'request_cancel', reason: str(o, 'reason', 200) }; break;
    case 'confirmFullRefund':
      cmd = { type: 'confirm_full_refund', amountSen: int(o, 'amountSen', 1, 10_000_000) };
      // 退款不强制选渠道；旧客户端传 cash / qr_manual 时照实记录。
      refund = { method: o.refundMethod === undefined ? 'unspecified' : oneOf(o, 'refundMethod', ['cash', 'qr_manual', 'unspecified'] as const), reason: str(o, 'reason', 200, 2) };
      break;
  }
  return { ...base, cmd, refund, rejectReason };
}

export async function lifecycleCommand(db: Firestore, name: CommandName, uid: string | undefined, raw: unknown) {
  const input = parse(name, raw);
  return runCommand(db, {
    type: name, storeId: input.storeId, operationId: input.operationId, uid, roles: ROLES[name], payload: input,
    run: (ctx) => lifecycleTx(ctx, name, input),
  });
}

async function lifecycleTx(ctx: CommandContext, name: CommandName, input: ReturnType<typeof parse>) {
  const { tx, store, nowMs, actor } = ctx;
  // ---- 读取 ----
  const config = await loadStoreConfig(tx, store);
  const orderRef = store.order(input.orderId);
  const orderSnap = await tx.get(orderRef);
  const order = orderSnap.data();
  if (!orderSnap.exists || !order) throw new CommandError('NOT_FOUND', '订单不存在');
  if (order.kitchenRouting === 'manual' && name !== 'requestCancel' && name !== 'confirmFullRefund') {
    throw new CommandError('OFFLINE_REVIEW_REQUIRED', '人工单需先核对后转电子厨单');
  }
  const tokenRef = store.token(order.tokenNumber);
  const tokenData = (await tx.get(tokenRef)).data();
  const orderDaySnap = await tx.get(store.businessDay(order.businessDate));
  const orderDayClosed = Boolean(orderDaySnap.exists && orderDaySnap.data()?.state !== 'open');
  const costRef = store.orderCost(input.orderId);
  const cost = (await tx.get(costRef)).data();
  const today = businessDateOf(nowMs, config.businessDay);
  // 退款/取消写入今日账本，受今日写入屏障约束。
  const writesLedger = name === 'confirmFullRefund' || name === 'requestCancel' || name === 'confirmKitchenCancel';
  const todayDay = writesLedger ? await requireDayOpen(tx, store, today) : null;

  const before = lifecycleOf(order);
  // 撤回出餐：原牌空闲且最后一次由本单释放（期间没给过别的单）才可重新占用。
  const tokenReclaimable = Boolean(tokenData && tokenData.state === 'available' && tokenData.lastReleasedOrderId === input.orderId);
  const r = applyLifecycle(before, input.cmd, {
    nowMs, actorUid: actor.uid, actorRole: actor.role, expectedVersion: input.expectedVersion,
    tokenReclaimable, dayClosed: orderDayClosed,
  });
  if (!r.ok) throw new CommandError(ERROR_MAP[r.error], r.error, { currentVersion: before.version });

  // ---- 写入 ----
  const after = r.state;
  const patch: Record<string, unknown> = { updatedAtMs: nowMs };
  for (const f of LIFECYCLE_FIELDS) patch[f] = after[f];

  for (const effect of r.effects) {
    if (effect === 'token_release' || effect === 'token_rehold') {
      if (!tokenData) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
      const board: TokenBoard = {
        [order.tokenNumber]: { number: order.tokenNumber, state: tokenData.state, orderId: tokenData.orderId, version: tokenData.version, lastReleasedOrderId: tokenData.lastReleasedOrderId ?? null },
      };
      if (effect === 'token_release') {
        // 牌已不属于本单（例如离线补账的 history_only 单）：不动牌，只记录订单。
        const rel = releaseHeldToken(board, order.tokenNumber, input.orderId);
        if (rel?.ok) tx.set(tokenRef, { ...rel.token, updatedAtMs: nowMs });
        patch.tokenReleasedAtMs = nowMs;
        patch.tokenReleaseSource = after.fulfillmentStatus === 'cancelled' ? 'cancelled' : 'served';
      } else {
        const tr = reholdToken(board, order.tokenNumber, input.orderId);
        if (!tr.ok) throw new CommandError('TOKEN_REASSIGNED');
        tx.set(tokenRef, { ...tr.token, updatedAtMs: nowMs });
        patch.tokenReleasedAtMs = null;
        patch.tokenReleaseSource = null;
      }
    }
    if (effect === 'cost_reverse' && cost) {
      const reverse = -(cost.allocatedCostUnits as number);
      tx.create(store.costEvent(`${input.operationId}-reverse`), {
        id: `${input.operationId}-reverse`, orderId: input.orderId, businessDate: today, costUnits: reverse, kind: 'reverse', atMs: nowMs,
      });
      tx.update(costRef, {
        allocatedCostUnits: 0,
        allocationEvents: FieldValue.arrayUnion({ id: `${input.operationId}-reverse`, type: 'reverse', costUnits: reverse, businessDate: today, atMs: nowMs }),
      });
    }
    if (effect === 'kitchen_projection_update') {
      tx.update(store.ticket(input.orderId), {
        fulfillmentStatus: after.fulfillmentStatus, kitchenCancelRequested: after.kitchenCancelRequested,
        startedAtMs: after.startedAtMs, startedSource: after.startedSource, servedAtMs: after.servedAtMs, version: after.version,
        cancelReason: after.kitchenCancelRequested || after.fulfillmentStatus === 'cancelled' ? after.cancelReason : null,
      });
    }
    if (effect === 'refund_recorded' && input.refund) {
      const refundId = `${input.orderId}-r1`;
      tx.create(store.refund(refundId), {
        id: refundId, orderId: input.orderId, originalPaymentId: (order.paymentId as string | null | undefined) ?? `${input.orderId}-p1`, originalMethod: order.paymentMethod ?? null,
        method: input.refund.method, amountSen: input.cmd.type === 'confirm_full_refund' ? input.cmd.amountSen : 0,
        reason: input.refund.reason, confirmedBy: actor.uid, businessDate: today, occurredAtMs: nowMs,
      });
      patch.refundId = refundId;
    }
  }
  if (input.cmd.type === 'confirm_kitchen_cancel') patch.cancelCostDecision = input.cmd.consumed ? 'consumed' : 'not_made';
  if (input.cmd.type === 'reject_cancel') {
    // 保留本次取消申请与拒绝记录，前台据此提示（订单页）。
    patch.cancelRejection = { requestedReason: before.cancelReason, reason: input.rejectReason, by: actor.uid, atMs: nowMs };
  }
  tx.update(orderRef, patch);
  if (todayDay) markDayActivity(tx, store, today, todayDay, nowMs);

  return {
    result: { orderId: input.orderId, version: after.version, fulfillmentStatus: after.fulfillmentStatus, paymentState: after.paymentState, effects: r.effects },
    audit: {
      entityId: input.orderId,
      before: { fulfillmentStatus: before.fulfillmentStatus, paymentState: before.paymentState, version: before.version },
      after: { fulfillmentStatus: after.fulfillmentStatus, paymentState: after.paymentState, version: after.version },
    },
  };
}
