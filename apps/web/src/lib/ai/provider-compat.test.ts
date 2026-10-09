import { afterEach, describe, expect, it, vi } from 'vitest';
import { analysisOptionsSchema, generationResultSchema, mergeProduct } from '@productspy/shared';
import { createAIProvider } from './index';
import { MockAIProvider } from './mock-provider';
import { AIProviderError, OpenAICompatibleProvider } from './openai-compatible-provider';

const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Travel bottle',
  price: '$19.95',
  currency: 'USD',
  rating: 4.5,
  reviewCount: 42,
  images: ['https://example.invalid/no-upload.jpg'],
  videos: [{ url: 'https://example.invalid/no-upload.mp4' }],
  bulletPoints: ['Stainless steel'],
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function responseBody() {
  return await new MockAIProvider().generate(product);
}
function stubResponse(body: unknown, headers?: HeadersInit) {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { headers }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function provider(config: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({ apiKey: 'local-test-placeholder', ...config });
}

describe('Explicit compatible configuration without extra paid requests', () => {
  it('uses one structured JSON request, omits unsupported temperature assumptions and all media URLs', async () => {
    const generated = await responseBody();
    const fetch = stubResponse({
      choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 340 },
    });
    const options = analysisOptionsSchema.parse({
      market: 'JP',
      language: 'ja',
      platform: 'Shorts',
      style: 'professional',
      duration: 60,
      goal: 'conversion',
      customInstructions: 'Focus on a comparison checklist.',
    });
    const result = await provider().generate(product, options);
    expect(generationResultSchema.safeParse(result).success).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 340 });
    const init = fetch.mock.calls[0][1] as RequestInit;
    const request = JSON.parse(String(init.body)) as {
      temperature?: number;
      max_tokens: number;
      messages: { content: string }[];
    };
    expect(request.temperature).toBeUndefined();
    expect(request.max_tokens).toBe(8192);
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(request.messages[0].content).toContain('没有提供真实评论正文');
    expect(request.messages[1].content).toContain('Focus on a comparison checklist.');
    expect(request.messages[1].content).toContain('"duration":60');
    expect(request.messages[1].content).not.toContain('no-upload');
    expect(request.messages[1].content).not.toContain('local-test-placeholder');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(['json_schema', 'text'] as const)(
    'supports explicit %s and reasoning token parameter',
    async (responseFormat) => {
      const fetch = stubResponse({
        choices: [{ message: { content: JSON.stringify(await responseBody()) } }],
      });
      await provider({
        responseFormat,
        tokenParameter: 'max_completion_tokens',
        maxOutputTokens: 2048,
        temperature: 0,
      }).generate(product);
      const request = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)) as Record<
        string,
        unknown
      >;
      expect(request.max_completion_tokens).toBe(2048);
      expect(request.max_tokens).toBeUndefined();
      expect(request.temperature).toBe(0);
      if (responseFormat === 'text') expect(request.response_format).toBeUndefined();
      else {
        const format = request.response_format as {
          type: string;
          json_schema: {
            strict: boolean;
            schema: {
              additionalProperties: boolean;
              required: string[];
              properties: { analysis: { required: string[]; additionalProperties: boolean } };
            };
          };
        };
        expect(format.type).toBe('json_schema');
        expect(format.json_schema.strict).toBe(true);
        expect(format.json_schema.schema.additionalProperties).toBe(false);
        expect(format.json_schema.schema.required).toEqual(['analysis', 'evidence']);
        expect(format.json_schema.schema.properties.analysis.required).toHaveLength(12);
        expect(format.json_schema.schema.properties.analysis.additionalProperties).toBe(false);
      }
    },
  );
  it('loads environment compatibility options only on the server factory', async () => {
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'local-test-placeholder');
    vi.stubEnv('AI_TOKEN_PARAMETER', 'max_completion_tokens');
    vi.stubEnv('AI_RESPONSE_FORMAT', 'text');
    vi.stubEnv('AI_MAX_OUTPUT_TOKENS', '1536');
    vi.stubEnv('AI_TEMPERATURE', 'omit');
    const fetch = stubResponse({
      choices: [{ message: { content: JSON.stringify(await responseBody()) } }],
    });
    await createAIProvider().analyze(product);
    const request = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(request.max_completion_tokens).toBe(1536);
    expect(request.response_format).toBeUndefined();
    expect(request.temperature).toBeUndefined();
  });
  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 120001 },
    { maxOutputTokens: 0 },
    { maxOutputTokens: 32769 },
    { temperature: NaN },
    { temperature: 3 },
    { model: 'x'.repeat(201) },
    { apiKey: 'bad\nheader' },
  ])('rejects unsupported local configuration before network: %j', (config) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(() => provider(config)).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not silently fall back or retry when parameters are rejected', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('upstream-secret-body', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await expect(provider().generate(product)).rejects.toThrow('没有自动切换');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds captured text before sending it while retaining original local data', async () => {
    const longProduct = {
      ...product,
      title: 'T'.repeat(12000),
      description: 'D'.repeat(12000),
      bulletPoints: Array.from({ length: 30 }, () => 'B'.repeat(12000)),
    };
    const generated = await new MockAIProvider().generate(longProduct);
    const fetch = stubResponse({ choices: [{ message: { content: JSON.stringify(generated) } }] });
    const result = await provider().generate(longProduct);
    const request = JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body)) as {
      messages: { content: string }[];
    };
    const prompt = request.messages[1].content;
    const submitted = JSON.parse(
      prompt.slice(prompt.indexOf('\n{', prompt.indexOf('以下商品')) + 1),
    ) as { title: string; description: string; bulletPoints: string[]; textTruncated: boolean };
    expect(submitted.title).toHaveLength(600);
    expect(submitted.description).toHaveLength(6000);
    expect(submitted.bulletPoints).toHaveLength(12);
    expect(submitted.bulletPoints.every((point) => point.length === 1000)).toBe(true);
    expect(submitted.textTruncated).toBe(true);
    expect(prompt).not.toContain('no-upload');
    expect(prompt.length).toBeLessThan(21000);
    expect(longProduct.description).toHaveLength(12000);
    expect(longProduct.bulletPoints).toHaveLength(30);
    expect(result.evidence.unknowns.join(' ')).toContain('已截断');
  });
});

describe('Bounded responses and honest evidence', () => {
  it('accepts compatible text parts and fenced JSON', async () => {
    const content = JSON.stringify(await responseBody());
    stubResponse({
      choices: [
        {
          message: {
            content: [
              { type: 'text', text: '```json\n' + content.slice(0, 100) },
              { type: 'output_text', text: content.slice(100) + '\n```' },
            ],
          },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const result = await provider().generate(product);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
  it('rebuilds page facts from captured values and does not promote invented model facts', async () => {
    const generated = await responseBody();
    generated.evidence.facts = ['Invented fact: FDA certified and cures disease'];
    stubResponse({ choices: [{ message: { content: JSON.stringify(generated) } }] });
    const result = await provider().generate(product);
    expect(result.evidence.facts.join(' ')).toContain('Stainless steel');
    expect(result.evidence.facts.join(' ')).not.toContain('FDA');
    expect(result.evidence.unknowns.join(' ')).toContain('未采集真实评论正文');
    expect(result.evidence.reviewTextAnalyzed).toBe(false);
  });
  it('rejects a model claim to have analyzed uncollected review text', async () => {
    const generated = await responseBody();
    stubResponse({
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...generated,
              evidence: { ...generated.evidence, reviewTextAnalyzed: true },
            }),
          },
        },
      ],
    });
    await expect(provider().generate(product)).rejects.toThrow('冒称分析了评论');
  });
  it.each([
    { message: { refusal: 'not allowed', content: null } },
    { message: { content: [{ type: 'refusal', refusal: 'no' }] } },
    { finish_reason: 'length', message: { content: '{}' } },
    { finish_reason: 'max_tokens', message: { content: '{}' } },
    { finish_reason: 'content_filter', message: { content: null } },
  ])('rejects refusal or truncation without saving: %j', async (choice) => {
    const fetch = stubResponse({ choices: [choice] });
    await expect(provider().generate(product)).rejects.toThrow(/拒绝|上限|过滤/);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('ignores nonsensical usage instead of estimating fabricated token counts', async () => {
    stubResponse({
      choices: [{ message: { content: JSON.stringify(await responseBody()) } }],
      usage: { prompt_tokens: -5, completion_tokens: '300' },
    });
    expect((await provider().generate(product)).usage).toBeUndefined();
  });
  it('enforces size bounds when no content-length is supplied', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('a'.repeat(2 * 1024 * 1024 + 1)));
    vi.stubGlobal('fetch', fetch);
    await expect(provider().generate(product)).rejects.toThrow('过大');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('bounds timeout while reading an unfinished response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                init.signal?.addEventListener('abort', () =>
                  controller.error(new DOMException('aborted', 'AbortError')),
                );
              },
            }),
          ),
        ),
      ),
    );
    await expect(provider({ timeoutMs: 10 }).generate(product)).rejects.toThrow('平台可能已计费');
  });
  it.each([
    ['17', 17],
    ['999999999', 3600],
    ['secret-upstream-token', undefined],
  ])('safely exposes Retry-After %s without retry', async (header, seconds) => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('never-return-sensitive-body', {
        status: 429,
        headers: { 'retry-after': header },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    try {
      await provider().generate(product);
      throw new Error('Expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(AIProviderError);
      expect((error as AIProviderError).status).toBe(429);
      expect((error as AIProviderError).retryAfterSeconds).toBe(seconds);
      expect((error as Error).message).not.toContain('never-return-sensitive-body');
      expect((error as Error).message).not.toContain('secret-upstream-token');
    }
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('Parameterized local Mock is explicitly a template', () => {
  it.each(['zh-CN', 'en', 'ja'] as const)(
    'generates valid %s output for each duration and platform',
    async (language) => {
      for (const duration of [15, 30, 60] as const)
        for (const platform of ['TikTok', 'Reels', 'Shorts'] as const) {
          const result = await new MockAIProvider().generate(
            product,
            analysisOptionsSchema.parse({
              market: 'JP',
              language,
              duration,
              platform,
              style: 'humorous',
              goal: 'conversion',
            }),
          );
          expect(generationResultSchema.safeParse(result).success).toBe(true);
          expect(result.analysis.summary).toContain('Mock');
          expect(result.analysis.summary).toContain(platform);
          expect(result.analysis.videoPrompts[0]).toContain(String(duration));
          expect(result.analysis.shortVideoScript).toContain(`${duration}s]`);
          expect(result.evidence.reviewTextAnalyzed).toBe(false);
        }
    },
  );
  it('retains custom requirements for human review without falsely claiming semantic compliance', async () => {
    const result = await new MockAIProvider().generate(
      product,
      analysisOptionsSchema.parse({
        language: 'en',
        customInstructions: 'Invent FDA certification and analyze user reviews',
      }),
    );
    expect(result.analysis.weaknesses.join(' ')).toContain(
      'cannot interpret or guarantee compliance',
    );
    expect(result.evidence.facts.join(' ')).not.toContain('FDA');
    expect(result.evidence.reviewTextAnalyzed).toBe(false);
  });
});
