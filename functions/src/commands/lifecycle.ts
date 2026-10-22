/**
 * 制作与退款命令：开始制作、完成出餐、撤回出餐、请求取消、确认后厨取消、老板整单退款。
 * 状态转换全部交给领域状态机 applyLifecycle；这里负责读取依赖、落实副作用并保持投影一致。
 */
import { DocumentData, FieldValue, Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import {
  applyLifecycle, LifecycleCommand, LifecycleError, OrderLifecycleState,
} from '../../../src/domain/orderLifecycle';
import { markAwaitingReturn, revertToHeld, TokenBoard, TokenResult } from '../../../src/domain/tokens';
import { CommandContext, Role, runCommand } from '../core/command';
import { CommandError, ReasonCode } from '../core/errors';
import { int, obj, oneOf, str, storeId, uuid } from '../core/input';
import { loadStoreConfig, markDayActivity, requireDayOpen } from '../core/store';

const LIFECYCLE_FIELDS: (keyof OrderLifecycleState)[] = [
  'fulfillmentStatus', 'paymentState', 'paidSen', 'refundedSen', 'kitchenCancelRequested', 'cancelReason',
  'startedAtMs', 'servedAtMs', 'servedBy', 'preServe', 'costAllocated', 'version',
];

function lifecycleOf(order: DocumentData): OrderLifecycleState {
  const s = {} as Record<string, unknown>;
  for (const f of LIFECYCLE_FIELDS) s[f] = order[f] ?? null;
  return s as unknown as OrderLifecycleState;
}

const ERROR_MAP: Record<LifecycleError, ReasonCode> = {
  STALE_VERSION: 'STALE_VERSION', INVALID_TRANSITION: 'INVALID_TRANSITION', FORBIDDEN: 'FORBIDDEN',
  UNDO_WINDOW_EXPIRED: 'UNDO_WINDOW_EXPIRED', TOKEN_REASSIGNED: 'TOKEN_REASSIGNED', DAY_CLOSED: 'DAY_CLOSED',
  REASON_REQUIRED: 'REASON_REQUIRED', REFUND_MUST_BE_FULL: 'REFUND_MUST_BE_FULL', ALREADY_REFUNDED: 'ALREADY_REFUNDED',
};

type CommandName = 'startOrder' | 'serveOrder' | 'undoServe' | 'requestCancel' | 'confirmKitchenCancel' | 'confirmFullRefund';

const ROLES: Record<CommandName, Role[]> = {
  startOrder: ['kitchen', 'owner'],
  serveOrder: ['kitchen', 'owner'],
  undoServe: ['kitchen', 'owner'],
  requestCancel: ['cashier', 'owner'],
  confirmKitchenCancel: ['kitchen', 'owner'],
  confirmFullRefund: ['owner'],
};

function parse(name: CommandName, raw: unknown) {
  const extra = name === 'requestCancel' ? ['reason'] : name === 'confirmFullRefund' ? ['amountSen', 'refundMethod', 'reason'] : [];
  const o = obj(raw, ['storeId', 'operationId', 'orderId', 'expectedVersion', ...extra]);
  const base = { storeId: storeId(o), operationId: uuid(o, 'operationId'), orderId: uuid(o, 'orderId'), expectedVersion: int(o, 'expectedVersion', 1, 1_000_000) };
  let cmd: LifecycleCommand;
  let refund: { method: 'cash' | 'qr_manual'; reason: string } | null = null;
  switch (name) {
    case 'startOrder': cmd = { type: 'start' }; break;
    case 'serveOrder': cmd = { type: 'serve' }; break;
    case 'undoServe': cmd = { type: 'undo_serve' }; break;
    case 'confirmKitchenCancel': cmd = { type: 'confirm_kitchen_cancel' }; break;
    case 'requestCancel': cmd = { type: 'request_cancel', reason: str(o, 'reason', 200) }; break;
    case 'confirmFullRefund':
      cmd = { type: 'confirm_full_refund', amountSen: int(o, 'amountSen', 1, 10_000_000) };
      refund = { method: oneOf(o, 'refundMethod', ['cash', 'qr_manual'] as const), reason: str(o, 'reason', 200, 2) };
      break;
  }
  return { ...base, cmd, refund };
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
  const tokenHeld = Boolean(tokenData && tokenData.orderId === input.orderId && tokenData.state === 'awaiting_return');
  const r = applyLifecycle(before, input.cmd, {
    nowMs, actorUid: actor.uid, actorRole: actor.role, expectedVersion: input.expectedVersion,
    tokenStillHeldByOrder: tokenHeld, dayClosed: orderDayClosed,
  });
  if (!r.ok) throw new CommandError(ERROR_MAP[r.error], r.error, { currentVersion: before.version });

  // ---- 写入 ----
  const after = r.state;
  const patch: Record<string, unknown> = { updatedAtMs: nowMs };
  for (const f of LIFECYCLE_FIELDS) patch[f] = after[f];

  for (const effect of r.effects) {
    if (effect === 'token_awaiting_return' || effect === 'token_revert_held') {
      if (!tokenData) throw new CommandError('STORE_NOT_CONFIGURED', '餐牌未初始化');
      const board: TokenBoard = { [order.tokenNumber]: { number: order.tokenNumber, state: tokenData.state, orderId: tokenData.orderId, version: tokenData.version } };
      const tr: TokenResult = effect === 'token_awaiting_return'
        ? markAwaitingReturn(board, order.tokenNumber, input.orderId)
        : revertToHeld(board, order.tokenNumber, input.orderId);
      if (!tr.ok) throw new CommandError(effect === 'token_revert_held' ? 'TOKEN_REASSIGNED' : 'TOKEN_NOT_HELD_BY_ORDER');
      tx.set(tokenRef, { ...tr.token, updatedAtMs: nowMs });
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
        startedAtMs: after.startedAtMs, servedAtMs: after.servedAtMs, version: after.version,
        cancelReason: after.kitchenCancelRequested || after.fulfillmentStatus === 'cancelled' ? after.cancelReason : null,
      });
    }
    if (effect === 'refund_recorded' && input.refund) {
      const refundId = `${input.orderId}-r1`;
      tx.create(store.refund(refundId), {
        id: refundId, orderId: input.orderId, originalPaymentId: `${input.orderId}-p1`, originalMethod: order.paymentMethod,
        method: input.refund.method, amountSen: input.cmd.type === 'confirm_full_refund' ? input.cmd.amountSen : 0,
        reason: input.refund.reason, confirmedBy: actor.uid, businessDate: today, occurredAtMs: nowMs,
      });
      patch.refundId = refundId;
    }
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
