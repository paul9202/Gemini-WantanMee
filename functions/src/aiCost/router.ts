/**
 * 有限主备：每次请求最多 Claude 一次、DeepSeek 一次，顺序调用，不同时发送。
 * - 只有网络 / 超时 / 限流 / 5xx / 结构不合法 / 配置异常才交给备用；安全拒绝、请求错误不换家重试。
 * - 单家最长 perProviderMs，总时限 totalMs；超过总时限不再尝试。
 * - 缺金额、看不清、分类不明不是失败：返回草稿让老板补，不会因此多调用一次。
 */
import { AiProvider, CallRecord, FALLBACK_KINDS, FailureKind, ProviderError, ProviderResult } from './types';

export const DEFAULT_TOTAL_MS = 75_000;
export const DEFAULT_PER_PROVIDER_MS = 30_000;

export type AiOutcome<T> =
  | { ok: true; value: T; provider: AiProvider['name']; model: string; calls: CallRecord[]; primaryIssue: FailureKind | null }
  | { ok: false; calls: CallRecord[]; reason: FailureKind | 'all_failed' };

export interface RouterDeps {
  primary: AiProvider | null;
  backup: AiProvider | null;
  totalMs?: number;
  perProviderMs?: number;
  now?: () => number;
}

export async function runCostAi<T>(task: 'extract' | 'explain', hasImages: boolean, call: (p: AiProvider, signal: AbortSignal) => Promise<ProviderResult<T>>, deps: RouterDeps): Promise<AiOutcome<T>> {
  const now = deps.now ?? Date.now;
  const start = now();
  const total = deps.totalMs ?? DEFAULT_TOTAL_MS;
  const per = deps.perProviderMs ?? DEFAULT_PER_PROVIDER_MS;
  const calls: CallRecord[] = [];
  let primaryIssue: FailureKind | null = null;
  const chain = [deps.primary, deps.backup];
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i];
    const remaining = total - (now() - start);
    if (!p) {
      if (i === 0) primaryIssue = 'not_configured';
      continue;
    }
    const model = p.modelFor(task, hasImages);
    if (!model) {
      calls.push({ provider: p.name, model: null, ok: false, ms: 0, inputTokens: 0, outputTokens: 0, errorKind: 'vision_unavailable', status: null });
      if (i === 0) primaryIssue = 'vision_unavailable';
      continue;
    }
    if (remaining <= 1_000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(per, remaining));
    const t0 = now();
    try {
      const r = await call(p, ctrl.signal);
      calls.push({ provider: p.name, model: r.model, ok: true, ms: now() - t0, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, errorKind: null, status: null });
      return { ok: true, value: r.value, provider: p.name, model: r.model, calls, primaryIssue };
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(ctrl.signal.aborted ? 'timeout' : 'network', p.name, String(e));
      const kind: FailureKind = ctrl.signal.aborted && err.kind === 'network' ? 'timeout' : err.kind;
      calls.push({ provider: p.name, model, ok: false, ms: now() - t0, inputTokens: 0, outputTokens: 0, errorKind: kind, status: err.status ?? null });
      if (i === 0) primaryIssue = kind;
      if (!FALLBACK_KINDS.includes(kind)) return { ok: false, calls, reason: kind };
    } finally {
      clearTimeout(timer);
    }
  }
  const tried = calls.filter((c) => c.model !== null);
  if (!tried.length) return { ok: false, calls, reason: calls.some((c) => c.errorKind === 'vision_unavailable') ? 'vision_unavailable' : 'not_configured' };
  return { ok: false, calls, reason: 'all_failed' };
}
