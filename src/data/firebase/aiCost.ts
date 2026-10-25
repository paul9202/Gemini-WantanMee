/**
 * AI 记成本的客户端调用。
 * - 识别 / 解读是专用长请求（130 秒），按 requestId 去重；结果不明时不自动重发，改为订阅草稿状态，避免重复计费。
 * - 确认保存是账务命令：同一 operationId；结果不明先读草稿是否已入账，再按原 operationId 核对，绝不换新草稿。
 * - 收据图片直接上传到本店私有 Storage 路径，只用对象路径交给后端；本地预览用认证读取的 Blob，不生成公开链接。
 */
import { doc, getDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getBlob, ref, uploadBytes } from 'firebase/storage';
import { db, functions, storage, STORE_ID, storePath } from './client';
import { CommandFailure, newOperationId, reconcile, submit, toFailure } from './commands';
import { EditedCostDraft, MAX_RECEIPT_BYTES, MAX_RECEIPT_IMAGES, RECEIPT_MIME } from '../../domain';
import type { CostStats } from '../../domain';

export const AI_TIMEOUT_MS = 130_000;

async function callLong<T>(name: string, data: Record<string, unknown>, timeout = AI_TIMEOUT_MS): Promise<T> {
  try {
    const res = await httpsCallable(functions, `${name}Cmd`, { timeout })({ storeId: STORE_ID, ...data });
    return res.data as T;
  } catch (e) {
    throw toFailure(e);
  }
}

export interface CostPostingReceipt {
  receiptId: string; draftId: string; businessDate: string; expenseIds: string[]; purchaseIds: string[]; batchIds: string[]; totalSen: number;
  committedRevision: number; foodCount: number; dailyCount: number; pendingUsageCount: number; excludedCount: number; alreadyCommitted?: boolean;
}

export interface DraftUpdateResult { draftId: string; revision: number; inputRevision: number; status: string; issues: { code: string; lineId: string | null; message: string }[]; similarDrafts: { draftId: string; status: string }[] }

export interface CostExplanationView {
  summary: string; findings: { text: string; evidenceIds: string[] }[]; limitations: string[]; provider: string; model: string; generatedAtMs: number; cached: boolean; question: string;
}
export interface CostAnalysisView {
  stats: CostStats; dataDigest: string; range: { start: string; endExclusive: string }; explanation: CostExplanationView | null;
  explainStatus: 'not_requested' | 'ok' | 'failed' | 'disabled' | 'not_configured' | 'quota'; sourceIds: string[]; generatedAtMs: number; warnings: string[];
}

export function createDraft(source: 'text' | 'receipt' | 'manual', text?: string) {
  return submit<{ draftId: string; revision: number; inputRevision: number; status: string; businessDate: string; uploadPrefix: string | null }>('createCostDraft', { operationId: newOperationId(), source, ...(text !== undefined ? { text } : {}) });
}

export type DraftChange = { edited: EditedCostDraft } | { text: string } | { attachments: { path: string }[]; replaceSource?: boolean } | { applyCandidate: { attemptId: string } } | { discard: true };

export function updateDraft(draftId: string, expectedRevision: number, change: DraftChange) {
  return callLong<DraftUpdateResult>('updateCostDraft', { draftId, expectedRevision, ...change }, 60_000);
}

export function analyzeDraft(draftId: string, inputRevision: number, requestId: string) {
  return callLong<{ status: string; revision: number; attemptId: string; reused: boolean; ok?: boolean; reason?: string | null; provider?: string | null; warnings?: string[] }>('analyzeCostDraft', { draftId, inputRevision, requestId });
}

/** 确认保存：结果不明时先看草稿是否已入账（拿原回执），否则按同一 operationId 核对 / 重试。 */
export async function commitDraft(draftId: string, expectedRevision: number, operationId: string, duplicateAcknowledgement?: { candidateId: string; reason: string }): Promise<CostPostingReceipt> {
  const payload = { operationId, draftId, expectedRevision, ...(duplicateAcknowledgement ? { duplicateAcknowledgement } : {}) };
  try {
    return await submit<CostPostingReceipt>('commitCostDraft', payload);
  } catch (e) {
    if (!(e instanceof CommandFailure) || e.kind !== 'unknown') throw e;
    const snap = await getDoc(doc(db, storePath(`costDrafts/${draftId}`)));
    const d = snap.data();
    if (d?.status === 'committed' && d.receipt) return { ...(d.receipt as CostPostingReceipt), alreadyCommitted: true };
    return reconcile<CostPostingReceipt>('commitCostDraft', payload);
  }
}

export function setAiEnabled(enabled: boolean) {
  return submit<{ enabled: boolean }>('setAiCostEnabled', { operationId: newOperationId(), enabled });
}

export function getAnalysis(range: { start: string; endExclusive: string }, explain: boolean, question?: string) {
  return callLong<CostAnalysisView>('getCostAnalysis', { range, explain, ...(question ? { question } : {}) });
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** 选图时的明确提示：不支持的格式、过大、超过张数都直接说明，不默默丢弃。 */
export function checkReceiptFiles(existing: number, files: File[]): { ok: File[]; errors: string[] } {
  const ok: File[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (!(RECEIPT_MIME as readonly string[]).includes(f.type)) errors.push(`「${f.name}」不是 JPEG / PNG / WebP${/heic|heif/i.test(f.type + f.name) ? '（iPhone 的 HEIC 请在相机设置改为「兼容性最佳」或先转换）' : /pdf/i.test(f.type + f.name) ? '（PDF 请截图后上传）' : ''}`);
    else if (f.size > MAX_RECEIPT_BYTES) errors.push(`「${f.name}」超过 10 MB，请压缩后再传`);
    else if (existing + ok.length >= MAX_RECEIPT_IMAGES) errors.push(`一张收据最多 ${MAX_RECEIPT_IMAGES} 张照片，「${f.name}」没有加入`);
    else ok.push(f);
  }
  return { ok, errors };
}

export async function uploadReceiptImage(prefix: string, file: File): Promise<string> {
  const path = `${prefix}${crypto.randomUUID()}.${EXT[file.type]}`;
  await uploadBytes(ref(storage, path), file, { contentType: file.type });
  return path;
}

/** 认证读取私有图片，返回本地 objectURL（调用方负责 revoke）。 */
export async function receiptImageUrl(path: string): Promise<string> {
  return URL.createObjectURL(await getBlob(ref(storage, path)));
}
