/**
 * 开销分析：先由程序按账本算确定性统计（domain/costInsights），老板提问时才请模型解释。
 * - 解释沿用同一主备策略（Claude 默认、DeepSeek 备用），只拿到统计与可引用的记录摘录，没有数据库权限。
 * - 返回的引用 ID 与文中金额必须在后端给出的范围内，否则视为结构错误（可交给备用），都不合格就只给统计。
 * - 缓存键 = 区间 + 问题 + 账本摘要；任何付款、作废、归属变化都会换摘要，旧解读不会被当成最新。
 */
import { createHash } from 'node:crypto';
import { Firestore } from 'firebase-admin/firestore';
import { businessDateOf } from '../../../src/domain/businessDay';
import { allowedAmounts, buildCostStats, CostStats, StatsBatch, StatsExpense, StatsPurchaseDetail, statsDigest } from '../../../src/domain/costInsights';
import type { DateRange } from '../../../src/domain/businessDay';
import type { ExpenseLinkDoc } from '../../../src/domain/costing';
import { storeRefs } from '../core/command';
import { CommandError } from '../core/errors';
import { loadStoreConfig } from '../core/store';
import { aiRuntime } from './config';
import { requireOwner } from './drafts';
import { activeAcceptance } from './acceptance';
import { runCostAi } from './router';
import type { CostExplanation } from './types';

export const QUICK_QUESTIONS = { where: '这段时间的钱主要花在哪？', compare: '比对比区间多花在哪里？', unpaid: '有哪些还没付的款？' } as const;

export interface CostAnalysisResult {
  stats: CostStats;
  dataDigest: string;
  range: DateRange;
  explanation: (CostExplanation & { provider: string; model: string; generatedAtMs: number; cached: boolean; question: string }) | null;
  explainStatus: 'not_requested' | 'ok' | 'failed' | 'disabled' | 'not_configured' | 'quota';
  sourceIds: string[];
  generatedAtMs: number;
  warnings: string[];
}

const normalizeQuestion = (q: string) => q.replace(/\s+/g, ' ').trim().slice(0, 300);

export async function getCostAnalysis(db: Firestore, uid: string | undefined, input: { storeId: string; range: DateRange; question: string | null; explain: boolean }): Promise<CostAnalysisResult> {
  const store = storeRefs(db, input.storeId);
  // 只读：先核对身份，再读取账本（单店数据量小，全量读支出以便核对付款与归属）。
  const today = await db.runTransaction(async (tx) => {
    await requireOwner(tx, store, uid);
    const config = await loadStoreConfig(tx, store);
    return businessDateOf(Date.now(), config.businessDay);
  });
  if (input.range.start > today) throw new CommandError('INVALID_ARGUMENT', '统计区间不能从未来开始');
  const [expenses, links, batches, details, flag] = await Promise.all([
    store.root.collection('expenses').get(), store.root.collection('expenseLinks').get(), store.root.collection('ingredientBatches').get(),
    store.root.collection('purchaseDetails').get(), store.configAiCost.get(),
  ]);
  const stats = buildCostStats({
    expenses: expenses.docs.map((d) => d.data() as StatsExpense), links: links.docs.map((d) => d.data() as ExpenseLinkDoc),
    batches: batches.docs.map((d) => d.data() as StatsBatch), purchaseDetails: details.docs.map((d) => d.data() as StatsPurchaseDetail), range: input.range,
  });
  const dataDigest = await statsDigest(stats);
  const base: CostAnalysisResult = { stats, dataDigest, range: input.range, explanation: null, explainStatus: 'not_requested', sourceIds: [], generatedAtMs: Date.now(), warnings: stats.coverage.notes };
  if (!input.explain) return base;
  const question = normalizeQuestion(input.question ?? QUICK_QUESTIONS.where);
  if (!question) throw new CommandError('INVALID_ARGUMENT', '请写下想问的问题');
  if (flag.data()?.enabled !== true) return { ...base, explainStatus: 'disabled' };
  const runtime = aiRuntime();
  if (!runtime.primary && !runtime.backup) return { ...base, explainStatus: 'not_configured' };

  // 备用验收模式下另用缓存键，避免把之前 Claude 的解读当成 DeepSeek 的验收结果。
  const acceptance = activeAcceptance(flag.data()?.acceptance, Date.now(), uid);
  if (acceptance && !runtime.backup) return { ...base, explainStatus: 'not_configured' };
  const key = createHash('sha256').update([input.storeId, input.range.start, input.range.endExclusive, question, dataDigest, acceptance ? 'acceptance:backup_only' : ''].join('\n')).digest('hex').slice(0, 40);
  const cached = (await store.costAnalysis(key).get()).data();
  if (cached && cached.dataDigest === dataDigest) {
    return { ...base, explainStatus: 'ok', explanation: { ...(cached.explanation as CostExplanation), provider: cached.provider, model: cached.model, generatedAtMs: cached.generatedAtMs, cached: true, question }, sourceIds: cached.sourceIds };
  }
  // 额度：与识别共用每日上限；超出不调用、也不借备用绕过。
  const usageOk = await db.runTransaction(async (tx) => {
    const ref = store.aiUsage(today);
    const u = (await tx.get(ref)).data();
    const limit = typeof flag.data()?.dailyLimit === 'number' ? Math.min(flag.data()!.dailyLimit, runtime.dailyLimit) : runtime.dailyLimit;
    if ((u?.attempts ?? 0) >= limit) return false;
    tx.set(ref, { date: today, attempts: (u?.attempts ?? 0) + 1, explains: (u?.explains ?? 0) + 1, updatedAtMs: Date.now() }, { merge: true });
    return true;
  });
  if (!usageOk) return { ...base, explainStatus: 'quota' };

  const allowedIds = new Set(stats.evidence.map((e) => e.id));
  const amounts = allowedAmounts(stats);
  const { evidence, ...rest } = stats;
  const rt = acceptance ? { ...runtime, primary: null, primarySkipped: 'acceptance_skip' as const } : runtime;
  const outcome = await runCostAi('explain', false, (p, signal) => p.explain({ question, statsJson: JSON.stringify(rest), evidence }, allowedIds, amounts, signal), rt);
  const generatedAtMs = Date.now();
  if (!outcome.ok) {
    await store.costAnalysis(`failed-${key}`).set({ question, range: input.range, dataDigest, reason: outcome.reason, calls: outcome.calls, atMs: generatedAtMs });
    return { ...base, explainStatus: 'failed' };
  }
  const sourceIds = [...new Set(outcome.value.findings.flatMap((f) => f.evidenceIds))];
  await store.costAnalysis(key).set({
    question, range: input.range, dataDigest, explanation: outcome.value, sourceIds, provider: outcome.provider, model: outcome.model,
    primaryIssue: outcome.primaryIssue, calls: outcome.calls, generatedAtMs, by: uid, acceptanceMode: acceptance?.mode ?? null,
  });
  return { ...base, explainStatus: 'ok', explanation: { ...outcome.value, provider: outcome.provider, model: outcome.model, generatedAtMs, cached: false, question }, sourceIds };
}
