/**
 * AI 记成本草稿：创建、按版本编辑、冻结附件、识别租约与结果回写。
 *
 * 并发与计费：
 * - 模型调用永远在 Firestore 事务之外：先用短事务取得租约（attempt 令牌 + inputRevision），调用结束再用带令牌的事务回写。
 * - 同一 requestId 重试只返回已有尝试的状态，不再计费；租约有效期内的第二次识别也不会再调用模型。
 * - 迟到的结果（令牌已失效、输入已更换、草稿已入账）只记在 attempt 上，不覆盖草稿。
 * - 老板已经改过的草稿：新识别只作为候选（candidate），要老板明确「应用这次识别」才替换。
 */
import { DocumentReference, Firestore, Transaction } from 'firebase-admin/firestore';
import { businessDateOf, wallClock } from '../../../src/domain/businessDay';
import {
  BUILT_IN_INGREDIENTS, EditedCostDraft, emptyEditedDraft, ExtractedCostDraft, extractionToEdited, Ingredient, MAX_RECEIPT_IMAGES, validateCostDraft,
} from '../../../src/domain';
import { StoreRefs, storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { loadStoreConfig } from '../core/store';
import { aiRuntime } from './config';
import { Attachment, inspectUpload, loadImages } from './receiptStorage';
import { runCostAi } from './router';
import type { CallRecord, ExtractionInput, FailureKind } from './types';

export const LEASE_MS = 100_000;

export type DraftStatus = 'created' | 'analyzing' | 'review' | 'failed' | 'committed' | 'discarded' | 'expired';
export type DraftSource = 'text' | 'receipt' | 'manual';

export interface DraftDoc {
  id: string;
  source: DraftSource;
  status: DraftStatus;
  revision: number;
  inputRevision: number;
  businessDate: string;
  localTime: string;
  timeZone: string;
  input: { text: string | null; attachments: Attachment[] };
  inputHistory: { inputRevision: number; text: string | null; attachments: Attachment[]; replacedAtMs: number }[];
  imageHashes: string[];
  extraction: ExtractedCostDraft | null;
  extractionMeta: { attemptId: string; provider: string; model: string; inputRevision: number; atMs: number } | null;
  candidate: { attemptId: string; extraction: ExtractedCostDraft; provider: string; model: string; inputRevision: number; atMs: number } | null;
  edited: EditedCostDraft | null;
  editedByOwner: boolean;
  warnings: string[];
  activeAttemptId: string | null;
  leaseUntilMs: number | null;
  statusBeforeAnalyze: DraftStatus | null;
  lastAttempt: { attemptId: string; ok: boolean; reason: string | null; provider: string | null; primaryIssue: string | null; atMs: number } | null;
  usage: { attempts: number; providerCalls: number; inputTokens: number; outputTokens: number };
  receipt: Record<string, unknown> | null;
  createdAtMs: number;
  createdBy: string;
  updatedAtMs: number;
}

/** 读成员并确认是本店有效老板（不经 runCommand 的草稿操作也同样校验）。 */
export async function requireOwner(tx: Transaction, store: StoreRefs, uid: string | undefined) {
  if (!uid) throw new CommandError('UNAUTHENTICATED');
  const m = (await tx.get(store.member(uid))).data();
  if (!m || m.active !== true) throw new CommandError('NOT_A_MEMBER');
  if (m.role !== 'owner') throw new CommandError('FORBIDDEN');
  return uid;
}

export async function getDraft(tx: Transaction, ref: DocumentReference): Promise<DraftDoc> {
  const d = (await tx.get(ref)).data() as DraftDoc | undefined;
  if (!d) throw new CommandError('NOT_FOUND', '草稿不存在');
  return d;
}

async function customIngredients(tx: Transaction, store: StoreRefs): Promise<Ingredient[]> {
  const snap = await tx.get(store.root.collection('ingredients'));
  return [...BUILT_IN_INGREDIENTS, ...snap.docs.map((d) => d.data()).filter((d) => d.active !== false).map((d) => ({ id: d.id, category: d.category, name: d.name, unit: d.unit, builtIn: false }))];
}

const leaseActive = (d: DraftDoc, nowMs: number) => Boolean(d.activeAttemptId && (d.leaseUntilMs ?? 0) > nowMs);
const OPEN: DraftStatus[] = ['created', 'analyzing', 'review', 'failed'];

/** 新草稿内容（runCommand 内调用，保证 operationId 幂等）。 */
export function newDraftDoc(p: { id: string; source: DraftSource; text: string | null; nowMs: number; uid: string; timeZone: string; cutoverMinutes: number }): DraftDoc {
  const businessDate = businessDateOf(p.nowMs, { timeZone: p.timeZone, cutoverMinutes: p.cutoverMinutes });
  const w = wallClock(p.nowMs, p.timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    id: p.id, source: p.source, status: p.source === 'manual' ? 'review' : 'created', revision: 1, inputRevision: p.source === 'text' ? 1 : 0,
    businessDate, localTime: `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.hh)}:${pad(w.mm)}`, timeZone: p.timeZone,
    input: { text: p.text, attachments: [] }, inputHistory: [], imageHashes: [],
    extraction: null, extractionMeta: null, candidate: null,
    edited: p.source === 'manual' ? emptyEditedDraft(businessDate) : null, editedByOwner: false, warnings: [],
    activeAttemptId: null, leaseUntilMs: null, statusBeforeAnalyze: null, lastAttempt: null,
    usage: { attempts: 0, providerCalls: 0, inputTokens: 0, outputTokens: 0 }, receipt: null,
    createdAtMs: p.nowMs, createdBy: p.uid, updatedAtMs: p.nowMs,
  };
}

export type DraftEdit =
  | { kind: 'edited'; edited: EditedCostDraft }
  | { kind: 'text'; text: string }
  | { kind: 'attachments'; paths: string[]; replaceSource: boolean }
  | { kind: 'applyCandidate'; attemptId: string }
  | { kind: 'discard' };

/** 编辑草稿：必须带 expectedRevision；两个页面同时改时后到的得到 STALE_VERSION，不静默覆盖。 */
export async function updateDraft(db: Firestore, uid: string | undefined, storeId: string, draftId: string, expectedRevision: number, edit: DraftEdit) {
  const store = storeRefs(db, storeId);
  // 附件校验需要读取 Storage，不能放进事务：先确认是本店老板（不让外人借此探测对象是否存在），再校验，最后在事务里核对状态并写入。
  if (edit.kind === 'attachments') await db.runTransaction((tx) => requireOwner(tx, store, uid));
  const inspected = edit.kind === 'attachments' ? await Promise.all(edit.paths.map((p) => inspectUpload(storeId, draftId, p))) : [];
  return db.runTransaction(async (tx) => {
    await requireOwner(tx, store, uid);
    const ref = store.costDraft(draftId);
    const d = await getDraft(tx, ref);
    const nowMs = Date.now();
    if (!OPEN.includes(d.status)) throw new CommandError('DRAFT_STATE', d.status === 'committed' ? '这份草稿已经入账，请到采购记录更正' : '这份草稿已关闭');
    if (d.revision !== expectedRevision) throw new CommandError('STALE_VERSION', '草稿已在别处修改，请先载入最新版本', { revision: d.revision });
    const config = await loadStoreConfig(tx, store);
    const today = businessDateOf(nowMs, config.businessDay);
    let patch: Partial<DraftDoc> = {};
    let similar: { draftId: string; status: string }[] = [];
    switch (edit.kind) {
      case 'edited': {
        patch = { edited: edit.edited, editedByOwner: true, status: d.status === 'created' || d.status === 'failed' ? 'review' : d.status };
        break;
      }
      case 'text': {
        if (d.source !== 'text') throw new CommandError('DRAFT_STATE', '只有文字草稿可以改原话');
        if (leaseActive(d, nowMs)) throw new CommandError('DRAFT_STATE', '正在整理中，请稍候');
        patch = {
          input: { text: edit.text, attachments: [] }, inputRevision: d.inputRevision + 1,
          inputHistory: [...d.inputHistory, { inputRevision: d.inputRevision, text: d.input.text, attachments: [], replacedAtMs: nowMs }].slice(-20),
        };
        break;
      }
      case 'attachments': {
        if (d.source !== 'receipt') throw new CommandError('DRAFT_STATE', '只有收据草稿可以上传图片');
        if (leaseActive(d, nowMs)) throw new CommandError('DRAFT_STATE', '正在识别中，请稍候再更换图片');
        if (d.status === 'review' && !edit.replaceSource) throw new CommandError('DRAFT_STATE', '已识别的草稿更换图片需确认「更换来源」');
        if (!inspected.length || inspected.length > MAX_RECEIPT_IMAGES) throw new CommandError('ATTACHMENT_REJECTED', `每次 1–${MAX_RECEIPT_IMAGES} 张`);
        if (new Set(inspected.map((a) => a.sha256)).size !== inspected.length) throw new CommandError('ATTACHMENT_REJECTED', '有重复的页面');
        const hashes = inspected.map((a) => a.sha256);
        const others = await tx.get(store.root.collection('costDrafts').where('imageHashes', 'array-contains-any', hashes));
        similar = others.docs.filter((o) => o.id !== draftId).map((o) => ({ draftId: o.id, status: o.data().status as string }));
        patch = {
          input: { text: d.input.text, attachments: inspected }, imageHashes: hashes, inputRevision: d.inputRevision + 1,
          inputHistory: d.input.attachments.length ? [...d.inputHistory, { inputRevision: d.inputRevision, text: d.input.text, attachments: d.input.attachments, replacedAtMs: nowMs }].slice(-20) : d.inputHistory,
          status: d.status === 'failed' ? 'created' : d.status,
        };
        break;
      }
      case 'applyCandidate': {
        if (!d.candidate || d.candidate.attemptId !== edit.attemptId) throw new CommandError('DRAFT_STATE', '这次识别结果已失效');
        if (d.candidate.inputRevision !== d.inputRevision) throw new CommandError('DRAFT_STATE', '图片或原话已更换，这次识别结果不能再用');
        const ingredients = await customIngredients(tx, store);
        patch = {
          edited: extractionToEdited(d.candidate.extraction, { defaultDate: d.businessDate, ingredients }), editedByOwner: false,
          extraction: d.candidate.extraction, extractionMeta: { attemptId: d.candidate.attemptId, provider: d.candidate.provider, model: d.candidate.model, inputRevision: d.candidate.inputRevision, atMs: d.candidate.atMs },
          candidate: null, warnings: d.candidate.extraction.warnings, status: 'review',
        };
        break;
      }
      case 'discard':
        patch = { status: 'discarded', activeAttemptId: null, leaseUntilMs: null };
        break;
    }
    const revision = d.revision + 1;
    tx.update(ref, { ...patch, revision, updatedAtMs: nowMs });
    const edited = (patch.edited ?? d.edited) as EditedCostDraft | null;
    const v = edited ? validateCostDraft(edited, { today }) : null;
    return { draftId, revision, inputRevision: patch.inputRevision ?? d.inputRevision, status: patch.status ?? d.status, issues: v?.issues ?? [], totals: v?.totals ?? null, similarDrafts: similar };
  });
}

type AnalyzeResult = { draftId: string; status: DraftStatus; revision: number; attemptId: string; reused: boolean; ok?: boolean; reason?: string | null; provider?: string | null; warnings?: string[] };

/**
 * 识别：租约 → 事务外调用（Claude 默认、DeepSeek 备用）→ 带令牌回写。
 * 同 requestId 重试返回原尝试；租约有效时不再调用；超出每日额度不调用、不借备用绕过。
 */
export async function analyzeDraft(db: Firestore, uid: string | undefined, storeId: string, draftId: string, inputRevision: number, requestId: string): Promise<AnalyzeResult> {
  const store = storeRefs(db, storeId);
  const ref = store.costDraft(draftId);
  const attemptId = `att-${requestId}`;
  const attemptRef = store.costAttempt(draftId, attemptId);
  const runtime = aiRuntime();

  const lease = await db.runTransaction(async (tx) => {
    await requireOwner(tx, store, uid);
    const [d, prior, flag] = [await getDraft(tx, ref), (await tx.get(attemptRef)).data(), (await tx.get(store.configAiCost)).data()];
    const nowMs = Date.now();
    if (prior) return { reuse: { draftId, status: d.status, revision: d.revision, attemptId, reused: true, ok: prior.status === 'done', reason: prior.reason ?? null, provider: prior.provider ?? null } as AnalyzeResult };
    if (!OPEN.includes(d.status) || d.source === 'manual') throw new CommandError('DRAFT_STATE', '这份草稿不能再识别');
    if (d.inputRevision !== inputRevision) throw new CommandError('STALE_VERSION', '原话或图片已更换，请刷新后再识别', { inputRevision: d.inputRevision });
    if (d.source === 'text' ? !d.input.text?.trim() : !d.input.attachments.length) throw new CommandError('INVALID_ARGUMENT', '还没有可识别的内容');
    if (leaseActive(d, nowMs)) return { reuse: { draftId, status: d.status, revision: d.revision, attemptId: d.activeAttemptId!, reused: true } as AnalyzeResult };
    if (flag?.enabled !== true) throw new CommandError('AI_DISABLED', 'AI 整理尚未开启，可以手动填写');
    if (!runtime.primary && !runtime.backup) throw new CommandError('AI_NOT_CONFIGURED', 'AI 服务尚未配置，可以手动填写');
    const config = await loadStoreConfig(tx, store);
    const day = businessDateOf(nowMs, config.businessDay);
    const usageRef = store.aiUsage(day);
    const usage = (await tx.get(usageRef)).data();
    const limit = typeof flag.dailyLimit === 'number' ? Math.min(flag.dailyLimit, runtime.dailyLimit) : runtime.dailyLimit;
    if ((usage?.attempts ?? 0) >= limit) throw new CommandError('AI_QUOTA_EXCEEDED', `今天的 AI 整理次数已用完（${limit} 次），可以手动填写`);
    tx.set(usageRef, { date: day, attempts: (usage?.attempts ?? 0) + 1, updatedAtMs: nowMs }, { merge: true });
    tx.create(attemptRef, { id: attemptId, requestId, status: 'running', inputRevision, startedAtMs: nowMs, leaseUntilMs: nowMs + LEASE_MS, by: uid, mode: runtime.mode });
    tx.update(ref, { status: 'analyzing', statusBeforeAnalyze: d.status, activeAttemptId: attemptId, leaseUntilMs: nowMs + LEASE_MS, updatedAtMs: nowMs });
    return { reuse: null, draft: d };
  });
  if (lease.reuse) return lease.reuse;
  const d = lease.draft!;

  let outcome: Awaited<ReturnType<typeof runCostAi<ExtractedCostDraft>>>;
  try {
    const images = d.source === 'receipt' ? await loadImages(d.input.attachments) : [];
    const input: ExtractionInput = { kind: d.source === 'receipt' ? 'receipt' : 'text', text: d.input.text, images, businessDate: d.businessDate, localTime: d.localTime, timeZone: d.timeZone };
    outcome = await runCostAi('extract', images.length > 0, (p, signal) => p.extract(input, signal), runtime);
  } catch (e) {
    outcome = { ok: false, calls: [], reason: e instanceof CommandError ? 'bad_request' : 'network' };
  }
  return finishAnalysis(db, store, draftId, attemptId, inputRevision, outcome);
}

async function finishAnalysis(db: Firestore, store: StoreRefs, draftId: string, attemptId: string, inputRevision: number, outcome: Awaited<ReturnType<typeof runCostAi<ExtractedCostDraft>>>): Promise<AnalyzeResult> {
  const ref = store.costDraft(draftId);
  const attemptRef = store.costAttempt(draftId, attemptId);
  return db.runTransaction(async (tx) => {
    const d = await getDraft(tx, ref);
    const ingredients = await customIngredients(tx, store);
    const nowMs = Date.now();
    const calls: CallRecord[] = outcome.calls;
    const tokens = calls.reduce((s, c) => ({ i: s.i + c.inputTokens, o: s.o + c.outputTokens }), { i: 0, o: 0 });
    const usage = { attempts: d.usage.attempts + 1, providerCalls: d.usage.providerCalls + calls.filter((c) => c.model).length, inputTokens: d.usage.inputTokens + tokens.i, outputTokens: d.usage.outputTokens + tokens.o };
    const current = d.activeAttemptId === attemptId && d.inputRevision === inputRevision && OPEN.includes(d.status);
    const attemptBase = { finishedAtMs: nowMs, calls, provider: outcome.ok ? outcome.provider : null, model: outcome.ok ? outcome.model : null, primaryIssue: outcome.ok ? outcome.primaryIssue : null };
    if (!current) {
      // 迟到：不覆盖草稿，只留下尝试记录（仍计入用量）。
      tx.update(attemptRef, { ...attemptBase, status: 'superseded', reason: 'late' });
      tx.update(ref, { usage });
      return { draftId, status: d.status, revision: d.revision, attemptId, reused: false, ok: false, reason: 'superseded' };
    }
    const base = { activeAttemptId: null, leaseUntilMs: null, statusBeforeAnalyze: null, usage, updatedAtMs: nowMs };
    if (!outcome.ok) {
      const reason: FailureKind | 'all_failed' = outcome.reason;
      tx.update(attemptRef, { ...attemptBase, status: 'failed', reason });
      const status: DraftStatus = d.edited ? 'review' : 'failed';
      tx.update(ref, { ...base, status, lastAttempt: { attemptId, ok: false, reason, provider: null, primaryIssue: null, atMs: nowMs } });
      return { draftId, status, revision: d.revision, attemptId, reused: false, ok: false, reason };
    }
    tx.update(attemptRef, { ...attemptBase, status: 'done', reason: null });
    const meta = { attemptId, provider: outcome.provider, model: outcome.model, inputRevision, atMs: nowMs };
    const lastAttempt = { attemptId, ok: true, reason: null, provider: outcome.provider, primaryIssue: outcome.primaryIssue, atMs: nowMs };
    if (d.edited && (d.editedByOwner || d.extraction)) {
      // 已有草稿（老板改过或之前识别过）：只作为候选，不覆盖。
      tx.update(ref, { ...base, status: 'review', candidate: { ...meta, extraction: outcome.value }, lastAttempt });
      return { draftId, status: 'review', revision: d.revision, attemptId, reused: false, ok: true, provider: outcome.provider, warnings: outcome.value.warnings };
    }
    const edited = extractionToEdited(outcome.value, { defaultDate: d.businessDate, ingredients });
    tx.update(ref, { ...base, status: 'review', extraction: outcome.value, extractionMeta: meta, edited, editedByOwner: false, warnings: outcome.value.warnings, lastAttempt, revision: d.revision + 1 });
    return { draftId, status: 'review', revision: d.revision + 1, attemptId, reused: false, ok: true, provider: outcome.provider, warnings: outcome.value.warnings };
  });
}

export const DRAFT_ATTACHMENT_TTL_MS = 30 * 86_400_000;

/**
 * 清理：未入账（待整理 / 失败 / 待核对 / 已放弃）且 30 天没有动过的草稿 → 标为 expired 并删除它的图片。
 * 已入账草稿的收据是记账凭证，不按草稿期限清理；被更换掉的旧图片也随草稿一起保留，直到草稿过期。
 */
export async function cleanupExpiredDrafts(db: Firestore, storeId: string, nowMs: number, deleteObjects: (paths: string[]) => Promise<void>) {
  const store = storeRefs(db, storeId);
  const cutoff = nowMs - DRAFT_ATTACHMENT_TTL_MS;
  const snap = await store.root.collection('costDrafts').where('status', 'in', ['created', 'failed', 'review', 'discarded']).where('updatedAtMs', '<', cutoff).limit(200).get();
  let expired = 0;
  for (const doc of snap.docs) {
    const paths = await db.runTransaction(async (tx) => {
      const d = (await tx.get(doc.ref)).data() as DraftDoc | undefined;
      if (!d || !['created', 'failed', 'review', 'discarded'].includes(d.status) || d.updatedAtMs >= cutoff || leaseActive(d, nowMs)) return null;
      tx.update(doc.ref, { status: 'expired', statusBeforeExpiry: d.status, expiredAtMs: nowMs, activeAttemptId: null, leaseUntilMs: null });
      return [...d.input.attachments, ...d.inputHistory.flatMap((h) => h.attachments)].map((a) => a.path);
    });
    if (paths) {
      expired++;
      if (paths.length) await deleteObjects(paths);
    }
  }
  return { expired };
}
