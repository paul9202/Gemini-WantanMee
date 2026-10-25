/**
 * AI 记成本：与供应商无关的输入输出、失败分类与调用计量。模型只产生草稿建议与解释，不持有任何记账能力。
 */
import type { ExtractedCostDraft, ReceiptMime } from '../../../src/domain/aiCost';

export type ProviderName = 'claude' | 'deepseek';

export interface ImageInput {
  mime: ReceiptMime;
  base64: string;
  bytes: number;
}

/** 提取输入：收据 / 原话只作为待整理的数据，不是指令。 */
export interface ExtractionInput {
  kind: 'text' | 'receipt';
  text: string | null;
  images: ImageInput[];
  /** 草稿创建时的门店营业日与本地时间（用于解析「今天 / 昨天」）。 */
  businessDate: string;
  localTime: string;
  timeZone: string;
}

export interface ExplainEvidence { id: string; date: string; label: string; bucket: string; amountSen: number; paid: boolean }

/** 解释输入：程序算好的统计与可引用的记录摘录；模型不自己合计。 */
export interface ExplainInput {
  question: string;
  statsJson: string;
  evidence: ExplainEvidence[];
}

export interface CostExplanation {
  summary: string;
  findings: { text: string; evidenceIds: string[] }[];
  limitations: string[];
}

/**
 * 失败分类。只有 network / timeout / rate_limited / server_error / invalid_output / config 才交给备用；
 * 缺金额、模糊、分类不明不是失败（留在草稿给老板补）。
 */
export type FailureKind = 'network' | 'timeout' | 'rate_limited' | 'server_error' | 'invalid_output' | 'config' | 'refused' | 'bad_request' | 'vision_unavailable' | 'not_configured';

export const FALLBACK_KINDS: FailureKind[] = ['network', 'timeout', 'rate_limited', 'server_error', 'invalid_output', 'config', 'not_configured'];

export class ProviderError extends Error {
  constructor(public readonly kind: FailureKind, public readonly provider: ProviderName, message: string, public readonly status?: number) {
    super(message);
  }
}

export interface Usage { inputTokens: number; outputTokens: number }

export interface ProviderResult<T> { value: T; usage: Usage; model: string }

export interface AiProvider {
  name: ProviderName;
  /** 当前任务实际使用的模型；null = 该任务未配置（例如备用视觉模型）。 */
  modelFor(task: 'extract' | 'explain', hasImages: boolean): string | null;
  extract(input: ExtractionInput, signal: AbortSignal): Promise<ProviderResult<ExtractedCostDraft>>;
  explain(input: ExplainInput, allowedIds: Set<string>, allowedAmounts: Set<number>, signal: AbortSignal): Promise<ProviderResult<CostExplanation>>;
}

/** 每次供应商调用的计量（写入 attempts 文档；不含密钥、不含收据原文）。 */
export interface CallRecord {
  provider: ProviderName;
  model: string | null;
  ok: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  errorKind: FailureKind | null;
  status: number | null;
}
