/**
 * 订单制作与收款状态机。制作（fulfillment）、付款（payment）、餐牌、同步分别建模：
 * 取消制作 ≠ 已退款；已消耗食材的成本不因退款或取消消失。
 * 纯函数只给出新状态与「副作用意图」，由命令层在同一事务里落实。
 */

export type Fulfillment = 'queued' | 'preparing' | 'served' | 'cancelled';
export type PaymentState = 'paid' | 'refund_due' | 'refunded';
export type ActorRole = 'owner' | 'cashier' | 'kitchen';

export const UNDO_SERVE_WINDOW_MS = 30_000;

export interface OrderLifecycleState {
  fulfillmentStatus: Fulfillment;
  paymentState: PaymentState;
  paidSen: number;
  refundedSen: number;
  kitchenCancelRequested: boolean;
  cancelReason: string | null;
  startedAtMs: number | null;
  servedAtMs: number | null;
  servedBy: string | null;
  /** 出餐前的状态与开始时间，供撤回恢复原排序与耗时起点。 */
  preServe: { status: 'queued' | 'preparing'; startedAtMs: number | null } | null;
  /** 理论成本是否仍计入（待做取消会反转）。 */
  costAllocated: boolean;
  version: number;
}

export type LifecycleCommand =
  | { type: 'start' }
  | { type: 'serve' }
  | { type: 'undo_serve' }
  | { type: 'request_cancel'; reason: string }
  | { type: 'confirm_kitchen_cancel' }
  | { type: 'confirm_full_refund'; amountSen: number };

export interface LifecycleContext {
  nowMs: number;
  actorUid: string;
  actorRole: ActorRole;
  expectedVersion: number;
  /** 原订单仍持有原餐牌（待回收状态）。撤回出餐需要。 */
  tokenStillHeldByOrder?: boolean;
  /** 所属营业日已关账。 */
  dayClosed?: boolean;
}

export type LifecycleEffect =
  | 'token_awaiting_return' | 'token_revert_held' | 'cost_reverse' | 'kitchen_projection_update' | 'refund_recorded';

export type LifecycleError =
  | 'STALE_VERSION' | 'INVALID_TRANSITION' | 'FORBIDDEN' | 'UNDO_WINDOW_EXPIRED' | 'TOKEN_REASSIGNED'
  | 'DAY_CLOSED' | 'REASON_REQUIRED' | 'REFUND_MUST_BE_FULL' | 'ALREADY_REFUNDED';

export type LifecycleResult =
  | { ok: true; state: OrderLifecycleState; effects: LifecycleEffect[] }
  | { ok: false; error: LifecycleError };

const ALLOWED: Record<LifecycleCommand['type'], ActorRole[]> = {
  start: ['kitchen', 'owner'],
  serve: ['kitchen', 'owner'],
  undo_serve: ['kitchen', 'owner'],
  request_cancel: ['cashier', 'owner'],
  confirm_kitchen_cancel: ['kitchen', 'owner'],
  confirm_full_refund: ['owner'],
};

export function newAcceptedState(paidSen: number): OrderLifecycleState {
  return {
    fulfillmentStatus: 'queued', paymentState: 'paid', paidSen, refundedSen: 0, kitchenCancelRequested: false,
    cancelReason: null, startedAtMs: null, servedAtMs: null, servedBy: null, preServe: null, costAllocated: true, version: 1,
  };
}

export function applyLifecycle(s: OrderLifecycleState, cmd: LifecycleCommand, ctx: LifecycleContext): LifecycleResult {
  if (!ALLOWED[cmd.type].includes(ctx.actorRole)) return { ok: false, error: 'FORBIDDEN' };
  if (ctx.expectedVersion !== s.version) return { ok: false, error: 'STALE_VERSION' };
  const next = (patch: Partial<OrderLifecycleState>, effects: LifecycleEffect[]): LifecycleResult => ({
    ok: true, state: { ...s, ...patch, version: s.version + 1 }, effects,
  });

  switch (cmd.type) {
    case 'start':
      if (s.fulfillmentStatus !== 'queued' || s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      return next({ fulfillmentStatus: 'preparing', startedAtMs: ctx.nowMs }, ['kitchen_projection_update']);

    case 'serve':
      if (s.fulfillmentStatus !== 'queued' && s.fulfillmentStatus !== 'preparing') return { ok: false, error: 'INVALID_TRANSITION' };
      if (s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      return next(
        {
          fulfillmentStatus: 'served', servedAtMs: ctx.nowMs, servedBy: ctx.actorUid,
          preServe: { status: s.fulfillmentStatus, startedAtMs: s.startedAtMs },
        },
        ['token_awaiting_return', 'kitchen_projection_update'],
      );

    case 'undo_serve': {
      if (s.fulfillmentStatus !== 'served' || !s.preServe || s.servedAtMs === null) return { ok: false, error: 'INVALID_TRANSITION' };
      if (ctx.actorRole !== 'owner' && ctx.actorUid !== s.servedBy) return { ok: false, error: 'FORBIDDEN' };
      if (ctx.nowMs - s.servedAtMs >= UNDO_SERVE_WINDOW_MS) return { ok: false, error: 'UNDO_WINDOW_EXPIRED' };
      if (ctx.dayClosed) return { ok: false, error: 'DAY_CLOSED' };
      if (!ctx.tokenStillHeldByOrder) return { ok: false, error: 'TOKEN_REASSIGNED' };
      return next(
        { fulfillmentStatus: s.preServe.status, startedAtMs: s.preServe.startedAtMs, servedAtMs: null, servedBy: null, preServe: null },
        ['token_revert_held', 'kitchen_projection_update'],
      );
    }

    case 'request_cancel': {
      const reason = cmd.reason.trim();
      if (!reason) return { ok: false, error: 'REASON_REQUIRED' };
      if (s.fulfillmentStatus === 'queued') {
        // 未开始制作：立即取消、反转理论成本、牌待回收、标记应退款待处理。
        return next(
          {
            fulfillmentStatus: 'cancelled', cancelReason: reason.slice(0, 200), costAllocated: false,
            paymentState: s.paymentState === 'paid' ? 'refund_due' : s.paymentState,
          },
          ['cost_reverse', 'token_awaiting_return', 'kitchen_projection_update'],
        );
      }
      if (s.fulfillmentStatus === 'preparing' && !s.kitchenCancelRequested) {
        return next({ kitchenCancelRequested: true, cancelReason: reason.slice(0, 200) }, ['kitchen_projection_update']);
      }
      return { ok: false, error: 'INVALID_TRANSITION' };
    }

    case 'confirm_kitchen_cancel':
      if (s.fulfillmentStatus !== 'preparing' || !s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      // 制作中已消耗食材：成本保留，不反转；之后登记的关联损耗不得重复扣。
      return next(
        {
          fulfillmentStatus: 'cancelled', kitchenCancelRequested: false,
          paymentState: s.paymentState === 'paid' ? 'refund_due' : s.paymentState,
        },
        ['token_awaiting_return', 'kitchen_projection_update'],
      );

    case 'confirm_full_refund':
      if (s.paymentState === 'refunded') return { ok: false, error: 'ALREADY_REFUNDED' };
      if (cmd.amountSen !== s.paidSen - s.refundedSen) return { ok: false, error: 'REFUND_MUST_BE_FULL' };
      if (s.fulfillmentStatus === 'queued' || s.fulfillmentStatus === 'preparing') return { ok: false, error: 'INVALID_TRANSITION' };
      // 已出餐退款：保留出餐历史与成本，只减少净收款。
      return next({ paymentState: 'refunded', refundedSen: s.refundedSen + cmd.amountSen }, ['refund_recorded']);
  }
}
