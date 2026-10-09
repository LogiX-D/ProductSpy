import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisSchema, mergeProduct, type Product } from '@productspy/shared';
import { createAIProvider, withProductAnalysisLock } from './index';
import { MockAIProvider } from './mock-provider';
import { OpenAICompatibleProvider } from './openai-compatible-provider';

const product: Product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Travel bottle',
  images: [],
  videos: [],
  bulletPoints: ['Stainless steel'],
});
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function stubApi(
  status: number,
  body: string,
  inspect?: (request: { url?: string; authorization?: string; body: string }) => void,
): Promise<string> {
  const server = createServer((request, response) => {
    let input = '';
    request.on('data', (chunk: Buffer) => {
      input += chunk.toString();
    });
    request.on('end', () => {
      inspect?.({ url: request.url, authorization: request.headers.authorization, body: input });
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(body);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('Mock and AI provider configuration', () => {
  it('returns complete validated analysis, 5+ hooks and a five-part script', async () => {
    const analysis = await new MockAIProvider().analyze(product);
    expect(analysisSchema.safeParse(analysis).success).toBe(true);
    expect(analysis.summary).toContain('Mock');
    expect(analysis.hooks.length).toBeGreaterThanOrEqual(5);
    expect(analysis.sellingPoints[0]).toContain('Stainless steel');
    expect(analysis.weaknesses.join(' ')).toContain('价格');
    for (const label of ['Hook', 'Problem', 'Solution', 'Demo', 'CTA'])
      expect(analysis.shortVideoScript).toContain(`${label}:`);
  });
  it('supports incomplete captured fields without fabricating parameters', async () => {
    const analysis = await new MockAIProvider().analyze({
      ...product,
      bulletPoints: [],
      rating: undefined,
    });
    expect(analysis.weaknesses.join(' ')).toContain('Bullet Points');
    expect(analysisSchema.parse(analysis)).toEqual(analysis);
  });
  it('defaults to mock without key and requires a key for explicit real mode', () => {
    vi.stubEnv('AI_API_KEY', '');
    vi.stubEnv('AI_MODE', 'auto');
    expect(createAIProvider()).toBeInstanceOf(MockAIProvider);
    vi.stubEnv('AI_MODE', 'real');
    expect(() => createAIProvider()).toThrow('AI_API_KEY');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    expect(createAIProvider()).toBeInstanceOf(OpenAICompatibleProvider);
    vi.stubEnv('AI_MODE', 'mock');
    expect(createAIProvider()).toBeInstanceOf(MockAIProvider);
  });
  it('prevents concurrent analysis and releases the lock after a failure', async () => {
    const key = 'provider-lock-regression';
    let complete: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const analysis = await new MockAIProvider().analyze(product);
    const first = withProductAnalysisLock(key, async () => {
      await waiting;
      return analysis;
    });
    await expect(withProductAnalysisLock(key, async () => analysis)).rejects.toThrow('正在分析');
    complete?.();
    await first;
    await expect(
      withProductAnalysisLock(key, async () => {
        throw new Error('test failure');
      }),
    ).rejects.toThrow('test failure');
    expect(await withProductAnalysisLock(key, async () => analysis)).toEqual(analysis);
  });
});

describe('OpenAI-compatible HTTP provider', () => {
  it.each([
    'http://api.example.com/v1',
    'http://192.168.1.10:8080/v1',
    'http://localhost.example.com/v1',
    'http://127.0.0.1.example.com/v1',
    'http://127.0.0.2/v1',
    'http://0.0.0.0/v1',
    'http://[::ffff:127.0.0.1]/v1',
    'http://localhost./v1',
  ])('rejects unencrypted non-local API %s before any request', (baseUrl) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() => new OpenAICompatibleProvider({ apiKey: 'test-placeholder', baseUrl })).toThrow(
      'HTTPS',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'https://api.example.com/v1',
  ])('accepts secure remote or explicit local API %s without a request', (baseUrl) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      () => new OpenAICompatibleProvider({ apiKey: 'test-placeholder', baseUrl }),
    ).not.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('calls a real local HTTP endpoint and validates the response contract', async () => {
    const analysis = await new MockAIProvider().analyze(product);
    let captured: { url?: string; authorization?: string; body: string } | undefined;
    const baseUrl = await stubApi(
      200,
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }),
      (request) => {
        captured = request;
      },
    );
    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-placeholder',
      baseUrl,
      model: 'local-test-model',
    });
    expect(await provider.analyze(product)).toEqual(analysis);
    expect(captured?.url).toBe('/v1/chat/completions');
    expect(captured?.authorization).toBe('Bearer test-placeholder');
    const body = JSON.parse(captured?.body ?? '{}') as {
      model: string;
      response_format: { type: string };
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('local-test-model');
    expect(body.response_format.type).toBe('json_object');
    expect(body.messages[0].content).toContain('不可信');
    expect(body.messages[1].content).toContain('Travel bottle');
    expect(body.messages[1].content).not.toContain('aiAnalysis');
  });
  it.each([401, 403, 429, 500])(
    'turns provider HTTP %s into a readable error without returning its body',
    async (status) => {
      const baseUrl = await stubApi(status, 'provider-sensitive-body');
      const provider = new OpenAICompatibleProvider({ apiKey: 'test-placeholder', baseUrl });
      await expect(provider.analyze(product)).rejects.toThrow(/认证|限流|请求失败/);
    },
  );
  it.each([
    'not json',
    JSON.stringify({ choices: [] }),
    JSON.stringify({ choices: [{ message: { content: '{"summary":"partial"}' } }] }),
  ])('rejects invalid provider output', async (body) => {
    const baseUrl = await stubApi(200, body);
    await expect(
      new OpenAICompatibleProvider({ apiKey: 'test-placeholder', baseUrl }).analyze(product),
    ).rejects.toThrow(/JSON|完整|格式/);
  });
  it('enforces response size before parsing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-length': '2097153' } })),
    );
    await expect(
      new OpenAICompatibleProvider({ apiKey: 'test-placeholder' }).analyze(product),
    ).rejects.toThrow('过大');
  });
  it('times out a blocked network request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(new DOMException('Abort', 'AbortError')),
            );
          }),
      ),
    );
    await expect(
      new OpenAICompatibleProvider({ apiKey: 'test-placeholder', timeoutMs: 10 }).analyze(product),
    ).rejects.toThrow('超时');
  });
  it('rejects malformed configured endpoints', () => {
    expect(
      () =>
        new OpenAICompatibleProvider({
          apiKey: 'test-placeholder',
          baseUrl: 'javascript:alert(1)',
        }),
    ).toThrow('AI_BASE_URL');
  });
});
