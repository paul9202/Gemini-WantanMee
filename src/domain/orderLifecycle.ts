/**
 * 订单制作与收款状态机。制作（fulfillment）、付款（payment）、餐牌、同步分别建模：
 * 下单即送厨（电子单自动进入制作中），收款由前台另行确认；取消制作 ≠ 已退款；
 * 已消耗食材的成本不因退款或取消消失。三件事（下单、出餐、收款）可以任意先后发生，彼此不推断。
 * 纯函数只给出新状态与「副作用意图」，由命令层在同一事务里落实。
 */

export type Fulfillment = 'queued' | 'preparing' | 'served' | 'cancelled';
/**
 * unpaid：待登记收款；paid：员工已确认全额收到；refund_due / refunded：已付款单取消或退款；
 * not_due：未付款即取消，应收清零，不产生付款或退款事实。
 * written_off：老板确认收不回、放弃追收。不是已付款、不计实收；之后收到钱须老板先恢复为待收款再登记。
 * 旧订单（schemaVersion ≤ 2）下单即已付，只会出现 paid / refund_due / refunded。
 */
export type PaymentState = 'unpaid' | 'paid' | 'refund_due' | 'refunded' | 'not_due' | 'written_off';
export type ActorRole = 'owner' | 'cashier' | 'kitchen';
/** auto：下单时系统自动置为制作中，只表示已进入厨房流程，不代表厨师已下锅。 */
export type StartSource = 'auto' | 'manual';

export const UNDO_SERVE_WINDOW_MS = 30_000;

export interface OrderLifecycleState {
  fulfillmentStatus: Fulfillment;
  paymentState: PaymentState;
  paidSen: number;
  refundedSen: number;
  kitchenCancelRequested: boolean;
  cancelReason: string | null;
  startedAtMs: number | null;
  /** 旧订单没有这个字段（null）。 */
  startedSource: StartSource | null;
  servedAtMs: number | null;
  servedBy: string | null;
  /** 出餐前的状态与开始时间，供撤回恢复原排序与耗时起点。 */
  preServe: { status: 'queued' | 'preparing'; startedAtMs: number | null } | null;
  /** 理论成本是否仍计入（未做取消会反转）。 */
  costAllocated: boolean;
  version: number;
}

export type LifecycleCommand =
  | { type: 'start' }
  | { type: 'serve' }
  | { type: 'undo_serve' }
  | { type: 'request_cancel'; reason: string }
  /** consumed：后厨确认食材是否已经用掉。未做 → 反转成本；已消耗 → 保留成本。 */
  | { type: 'confirm_kitchen_cancel'; consumed: boolean }
  /** 后厨「继续做，拒绝取消」：结束本次取消申请，订单恢复正常制作 / 出餐。 */
  | { type: 'reject_cancel' }
  | { type: 'confirm_full_refund'; amountSen: number };

export interface LifecycleContext {
  nowMs: number;
  actorUid: string;
  actorRole: ActorRole;
  expectedVersion: number;
  /** 撤回出餐：原牌仍空闲，且最后一次是由本单释放（期间没有被别的订单用过）。 */
  tokenReclaimable?: boolean;
  /** 所属营业日已关账。 */
  dayClosed?: boolean;
}

export type LifecycleEffect =
  | 'token_release' | 'token_rehold' | 'cost_reverse' | 'kitchen_projection_update' | 'refund_recorded';

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
  reject_cancel: ['kitchen', 'owner'],
  confirm_full_refund: ['owner'],
};

/**
 * 新接单的状态。电子单直接制作中（自动开始时间 = 接单时间）；人工单（离线）仍是待做，
 * 由纸单流转，只有尚未制作的才可转电子厨单。默认待收款、不产生付款流水。
 * legacyPaidSen：旧格式离线日志在下单时已收款，按原事实导入。
 */
export function newAcceptedState(opts: { acceptedAtMs: number; kitchenRouting: 'digital' | 'manual'; legacyPaidSen?: number | null }): OrderLifecycleState {
  const digital = opts.kitchenRouting === 'digital';
  const paid = typeof opts.legacyPaidSen === 'number';
  return {
    fulfillmentStatus: digital ? 'preparing' : 'queued',
    paymentState: paid ? 'paid' : 'unpaid', paidSen: paid ? opts.legacyPaidSen! : 0, refundedSen: 0, kitchenCancelRequested: false,
    cancelReason: null, startedAtMs: digital ? opts.acceptedAtMs : null, startedSource: digital ? 'auto' : null,
    servedAtMs: null, servedBy: null, preServe: null, costAllocated: true, version: 1,
  };
}

/** 取消最终成立时的付款状态：已付 → 应退款；未付 → 应收清零（不退款、不再待收）。 */
function paymentAfterCancel(p: PaymentState): PaymentState {
  if (p === 'paid') return 'refund_due';
  if (p === 'unpaid') return 'not_due';
  return p;
}

export function applyLifecycle(s: OrderLifecycleState, cmd: LifecycleCommand, ctx: LifecycleContext): LifecycleResult {
  if (!ALLOWED[cmd.type].includes(ctx.actorRole)) return { ok: false, error: 'FORBIDDEN' };
  if (ctx.expectedVersion !== s.version) return { ok: false, error: 'STALE_VERSION' };
  const next = (patch: Partial<OrderLifecycleState>, effects: LifecycleEffect[]): LifecycleResult => ({
    ok: true, state: { ...s, ...patch, version: s.version + 1 }, effects,
  });

  switch (cmd.type) {
    case 'start':
      // 只为旧版遗留的待做电子单保留；新单已自动制作中。
      if (s.fulfillmentStatus !== 'queued' || s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      return next({ fulfillmentStatus: 'preparing', startedAtMs: ctx.nowMs, startedSource: 'manual' }, ['kitchen_projection_update']);

    case 'serve':
      if (s.fulfillmentStatus !== 'queued' && s.fulfillmentStatus !== 'preparing') return { ok: false, error: 'INVALID_TRANSITION' };
      if (s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      // 出餐即释放餐牌，与是否付款无关；未付款的账仍绑定原订单 ID。
      return next(
        {
          fulfillmentStatus: 'served', servedAtMs: ctx.nowMs, servedBy: ctx.actorUid,
          preServe: { status: s.fulfillmentStatus, startedAtMs: s.startedAtMs },
        },
        ['token_release', 'kitchen_projection_update'],
      );

    case 'undo_serve': {
      if (s.fulfillmentStatus !== 'served' || !s.preServe || s.servedAtMs === null) return { ok: false, error: 'INVALID_TRANSITION' };
      if (ctx.actorRole !== 'owner' && ctx.actorUid !== s.servedBy) return { ok: false, error: 'FORBIDDEN' };
      if (ctx.nowMs - s.servedAtMs >= UNDO_SERVE_WINDOW_MS) return { ok: false, error: 'UNDO_WINDOW_EXPIRED' };
      if (ctx.dayClosed) return { ok: false, error: 'DAY_CLOSED' };
      // 原牌已分配给新单：不抢牌，由前台处理。撤回不影响已登记的收款。
      if (!ctx.tokenReclaimable) return { ok: false, error: 'TOKEN_REASSIGNED' };
      return next(
        { fulfillmentStatus: s.preServe.status, startedAtMs: s.preServe.startedAtMs, servedAtMs: null, servedBy: null, preServe: null },
        ['token_rehold', 'kitchen_projection_update'],
      );
    }

    case 'request_cancel': {
      const reason = cmd.reason.trim();
      if (!reason) return { ok: false, error: 'REASON_REQUIRED' };
      if (s.fulfillmentStatus === 'queued') {
        // 尚未进入厨房的待做单（旧单 / 人工单）：立即取消、反转理论成本、释放餐牌。
        return next(
          { fulfillmentStatus: 'cancelled', cancelReason: reason.slice(0, 200), costAllocated: false, paymentState: paymentAfterCancel(s.paymentState) },
          ['cost_reverse', 'token_release', 'kitchen_projection_update'],
        );
      }
      if (s.fulfillmentStatus === 'preparing' && !s.kitchenCancelRequested) {
        // 制作中：等后厨确认停做；期间继续占牌，也不能被正常出餐。
        return next({ kitchenCancelRequested: true, cancelReason: reason.slice(0, 200) }, ['kitchen_projection_update']);
      }
      return { ok: false, error: 'INVALID_TRANSITION' };
    }

    case 'confirm_kitchen_cancel':
      if (s.fulfillmentStatus !== 'preparing' || !s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      // 自动制作中不证明已下锅：按后厨确认决定成本。取消成立的同一事务释放餐牌。
      return next(
        {
          fulfillmentStatus: 'cancelled', kitchenCancelRequested: false, paymentState: paymentAfterCancel(s.paymentState),
          costAllocated: cmd.consumed ? s.costAllocated : false,
        },
        cmd.consumed ? ['token_release', 'kitchen_projection_update'] : ['cost_reverse', 'token_release', 'kitchen_projection_update'],
      );

    case 'reject_cancel':
      // 只结束取消申请：不改付款、不退款、不释放餐牌；实际出餐仍需「完成出餐」。
      if (s.fulfillmentStatus !== 'preparing' || !s.kitchenCancelRequested) return { ok: false, error: 'INVALID_TRANSITION' };
      return next({ kitchenCancelRequested: false, cancelReason: null }, ['kitchen_projection_update']);

    case 'confirm_full_refund':
      if (s.paymentState === 'refunded') return { ok: false, error: 'ALREADY_REFUNDED' };
      if (s.paymentState !== 'paid' && s.paymentState !== 'refund_due') return { ok: false, error: 'INVALID_TRANSITION' };
      if (cmd.amountSen !== s.paidSen - s.refundedSen) return { ok: false, error: 'REFUND_MUST_BE_FULL' };
      if (s.fulfillmentStatus === 'queued' || s.fulfillmentStatus === 'preparing') return { ok: false, error: 'INVALID_TRANSITION' };
      // 已出餐退款：保留出餐历史与成本，只减少净收款。
      return next({ paymentState: 'refunded', refundedSen: s.refundedSen + cmd.amountSen }, ['refund_recorded']);
  }
}

// ---------- 收款登记（与制作分离） ----------

export type PaymentError = 'ALREADY_PAID' | 'ORDER_CANCELLED' | 'CANCEL_PENDING' | 'AMOUNT_MISMATCH' | 'NOT_PAID' | 'WRITTEN_OFF' | 'NOT_UNPAID';

export type PaymentResult = { ok: true; state: OrderLifecycleState } | { ok: false; error: PaymentError };

/**
 * 员工确认整单全额已收到。不选渠道、不输入实收找零；不执行扣款或转账。
 * 不改变制作版本号：收款与后厨出餐并发时互不让对方过期。
 */
export function registerPayment(s: OrderLifecycleState, input: { amountSen: number; orderTotalSen: number }): PaymentResult {
  if (s.fulfillmentStatus === 'cancelled' || s.paymentState === 'not_due') return { ok: false, error: 'ORDER_CANCELLED' };
  if (s.paymentState === 'written_off') return { ok: false, error: 'WRITTEN_OFF' };
  if (s.paymentState !== 'unpaid') return { ok: false, error: 'ALREADY_PAID' };
  if (s.kitchenCancelRequested) return { ok: false, error: 'CANCEL_PENDING' };
  if (input.amountSen !== input.orderTotalSen || input.amountSen <= 0) return { ok: false, error: 'AMOUNT_MISMATCH' };
  return { ok: true, state: { ...s, paymentState: 'paid', paidSen: input.amountSen } };
}

/**
 * 老板更正误登记的收款：保留原收款，追加反向调整，订单回到待收款（取消单回到应收清零）。
 * 这不是实际退钱；已经退过款的不能再更正。
 */
export function reversePayment(s: OrderLifecycleState): PaymentResult {
  if ((s.paymentState !== 'paid' && s.paymentState !== 'refund_due') || s.paidSen <= 0) return { ok: false, error: 'NOT_PAID' };
  if (s.refundedSen > 0) return { ok: false, error: 'NOT_PAID' };
  return { ok: true, state: { ...s, paymentState: s.fulfillmentStatus === 'cancelled' ? 'not_due' : 'unpaid', paidSen: 0 } };
}

/**
 * 老板放弃追收：仅限仍待收款的有效订单（取消申请中先等后厨处理）。只改付款状态，
 * 不产生付款或退款事实，不动成本、餐牌与制作状态。
 */
export function writeOffUnpaid(s: OrderLifecycleState): PaymentResult {
  if (s.fulfillmentStatus === 'cancelled' || s.paymentState === 'not_due') return { ok: false, error: 'ORDER_CANCELLED' };
  if (s.kitchenCancelRequested) return { ok: false, error: 'CANCEL_PENDING' };
  if (s.paymentState !== 'unpaid') return { ok: false, error: 'NOT_UNPAID' };
  return { ok: true, state: { ...s, paymentState: 'written_off' } };
}

/** 放弃追收后又收到钱：老板先恢复为待收款（留审计），再由主点单平板按正常流程登记。 */
export function reinstateWrittenOff(s: OrderLifecycleState): PaymentResult {
  if (s.paymentState !== 'written_off') return { ok: false, error: 'NOT_UNPAID' };
  return { ok: true, state: { ...s, paymentState: 'unpaid' } };
}

/** 制作状态 × 付款状态的显示分组。 */
export function isAwaitingPayment(o: { fulfillmentStatus: Fulfillment; paymentState: PaymentState }): boolean {
  return o.paymentState === 'unpaid' && o.fulfillmentStatus !== 'cancelled';
}
