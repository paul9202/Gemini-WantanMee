/**
 * 离线营业：事件信封与本机餐牌叠加（03 §7）。
 * 指定主收银机断网时，下单（可未付款）、收款确认、人工交接、人工出餐（同时释放餐牌）都写成不可变的追加事件，
 * 与在线命令共用同一个本机序号流；联网后按序号补同步。离线单一律 kitchenRouting=manual，
 * 补同步不会自动送厨、不重扣成本。收款确认只关联订单 ID，不占牌也不释放牌。
 * 旧格式日志（下单即收款、token_returned 人工回收）仍可解析与补同步。
 */
import type { OrderLineInput } from './cart';
import type { ServiceMode } from './menu';
import type { LegacyPaymentMethod } from './payment';
import { TokenBoard, TokenState } from './tokens';

export type OfflineEventType =
  | 'offline_order_created' | 'offline_payment_recorded' | 'manual_handoff' | 'manual_served' | 'token_returned' | 'sequence_void';

export interface OfflineOrderPayload {
  clientOrderId: string;
  offlineReceiptNumber: string;
  tokenNumber: number;
  /** 行没有单独标明时的默认就餐方式。 */
  serviceMode: ServiceMode;
  menuVersion: string;
  /** serviceMode：行级堂食/打包；旧日志没有，按整单。 */
  lines: OrderLineInput[];
  totalSen: number;
  /** null：新流程，下单未付款。旧格式日志为下单即收款的真实渠道记录。 */
  payment: { method: LegacyPaymentMethod; tenderedSen: number | null; qrExternalVerificationNote: string | null } | null;
}

/** 员工确认整单已收到（不分渠道）。clientOrderId 可以是离线单，也可以是之前的在线单。 */
export interface OfflinePaymentPayload {
  clientOrderId: string;
  amountSen: number;
}

export type OfflinePayload =
  | { type: 'offline_order_created'; payload: OfflineOrderPayload }
  | { type: 'offline_payment_recorded'; payload: OfflinePaymentPayload }
  | { type: 'manual_handoff'; payload: { clientOrderId: string } }
  | { type: 'manual_served'; payload: { clientOrderId: string } }
  | { type: 'token_returned'; payload: { clientOrderId: string; tokenNumber: number } }
  /**
   * 作废一个已分配但最终没有被服务器接纳的序号（例如在线命令被明确拒绝，而其后已有离线事件）。
   * 只补上序号空位，不产生任何账务。
   */
  | { type: 'sequence_void'; payload: { clientOrderId: string; operationId: string } };

export type OfflineEvent = {
  eventId: string;
  registerId: string;
  deviceId: string;
  registerEpoch: number;
  sequence: number;
  shiftId: string;
  occurredAtDeviceMs: number;
  /** 最近一次联网时测得的「服务器时间 − 设备时间」。 */
  lastServerOffsetMs: number;
} & OfflinePayload;

/** 服务器对单个事件的处理结果。uploaded 只表示收件，不表示已入账。 */
export type OfflineEventStatus = 'accepted' | 'needs_review' | 'blocked' | 'rejected';

export type OfflineReviewReason =
  | 'REGISTER_REVOKED' | 'SEQUENCE_GAP' | 'SEQUENCE_REUSED' | 'TIME_ANOMALY' | 'OFFLINE_CAPABILITY_EXPIRED'
  | 'MENU_UNKNOWN' | 'INVALID_MODIFIER' | 'PRICE_MISMATCH' | 'PAYMENT_UNVERIFIED' | 'TOKEN_CONFLICT'
  | 'DAY_CLOSED_LATE' | 'ORDER_ID_CONFLICT' | 'DEPENDS_ON_REVIEW' | 'ORDER_STATE' | 'EVENT_CONFLICT'
  | 'ALREADY_PAID' | 'AMOUNT_MISMATCH';

export interface OfflineEventResult {
  eventId: string;
  sequence: number;
  status: OfflineEventStatus;
  reasonCode?: OfflineReviewReason;
  orderId?: string;
  receiptNumber?: string;
}

/** 设备时间可疑的阈值：超过 5 分钟视为时间异常。 */
export const TIME_SKEW_LIMIT_MS = 5 * 60_000;

/** 估计的服务器时间 = 设备时间 + 最近测得的偏移。 */
export function effectiveTimeMs(e: Pick<OfflineEvent, 'occurredAtDeviceMs' | 'lastServerOffsetMs'>): number {
  return e.occurredAtDeviceMs + e.lastServerOffsetMs;
}

/** 临时展示号 O-{收银机简写}-{本机序号}，与订单 UUID 分离。 */
export function offlineReceiptNumber(registerId: string, sequence: number): string {
  // front-01 → F01；其他格式取末 4 位字母数字。
  const m = registerId.match(/^([a-z])[a-z]*-?(\d+)$/i);
  const short = m ? `${m[1].toUpperCase()}${m[2]}` : registerId.replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase() || 'REG';
  return `O-${short}-${String(sequence).padStart(4, '0')}`;
}

/**
 * 本机餐牌视图 = 最后一次联网时的服务器餐牌 + 尚未被服务器确认的本机离线事件。
 * 事件按序号应用；人工出餐即释放本单仍持有的牌，同一张牌先释放旧单再占给新单的顺序由序号保证。
 * 这只是本机视图：后厨在云端出餐释放的牌，断网期间本机看不到，不能声称拥有最新牌状态。
 */
export function overlayLocalTokens(base: TokenBoard, events: OfflineEvent[]): TokenBoard {
  const board: TokenBoard = { ...base };
  const set = (t: TokenState) => (board[t.number] = t);
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (e.type === 'offline_order_created') {
      const t = board[e.payload.tokenNumber];
      set({ number: e.payload.tokenNumber, state: 'held', orderId: e.payload.clientOrderId, version: (t?.version ?? 0) + 1 });
    } else if (e.type === 'manual_served') {
      const held = Object.values(board).find((t) => t.orderId === e.payload.clientOrderId && (t.state === 'held' || t.state === 'awaiting_return'));
      if (held) set({ number: held.number, state: 'available', orderId: null, version: held.version + 1, lastReleasedOrderId: e.payload.clientOrderId });
    } else if (e.type === 'token_returned') {
      const t = board[e.payload.tokenNumber];
      if (t && t.orderId === e.payload.clientOrderId) set({ number: t.number, state: 'available', orderId: null, version: t.version + 1 });
    }
  }
  return board;
}

/** 某离线单在本机事件中的人工状态（用于同步中心与 POS 显示）。 */
export function manualStatus(events: OfflineEvent[], clientOrderId: string): { handedOff: boolean; served: boolean; tokenReturned: boolean; paid: boolean } {
  const mine = events.filter((e) => e.type !== 'sequence_void' && e.payload.clientOrderId === clientOrderId);
  const served = mine.some((e) => e.type === 'manual_served');
  const created = mine.find((e) => e.type === 'offline_order_created');
  return {
    handedOff: mine.some((e) => e.type === 'manual_handoff'),
    served,
    tokenReturned: served || mine.some((e) => e.type === 'token_returned'),
    paid: mine.some((e) => e.type === 'offline_payment_recorded') || Boolean(created && created.type === 'offline_order_created' && created.payload.payment),
  };
}

/** 补同步的批次：按序号排序、每批最多 25 条。 */
export function nextSyncBatch<T extends { sequence: number }>(pending: T[], max = 25): T[] {
  return [...pending].sort((a, b) => a.sequence - b.sequence).slice(0, max);
}
