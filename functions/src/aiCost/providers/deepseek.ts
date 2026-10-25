/**
 * DeepSeek（备用）：OpenAI 兼容的 /chat/completions，JSON 输出模式。没有官方 Node SDK，直接用 fetch。
 * 图片只在配置了支持视觉的模型时发送（data:URL base64）；未配置时不把图片路径当文字假装识图。
 */
import { EXPLAIN_SYSTEM, EXTRACTION_SYSTEM, explainUserText, extractionUserText, jsonShapeHint } from '../prompts';
import { EXPLANATION_SCHEMA, EXTRACTION_SCHEMA, parseExplanation, parseExtraction, SchemaError } from '../schema';
import { AiProvider, ProviderError } from '../types';

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  textModel: string;
  /** 支持图片输入的模型；空字符串 = 备用不处理收据照片。 */
  visionModel: string;
  maxTokens?: number;
  fetch?: typeof fetch;
}

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

export function deepseekProvider(cfg: DeepSeekConfig): AiProvider {
  const doFetch = cfg.fetch ?? fetch;

  async function run<T>(model: string, system: string, user: string | Part[], parse: (raw: unknown) => T, signal: AbortSignal) {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseURL.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, max_tokens: cfg.maxTokens ?? 6000, stream: false }),
      });
    } catch (e) {
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      throw new ProviderError(aborted ? 'timeout' : 'network', 'deepseek', aborted ? 'DeepSeek 超时' : 'DeepSeek 网络失败');
    }
    if (!res.ok) {
      const s = res.status;
      const kind = s === 429 ? 'rate_limited' : s >= 500 ? 'server_error' : s === 401 || s === 402 || s === 403 ? 'config' : 'bad_request';
      await res.body?.cancel().catch(() => undefined);
      throw new ProviderError(kind, 'deepseek', `DeepSeek 请求失败（${s}）`, s);
    }
    let body: { model?: string; choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    try {
      body = await res.json();
    } catch {
      throw new ProviderError('invalid_output', 'deepseek', 'DeepSeek 返回不是 JSON');
    }
    const usage = { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 };
    const choice = body.choices?.[0];
    if (choice?.finish_reason === 'length') throw new ProviderError('invalid_output', 'deepseek', '输出被截断');
    const text = choice?.message?.content ?? '';
    if (!text.trim()) throw new ProviderError('invalid_output', 'deepseek', '空输出');
    try {
      return { value: parse(JSON.parse(text)), usage, model: body.model ?? model };
    } catch (e) {
      throw new ProviderError('invalid_output', 'deepseek', `结构不合法：${e instanceof SchemaError ? e.message : 'JSON 解析失败'}`);
    }
  }

  const modelFor = (task: 'extract' | 'explain', hasImages: boolean) => (task === 'extract' && hasImages ? cfg.visionModel || null : cfg.textModel);

  return {
    name: 'deepseek',
    modelFor,
    extract(input, signal) {
      const model = modelFor('extract', input.images.length > 0);
      if (!model) return Promise.reject(new ProviderError('vision_unavailable', 'deepseek', '备用模型未配置图片识别'));
      const text = extractionUserText(input);
      const user: string | Part[] = input.images.length
        ? [...input.images.map((img): Part => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })), { type: 'text', text }]
        : text;
      return run(model, EXTRACTION_SYSTEM + jsonShapeHint(EXTRACTION_SCHEMA), user, parseExtraction, signal);
    },
    explain(input, allowedIds, allowedAmounts, signal) {
      return run(cfg.textModel, EXPLAIN_SYSTEM + jsonShapeHint(EXPLANATION_SCHEMA), explainUserText(input), (raw) => parseExplanation(raw, allowedIds, allowedAmounts), signal);
    },
  };
}
