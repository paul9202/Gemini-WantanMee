/**
 * 实体餐牌生命周期：available → held(orderId) → available。
 * 堂食与打包共用 1–50；出餐或取消最终成立时自动释放，不再做人工回收管理。
 * awaiting_return 只存在于旧版本数据（出餐后待人工回收），由前台逐张明确处理，不批量释放。
 */

export const TOKEN_MIN = 1;
export const TOKEN_MAX = 50;

export type TokenStateName = 'available' | 'held' | 'awaiting_return';

export interface TokenState {
  number: number;
  state: TokenStateName;
  orderId: string | null;
  version: number;
  /** 最近一次由哪张订单释放；撤回出餐据此判断牌是否已被别的订单用过。 */
  lastReleasedOrderId?: string | null;
}

export type TokenBoard = Record<number, TokenState>;

export type TokenError = 'TOKEN_OUT_OF_RANGE' | 'TOKEN_OCCUPIED' | 'TOKEN_NOT_HELD_BY_ORDER' | 'TOKEN_NOT_AWAITING_RETURN' | 'TOKEN_REASSIGNED' | 'STALE_VERSION';

export type TokenResult = { ok: true; board: TokenBoard; token: TokenState } | { ok: false; error: TokenError; token?: TokenState };

export function createTokenBoard(): TokenBoard {
  const board: TokenBoard = {};
  for (let n = TOKEN_MIN; n <= TOKEN_MAX; n++) board[n] = { number: n, state: 'available', orderId: null, version: 0 };
  return board;
}

export function isTokenNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= TOKEN_MIN && n <= TOKEN_MAX;
}

/** 从上一张牌之后循环查找下一个可用牌（50 后回 1）；全满返回 null。 */
export function suggestNextToken(board: TokenBoard, lastIssued: number | null): number | null {
  const start = lastIssued && isTokenNumber(lastIssued) ? lastIssued : TOKEN_MAX;
  for (let i = 1; i <= TOKEN_MAX; i++) {
    const n = ((start - 1 + i) % TOKEN_MAX) + 1;
    if (board[n]?.state === 'available') return n;
  }
  return null;
}

export function countTokens(board: TokenBoard): Record<TokenStateName, number> {
  const out: Record<TokenStateName, number> = { available: 0, held: 0, awaiting_return: 0 };
  for (const t of Object.values(board)) out[t.state]++;
  return out;
}

function put(board: TokenBoard, token: TokenState): TokenResult {
  return { ok: true, board: { ...board, [token.number]: token }, token };
}

function checkVersion(t: TokenState, expectedVersion?: number): boolean {
  return expectedVersion === undefined || expectedVersion === t.version;
}

/** 接单时占牌。占用中或待回收的牌都不能再分配。 */
export function holdToken(board: TokenBoard, n: number, orderId: string, expectedVersion?: number): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  if (t.state === 'held' && t.orderId === orderId) return { ok: true, board, token: t }; // 幂等
  if (t.state !== 'available') return { ok: false, error: 'TOKEN_OCCUPIED', token: t };
  if (!checkVersion(t, expectedVersion)) return { ok: false, error: 'STALE_VERSION', token: t };
  return put(board, { number: n, state: 'held', orderId, version: t.version + 1 });
}

/**
 * 出餐 / 取消最终成立：释放仍属于该订单的牌。牌已不属于本单（旧单重试、旧离线日志）时返回 null，
 * 调用方不得改动牌——绝不释放已属于新单的牌。
 */
export function releaseHeldToken(board: TokenBoard, n: number, orderId: string): TokenResult | null {
  if (!isTokenNumber(n)) return null;
  const t = board[n];
  if (t.orderId !== orderId || (t.state !== 'held' && t.state !== 'awaiting_return')) return null;
  return put(board, { number: n, state: 'available', orderId: null, version: t.version + 1, lastReleasedOrderId: orderId });
}

/** 撤回出餐：原牌仍空闲、且最后一次是本单释放，才能在同一事务重新占用；否则不抢牌。 */
export function reholdToken(board: TokenBoard, n: number, orderId: string): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  if (t.state === 'held' && t.orderId === orderId) return { ok: true, board, token: t };
  if (t.state !== 'available' || (t.lastReleasedOrderId ?? null) !== orderId) return { ok: false, error: 'TOKEN_REASSIGNED', token: t };
  return put(board, { number: n, state: 'held', orderId, version: t.version + 1, lastReleasedOrderId: orderId });
}

/** 旧版待回收牌：前台确认实体牌已收回后释放。未出餐/未取消（仍 held）不能普通回收。 */
export function releaseToken(board: TokenBoard, n: number, orderId: string, expectedVersion?: number): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  if (t.state === 'available' && t.orderId === null) return { ok: false, error: 'TOKEN_NOT_AWAITING_RETURN', token: t };
  if (t.orderId !== orderId) return { ok: false, error: 'TOKEN_NOT_HELD_BY_ORDER', token: t };
  if (t.state !== 'awaiting_return') return { ok: false, error: 'TOKEN_NOT_AWAITING_RETURN', token: t };
  if (!checkVersion(t, expectedVersion)) return { ok: false, error: 'STALE_VERSION', token: t };
  return put(board, { number: n, state: 'available', orderId: null, version: t.version + 1, lastReleasedOrderId: orderId });
}
