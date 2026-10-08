import type { AIProvider, ProductAnalysis } from '@productspy/shared';
import { AppError } from '../server/errors';
import { MockAIProvider } from './mock-provider';
import { OpenAICompatibleProvider } from './openai-compatible-provider';

export function createAIProvider(): AIProvider {
  const mode = process.env.AI_MODE;
  const apiKey = process.env.AI_API_KEY?.trim() ?? '';
  if (mode === 'mock' || (!apiKey && mode !== 'real')) return new MockAIProvider();
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: process.env.AI_BASE_URL || undefined,
    model: process.env.AI_MODEL || undefined,
  });
}

const globalLocks = globalThis as typeof globalThis & { __productspyAnalysisLocks?: Set<string> };
const locks = (globalLocks.__productspyAnalysisLocks ??= new Set<string>());

export async function withProductAnalysisLock(
  key: string,
  analyze: () => Promise<ProductAnalysis>,
): Promise<ProductAnalysis> {
  if (locks.has(key)) throw new AppError(409, '此商品正在分析，请等待完成后刷新商品');
  locks.add(key);
  try {
    return await analyze();
  } finally {
    locks.delete(key);
  }
}

export { MockAIProvider } from './mock-provider';
export { OpenAICompatibleProvider } from './openai-compatible-provider';
