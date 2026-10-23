import type { AIProvider } from '@productspy/shared';
import { AppError } from '../server/errors';
import { MockAIProvider } from './mock-provider';
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from './openai-compatible-provider';

export function createAIProvider(): AIProvider {
  const mode = process.env.AI_MODE;
  const apiKey = process.env.AI_API_KEY?.trim() ?? '';
  if (mode === 'mock' || (!apiKey && mode !== 'real')) return new MockAIProvider();
  return new OpenAICompatibleProvider(legacyAIConfig());
}

/** Historical single-channel environment remains supported without exposing its key. */
export function legacyAIConfig(): OpenAICompatibleConfig {
  const apiKey = process.env.AI_API_KEY?.trim() ?? '';
  const responseFormat = process.env.AI_RESPONSE_FORMAT?.trim() || 'json_object';
  const tokenParameter = process.env.AI_TOKEN_PARAMETER?.trim() || 'max_tokens';
  if (!['json_object', 'json_schema', 'text'].includes(responseFormat))
    throw new AppError(503, 'AI_RESPONSE_FORMAT 需要 json_object、json_schema 或 text');
  if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter))
    throw new AppError(503, 'AI_TOKEN_PARAMETER 需要 max_tokens 或 max_completion_tokens');
  const temperature = process.env.AI_TEMPERATURE?.trim();
  const thinking = process.env.AI_THINKING?.trim();
  if (thinking && !['omit', 'disabled', 'enabled'].includes(thinking))
    throw new AppError(503, 'AI_THINKING 需要 omit、disabled 或 enabled');
  return {
    apiKey,
    baseUrl: process.env.AI_BASE_URL || undefined,
    model: process.env.AI_MODEL || undefined,
    responseFormat: responseFormat as 'json_object' | 'json_schema' | 'text',
    tokenParameter: tokenParameter as 'max_tokens' | 'max_completion_tokens',
    timeoutMs: process.env.AI_TIMEOUT_MS?.trim() ? Number(process.env.AI_TIMEOUT_MS) : undefined,
    maxOutputTokens: process.env.AI_MAX_OUTPUT_TOKENS?.trim()
      ? Number(process.env.AI_MAX_OUTPUT_TOKENS)
      : undefined,
    temperature: !temperature || temperature === 'omit' ? undefined : Number(temperature),
    thinking: !thinking || thinking === 'omit' ? undefined : (thinking as 'disabled' | 'enabled'),
  };
}

const globalLocks = globalThis as typeof globalThis & { __productspyAnalysisLocks?: Set<string> };
const locks = (globalLocks.__productspyAnalysisLocks ??= new Set<string>());

export async function withProductAnalysisLock<T>(
  key: string,
  analyze: () => Promise<T>,
): Promise<T> {
  if (locks.has(key)) throw new AppError(409, '此商品正在分析，请等待完成后刷新商品');
  locks.add(key);
  try {
    return await analyze();
  } finally {
    locks.delete(key);
  }
}

export { MockAIProvider } from './mock-provider';
export { OpenAICompatibleProvider, AIProviderError } from './openai-compatible-provider';
