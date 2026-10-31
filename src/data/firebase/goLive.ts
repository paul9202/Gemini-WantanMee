/**
 * 清空测试数据（可多次使用）：预览（每类多少条、上次清空时间、是否因输错被锁）与清空。清空可能较久，用长超时；
 * 结果不明（网络中断）时按 operationId 查操作记录，不自动重试（重试要老板再输入一次确认码）。
 * 确认码只随这一次请求发给后端，不在本地保存。
 */
import { httpsCallable } from 'firebase/functions';
import { functions, STORE_ID } from './client';
import { CommandFailure, newOperationId, toFailure } from './commands';
import type { GoLiveStatus } from '../../domain/goLive';

const RESET_TIMEOUT_MS = 560_000;

export interface GoLivePreview {
  status: GoLiveStatus;
  lastResetAtMs: number | null;
  lockedUntilMs: number | null;
  failedAttempts: number;
  counts: Record<string, number>;
}

export interface GoLiveResult {
  lastResetAtMs: number;
  deleted: Record<string, number>;
  deletedTotal: number;
}

async function callFn<T>(name: string, data: Record<string, unknown>, timeout: number): Promise<T> {
  try {
    return (await httpsCallable(functions, `${name}Cmd`, { timeout })({ storeId: STORE_ID, ...data })).data as T;
  } catch (e) {
    throw toFailure(e);
  }
}

export function previewStoreReset(): Promise<GoLivePreview> {
  return callFn<GoLivePreview>('previewStoreReset', {}, 60_000);
}

export async function resetStoreForOpening(confirmCode: string): Promise<GoLiveResult> {
  const operationId = newOperationId();
  try {
    return await callFn<GoLiveResult>('resetStoreForOpening', { operationId, confirmCode }, RESET_TIMEOUT_MS);
  } catch (e) {
    if (!(e instanceof CommandFailure) || e.kind !== 'unknown') throw e;
    const status = await callFn<{ status: 'committed' | 'not_found'; result?: GoLiveResult }>('getOperationResult', { operationId }, 30_000);
    if (status.status === 'committed' && status.result) return status.result;
    throw e;
  }
}
