/**
 * Callable 命令封装。
 * - 带 reasonCode 的错误是服务器明确拒绝（rejected），不会重复入账。
 * - 网络/超时/内部错误时结果不明（unknown）：先 getOperationResult 核对原请求，
 *   未找到才用「同一 operationId 与 payload」重试；绝不换新 ID 复制成新单。
 */
import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { functions, STORE_ID } from './client';

export type CommandName =
  | 'createOrder' | 'getOperationResult' | 'openShift' | 'releaseToken' | 'ackKitchenTicket'
  | 'startOrder' | 'serveOrder' | 'undoServe' | 'requestCancel' | 'confirmKitchenCancel'
  | 'confirmFullRefund' | 'manageMember' | 'assignRegister' | 'syncOfflineEvents' | 'routeManualOrderToKitchen'
  | 'heartbeatDevice' | 'recordManualHandoff';

export class CommandFailure extends Error {
  constructor(
    public readonly kind: 'rejected' | 'unknown',
    public readonly reasonCode: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 15_000;

export async function call<T>(name: CommandName, data: Record<string, unknown>): Promise<T> {
  try {
    const res = await httpsCallable(functions, `${name}Cmd`, { timeout: TIMEOUT_MS })({ storeId: STORE_ID, ...data });
    return res.data as T;
  } catch (e) {
    throw toFailure(e);
  }
}

function toFailure(e: unknown): CommandFailure {
  if (e instanceof FirebaseError) {
    const details = ((e as FirebaseError & { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
    const reason = typeof details.reasonCode === 'string' ? details.reasonCode : null;
    if (reason && reason !== 'INTERNAL') return new CommandFailure('rejected', reason, e.message, details);
    return new CommandFailure('unknown', 'UNKNOWN_RESULT', e.message, details);
  }
  return new CommandFailure('unknown', 'UNKNOWN_RESULT', String(e));
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

/** 写命令：失败时如结果不明，按原 operationId 核对后再用同一 payload 重试一次。 */
export async function submit<T>(name: CommandName, payload: Record<string, unknown> & { operationId: string }): Promise<T & { replayed?: boolean }> {
  try {
    return await call<T & { replayed?: boolean }>(name, payload);
  } catch (e) {
    if (!(e instanceof CommandFailure) || e.kind !== 'unknown') throw e;
    return reconcile<T>(name, payload);
  }
}

export async function reconcile<T>(name: CommandName, payload: Record<string, unknown> & { operationId: string }): Promise<T & { replayed?: boolean }> {
  const status = await call<{ status: 'committed' | 'not_found'; result?: T }>('getOperationResult', { operationId: payload.operationId });
  if (status.status === 'committed') return { ...(status.result as T), replayed: true };
  return call<T & { replayed?: boolean }>(name, payload);
}
