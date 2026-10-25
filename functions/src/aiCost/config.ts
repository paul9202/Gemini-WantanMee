/**
 * AI 服务端配置：密钥只来自 Functions Secret Manager；模型 ID、地址、时限与额度为部署参数，用户与前端不能指定。
 * - 密钥为空或为 "unset" 视为未配置：识别 / 解读返回「未配置」，手动录入与其他账务照常。
 * - Functions Emulator 且 demo- 项目、又没有真实密钥时，改用模拟传输（mockTransport），用于本地验收；生产永远不会启用。
 */
import { defineInt, defineSecret, defineString } from 'firebase-functions/params';
import { claudeProvider } from './providers/claude';
import { deepseekProvider } from './providers/deepseek';
import { createMockFetch } from './mockTransport';
import type { AiProvider } from './types';
import { DEFAULT_PER_PROVIDER_MS, DEFAULT_TOTAL_MS } from './router';

export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
export const DEEPSEEK_API_KEY = defineSecret('DEEPSEEK_API_KEY');

const CLAUDE_MODEL = defineString('AI_CLAUDE_MODEL', { default: 'claude-opus-5-5' });
const CLAUDE_EFFORT = defineString('AI_CLAUDE_EFFORT', { default: 'medium' });
// Claude 服务端换模型（fallbacks: "default"，beta）尚未用真实账号验收，默认关闭；验收通过后可设为 true。
export const DEFAULT_SERVER_FALLBACK = 'false';
const CLAUDE_SERVER_FALLBACK = defineString('AI_CLAUDE_SERVER_FALLBACK', { default: DEFAULT_SERVER_FALLBACK });
/** 只有明确写 true 才开启。 */
export const serverFallbackOn = (v: string | undefined) => (v ?? DEFAULT_SERVER_FALLBACK).trim().toLowerCase() === 'true';
const DEEPSEEK_BASE_URL = defineString('AI_DEEPSEEK_BASE_URL', { default: 'https://api.deepseek.com' });
const DEEPSEEK_MODEL = defineString('AI_DEEPSEEK_MODEL', { default: 'deepseek-flash' });
const DEEPSEEK_VISION_MODEL = defineString('AI_DEEPSEEK_VISION_MODEL', { default: 'deepseek-flash' });
const DAILY_LIMIT = defineInt('AI_DAILY_ATTEMPT_LIMIT', { default: 100 });
const TOTAL_MS = defineInt('AI_TOTAL_TIMEOUT_MS', { default: DEFAULT_TOTAL_MS });
const PER_PROVIDER_MS = defineInt('AI_PROVIDER_TIMEOUT_MS', { default: DEFAULT_PER_PROVIDER_MS });

const configured = (v: string) => Boolean(v && v.trim() && v.trim() !== 'unset');

function secretValue(s: ReturnType<typeof defineSecret>): string {
  try {
    return s.value() ?? '';
  } catch {
    return '';
  }
}

export function isMockMode(): boolean {
  return process.env.FUNCTIONS_EMULATOR === 'true' && (process.env.GCLOUD_PROJECT ?? '').startsWith('demo-')
    && !configured(secretValue(ANTHROPIC_API_KEY)) && !configured(secretValue(DEEPSEEK_API_KEY));
}

export interface AiRuntime {
  primary: AiProvider | null;
  backup: AiProvider | null;
  mode: 'live' | 'mock';
  dailyLimit: number;
  totalMs: number;
  perProviderMs: number;
}

export function aiRuntime(): AiRuntime {
  const mock = isMockMode();
  const fetchImpl = mock ? createMockFetch() : undefined;
  const claudeKey = mock ? 'mock-key' : secretValue(ANTHROPIC_API_KEY);
  const deepseekKey = mock ? 'mock-key' : secretValue(DEEPSEEK_API_KEY);
  const effort = (['low', 'medium', 'high'] as const).find((e) => e === CLAUDE_EFFORT.value()) ?? 'medium';
  return {
    mode: mock ? 'mock' : 'live',
    primary: configured(claudeKey) ? claudeProvider({ apiKey: claudeKey, model: CLAUDE_MODEL.value(), effort, serverFallback: serverFallbackOn(CLAUDE_SERVER_FALLBACK.value()), fetch: fetchImpl }) : null,
    backup: configured(deepseekKey)
      ? deepseekProvider({ apiKey: deepseekKey, baseURL: DEEPSEEK_BASE_URL.value(), textModel: DEEPSEEK_MODEL.value(), visionModel: DEEPSEEK_VISION_MODEL.value(), fetch: fetchImpl })
      : null,
    dailyLimit: DAILY_LIMIT.value(),
    totalMs: Math.min(TOTAL_MS.value(), 100_000),
    perProviderMs: Math.min(PER_PROVIDER_MS.value(), 60_000),
  };
}
