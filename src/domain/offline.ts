/**
 * 离线营业：事件信封与本机餐牌叠加（03 §7）。
 * 指定主收银机断网时，订单、收款、餐牌占用、人工交接/出餐/回收都写成不可变的追加事件，
 * 与在线命令共用同一个本机序号流；联网后按序号补同步。离线单一律 kitchenRouting=manual，
 * 补同步不会自动送厨。
 */
import type { LineConfig } from './lineItem';
import type { ServiceMode } from './menu';
import type { PaymentMethod } from './payment';
import { TokenBoard, TokenState } from './tokens';

export type OfflineEventType = 'offline_order_created' | 'manual_handoff' | 'manual_served' | 'token_returned' | 'sequence_void';

export interface OfflineOrderPayload {
  clientOrderId: string;
  offlineReceiptNumber: string;
  tokenNumber: number;
  serviceMode: ServiceMode;
  menuVersion: string;
  lines: { lineId: string; config: LineConfig; quantity: number }[];
  totalSen: number;
  payment: { method: PaymentMethod; tenderedSen: number | null; qrExternalVerificationNote: string | null };
}

export type OfflinePayload =
  | { type: 'offline_order_created'; payload: OfflineOrderPayload }
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
  | 'DAY_CLOSED_LATE' | 'ORDER_ID_CONFLICT' | 'DEPENDS_ON_REVIEW' | 'ORDER_STATE' | 'EVENT_CONFLICT';

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
 * 事件按序号应用；同一张牌先回收旧单再占给新单的顺序由序号保证。
 */
export function overlayLocalTokens(base: TokenBoard, events: OfflineEvent[]): TokenBoard {
  const board: TokenBoard = { ...base };
  const set = (t: TokenState) => (board[t.number] = t);
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (e.type === 'offline_order_created') {
      const t = board[e.payload.tokenNumber];
      set({ number: e.payload.tokenNumber, state: 'held', orderId: e.payload.clientOrderId, version: (t?.version ?? 0) + 1 });
    } else if (e.type === 'manual_served') {
      const held = Object.values(board).find((t) => t.orderId === e.payload.clientOrderId && t.state === 'held');
      if (held) set({ ...held, state: 'awaiting_return', version: held.version + 1 });
    } else if (e.type === 'token_returned') {
      const t = board[e.payload.tokenNumber];
      if (t && t.orderId === e.payload.clientOrderId) set({ number: t.number, state: 'available', orderId: null, version: t.version + 1 });
    }
  }
  return board;
}

/** 某离线单在本机事件中的人工状态（用于同步中心与 POS 显示）。 */
export function manualStatus(events: OfflineEvent[], clientOrderId: string): { handedOff: boolean; served: boolean; tokenReturned: boolean } {
  const mine = events.filter((e) => e.type !== 'sequence_void' && e.payload.clientOrderId === clientOrderId);
  return {
    handedOff: mine.some((e) => e.type === 'manual_handoff'),
    served: mine.some((e) => e.type === 'manual_served'),
    tokenReturned: mine.some((e) => e.type === 'token_returned'),
  };
}

/** 补同步的批次：按序号排序、每批最多 25 条。 */
export function nextSyncBatch<T extends { sequence: number }>(pending: T[], max = 25): T[] {
  return [...pending].sort((a, b) => a.sequence - b.sequence).slice(0, max);
}
