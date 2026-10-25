/**
 * Claude（默认）：官方 SDK、结构化输出（output_config.format）。SDK 自带重试关闭，由 router 统一控制主备与时限。
 * 服务端 fallbacks: 'default' 只处理 Claude 自身的安全拒绝换模型；网络 / 限流 / 5xx 仍由 router 交给 DeepSeek。
 */
import Anthropic from '@anthropic-ai/sdk';
import { EXPLAIN_SYSTEM, EXTRACTION_SYSTEM, explainUserText, extractionUserText } from '../prompts';
import { EXPLANATION_SCHEMA, EXTRACTION_SCHEMA, parseExplanation, parseExtraction, SchemaError } from '../schema';
import { AiProvider, FailureKind, ProviderError } from '../types';

export interface ClaudeConfig {
  apiKey: string;
  model: string;
  effort: 'low' | 'medium' | 'high';
  serverFallback: boolean;
  maxTokens?: number;
  fetch?: typeof fetch;
  baseURL?: string;
}

function classify(e: unknown): { kind: FailureKind; status?: number } {
  if (e instanceof Anthropic.APIUserAbortError) return { kind: 'timeout' };
  if (e instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'timeout' };
  if (e instanceof Anthropic.APIConnectionError) return { kind: 'network' };
  if (e instanceof Anthropic.RateLimitError) return { kind: 'rate_limited', status: 429 };
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return { kind: 'config', status: e.status };
  if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.UnprocessableEntityError || e instanceof Anthropic.NotFoundError) return { kind: 'bad_request', status: e.status };
  if (e instanceof Anthropic.APIError) return { kind: (e.status ?? 0) >= 500 ? 'server_error' : 'bad_request', status: e.status };
  if (e instanceof Error && e.name === 'AbortError') return { kind: 'timeout' };
  return { kind: 'network' };
}

export function claudeProvider(cfg: ClaudeConfig): AiProvider {
  const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0, ...(cfg.fetch ? { fetch: cfg.fetch } : {}), ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) });

  async function run<T>(system: string, content: Anthropic.Beta.BetaContentBlockParam[], schema: Record<string, unknown>, parse: (raw: unknown) => T, signal: AbortSignal) {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      msg = await client.beta.messages.create({
        model: cfg.model,
        max_tokens: cfg.maxTokens ?? 8000,
        system,
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema }, effort: cfg.effort },
        ...(cfg.serverFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { signal });
    } catch (e) {
      const c = classify(e);
      throw new ProviderError(c.kind, 'claude', `Claude 请求失败（${c.kind}${c.status ? ` ${c.status}` : ''}）`, c.status);
    }
    const usage = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0 };
    if (msg.stop_reason === 'refusal') throw new ProviderError('refused', 'claude', 'Claude 拒绝处理这段内容');
    if (msg.stop_reason === 'max_tokens') throw new ProviderError('invalid_output', 'claude', '输出被截断');
    const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    try {
      return { value: parse(JSON.parse(text)), usage, model: msg.model ?? cfg.model };
    } catch (e) {
      throw new ProviderError('invalid_output', 'claude', `结构不合法：${e instanceof SchemaError ? e.message : 'JSON 解析失败'}`);
    }
  }

  return {
    name: 'claude',
    modelFor: () => cfg.model,
    extract(input, signal) {
      const images: Anthropic.Beta.BetaContentBlockParam[] = input.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } }));
      return run(EXTRACTION_SYSTEM, [...images, { type: 'text', text: extractionUserText(input) }], EXTRACTION_SCHEMA as unknown as Record<string, unknown>, parseExtraction, signal);
    },
    explain(input, allowedIds, allowedAmounts, signal) {
      return run(EXPLAIN_SYSTEM, [{ type: 'text', text: explainUserText(input) }], EXPLANATION_SCHEMA as unknown as Record<string, unknown>, (raw) => parseExplanation(raw, allowedIds, allowedAmounts), signal);
    },
  };
}
