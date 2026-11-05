/**
 * 实体餐牌生命周期：available → held(orderIds) → available。
 * 堂食与打包共用 1–50；出餐或取消最终成立时自动释放，不再做人工回收管理。
 * 同牌加单：客人拿着 N 号牌还要再加一碗、或朋友来了再点，可以在仍占用的 N 号上再挂一张新单（joinToken）。
 * 一张牌可同时属于多张单（orderIds）；每张单出餐 / 取消只摘掉自己，全部摘完牌才释放。
 * awaiting_return 只存在于旧版本数据（出餐后待人工回收），由前台逐张明确处理，不批量释放，也不能同牌加单。
 */

export const TOKEN_MIN = 1;
export const TOKEN_MAX = 50;

export type TokenStateName = 'available' | 'held' | 'awaiting_return';

export interface TokenState {
  number: number;
  state: TokenStateName;
  /** 第一张仍占牌的单（兼容旧客户端，只读这一个字段）；空闲时为 null。 */
  orderId: string | null;
  /** 仍占着这张牌的所有单（按挂上的先后）。旧数据没有此字段，读取时用 orderId 补出。 */
  orderIds?: string[];
  /**
   * 本轮占用（从空闲被占起，到下一次从空闲被占前）挂过这张牌的所有单，含已出餐的。
   * 撤回出餐据此判断牌是否仍是同一桌客人的；牌空闲后保留到下一轮被占时才清空。
   */
  sessionOrderIds?: string[];
  version: number;
  /** 最近一次由哪张订单释放；撤回出餐据此判断牌是否已被别的订单用过。 */
  lastReleasedOrderId?: string | null;
}

export type TokenBoard = Record<number, TokenState>;

export type TokenError = 'TOKEN_OUT_OF_RANGE' | 'TOKEN_OCCUPIED' | 'TOKEN_NOT_HELD_BY_ORDER' | 'TOKEN_NOT_AWAITING_RETURN' | 'TOKEN_REASSIGNED' | 'STALE_VERSION';

export type TokenResult = { ok: true; board: TokenBoard; token: TokenState } | { ok: false; error: TokenError; token?: TokenState };

export function createTokenBoard(): TokenBoard {
  const board: TokenBoard = {};
  for (let n = TOKEN_MIN; n <= TOKEN_MAX; n++) board[n] = { number: n, state: 'available', orderId: null, orderIds: [], sessionOrderIds: [], version: 0 };
  return board;
}

export function isTokenNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= TOKEN_MIN && n <= TOKEN_MAX;
}

/** 仍占着这张牌的单。旧数据只有 orderId。 */
export function tokenHolders(t: TokenState | undefined): string[] {
  if (!t || t.state === 'available') return [];
  return t.orderIds ?? (t.orderId ? [t.orderId] : []);
}

/** 本轮占用挂过这张牌的单（含已出餐的）。旧数据退回到 orderId / lastReleasedOrderId。 */
export function tokenSession(t: TokenState | undefined): string[] {
  if (!t) return [];
  if (t.sessionOrderIds) return t.sessionOrderIds;
  const one = t.orderId ?? t.lastReleasedOrderId ?? null;
  return one ? [one] : [];
}

/** 从 Firestore 餐牌文档读出完整状态（缺字段的旧文档按单张单补齐）。 */
export function tokenFromDoc(n: number, d: Record<string, unknown> | undefined): TokenState {
  const raw: TokenState = {
    number: n,
    state: (d?.state as TokenStateName | undefined) ?? 'available',
    orderId: (d?.orderId as string | null | undefined) ?? null,
    version: (d?.version as number | undefined) ?? 0,
    lastReleasedOrderId: (d?.lastReleasedOrderId as string | null | undefined) ?? null,
    ...(Array.isArray(d?.orderIds) ? { orderIds: d.orderIds as string[] } : {}),
    ...(Array.isArray(d?.sessionOrderIds) ? { sessionOrderIds: d.sessionOrderIds as string[] } : {}),
  };
  return { ...raw, orderIds: tokenHolders(raw), sessionOrderIds: tokenSession(raw) };
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

/** 写回完整形状（Firestore 整份覆盖写入，不能留 undefined）。 */
function put(board: TokenBoard, prev: TokenState, next: { state: TokenStateName; orderIds: string[]; sessionOrderIds: string[]; lastReleasedOrderId?: string | null }): TokenResult {
  const token: TokenState = {
    number: prev.number, state: next.state, orderId: next.orderIds[0] ?? null, orderIds: next.orderIds, sessionOrderIds: next.sessionOrderIds,
    version: prev.version + 1, lastReleasedOrderId: next.lastReleasedOrderId !== undefined ? next.lastReleasedOrderId : prev.lastReleasedOrderId ?? null,
  };
  return { ok: true, board: { ...board, [token.number]: token }, token };
}

function checkVersion(t: TokenState, expectedVersion?: number): boolean {
  return expectedVersion === undefined || expectedVersion === t.version;
}

/** 接单时占牌（新客人）。占用中或待回收的牌都不能再分配；同牌加单走 joinToken。 */
export function holdToken(board: TokenBoard, n: number, orderId: string, expectedVersion?: number): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  if (t.state === 'held' && tokenHolders(t).includes(orderId)) return { ok: true, board, token: t }; // 幂等
  if (t.state !== 'available') return { ok: false, error: 'TOKEN_OCCUPIED', token: t };
  if (!checkVersion(t, expectedVersion)) return { ok: false, error: 'STALE_VERSION', token: t };
  return put(board, t, { state: 'held', orderIds: [orderId], sessionOrderIds: [orderId], lastReleasedOrderId: null });
}

/**
 * 同牌加单：把新单挂到 withOrderId 那桌客人正拿着的牌上。
 * - 牌仍被这桌（本轮占用里有 withOrderId）占着：挂上，牌继续占用；
 * - 牌已空闲（原单都已出餐 / 取消，牌没给别人）：按新客人正常占牌，号码不变；
 * - 牌已给了别的客人、或是旧版待回收：TOKEN_OCCUPIED，绝不挂到别人的牌上。
 */
export function joinToken(board: TokenBoard, n: number, orderId: string, withOrderId: string): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  const holders = tokenHolders(t);
  if (t.state === 'held' && holders.includes(orderId)) return { ok: true, board, token: t }; // 幂等
  if (t.state === 'available') return holdToken(board, n, orderId);
  const session = tokenSession(t);
  if (t.state !== 'held' || !(holders.includes(withOrderId) || session.includes(withOrderId))) return { ok: false, error: 'TOKEN_OCCUPIED', token: t };
  return put(board, t, { state: 'held', orderIds: [...holders, orderId], sessionOrderIds: session.includes(orderId) ? session : [...session, orderId] });
}

/**
 * 出餐 / 取消最终成立：本单从牌上摘下；牌上没有别的单了才释放。
 * 牌已不属于本单（旧单重试、旧离线日志）时返回 null，调用方不得改动牌——绝不释放已属于新单的牌。
 */
export function releaseHeldToken(board: TokenBoard, n: number, orderId: string): TokenResult | null {
  if (!isTokenNumber(n)) return null;
  const t = board[n];
  const holders = tokenHolders(t);
  if (!holders.includes(orderId) || (t.state !== 'held' && t.state !== 'awaiting_return')) return null;
  const rest = holders.filter((id) => id !== orderId);
  const session = tokenSession(t);
  if (rest.length > 0) return put(board, t, { state: t.state, orderIds: rest, sessionOrderIds: session });
  return put(board, t, { state: 'available', orderIds: [], sessionOrderIds: session, lastReleasedOrderId: orderId });
}

/** 撤回出餐时能否把本单挂回原牌：牌仍是同一桌（本轮占用里有本单），或空闲且最后一次就是这桌释放的。 */
export function canReholdToken(t: TokenState | undefined, orderId: string): boolean {
  if (!t) return false;
  if (t.state === 'held' && tokenHolders(t).includes(orderId)) return true;
  if (t.state === 'held') return tokenSession(t).includes(orderId);
  if (t.state === 'available') return t.lastReleasedOrderId === orderId || tokenSession(t).includes(orderId);
  return false;
}

/** 撤回出餐：牌仍属于同一桌客人才在同一事务重新挂回；牌已给了别人就不抢牌。 */
export function reholdToken(board: TokenBoard, n: number, orderId: string): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  const holders = tokenHolders(t);
  if (t.state === 'held' && holders.includes(orderId)) return { ok: true, board, token: t };
  if (!canReholdToken(t, orderId)) return { ok: false, error: 'TOKEN_REASSIGNED', token: t };
  const session = tokenSession(t);
  return put(board, t, { state: 'held', orderIds: [...holders, orderId], sessionOrderIds: session.includes(orderId) ? session : [...session, orderId] });
}

/** 旧版待回收牌：前台确认实体牌已收回后释放。未出餐/未取消（仍 held）不能普通回收。 */
export function releaseToken(board: TokenBoard, n: number, orderId: string, expectedVersion?: number): TokenResult {
  if (!isTokenNumber(n)) return { ok: false, error: 'TOKEN_OUT_OF_RANGE' };
  const t = board[n];
  if (t.state === 'available' && t.orderId === null) return { ok: false, error: 'TOKEN_NOT_AWAITING_RETURN', token: t };
  if (t.orderId !== orderId) return { ok: false, error: 'TOKEN_NOT_HELD_BY_ORDER', token: t };
  if (t.state !== 'awaiting_return') return { ok: false, error: 'TOKEN_NOT_AWAITING_RETURN', token: t };
  if (!checkVersion(t, expectedVersion)) return { ok: false, error: 'STALE_VERSION', token: t };
  return put(board, t, { state: 'available', orderIds: [], sessionOrderIds: tokenSession(t), lastReleasedOrderId: orderId });
}
