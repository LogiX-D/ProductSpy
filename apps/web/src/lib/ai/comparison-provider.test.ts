import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  comparisonGenerationSchema,
  mergeProduct,
} from '@productspy/shared';
import { mockComparison } from './comparison-mock';
import {
  comparisonCapturedEvidence,
  comparisonFacts,
  COMPARISON_SYSTEM_PROMPT,
} from './comparison-generation';
import { MockAIProvider } from './mock-provider';
import { OpenAICompatibleProvider } from './openai-compatible-provider';

const products = ['B012345678', 'B012345679'].map((sourceId, index) =>
  mergeProduct({
    source: 'amazon',
    sourceId,
    url: `https://www.amazon.com/dp/${sourceId}`,
    title: `Bottle ${sourceId}`,
    price: index ? '￥2500' : '$25',
    currency: index ? 'JPY' : 'USD',
    brand: 'PageBrand',
    rating: 4.6,
    reviewCount: 526,
    mainImage: 'https://m.media-amazon.com/images/I/asset.jpg',
    images: ['https://m.media-amazon.com/images/I/asset.jpg'],
    videos: [{ url: 'https://m.media-amazon.com/asset.mp4' }],
    bulletPoints: ['The seller says this is steel'],
  }),
);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('comparison AI transport and provenance (Stub / Mock only)', () => {
  it.each(['zh-CN', 'en', 'ja'] as const)(
    'produces labelled %s Mock with stored options and no fabricated reviews',
    async (language) => {
      const result = await new MockAIProvider().compare(products, {
        ...DEFAULT_ANALYSIS_OPTIONS,
        language,
        duration: 15,
        customInstructions: 'Use a checklist',
      });
      expect(comparisonGenerationSchema.safeParse(result).success).toBe(true);
      expect(result.analysis.coreDifferences.join(' ')).toContain('Mock');
      expect(result.analysis.risks.join(' ')).toContain('Use a checklist');
      expect(result.analysis.videoRecommendations[0]).toContain('15s');
      expect(result.evidence.reviewTextAnalyzed).toBe(false);
    },
  );
  it('keeps seller claims outside captured facts and removes media/AI history from request data', () => {
    const generated = mockComparison(products);
    const evidence = comparisonCapturedEvidence(
      products,
      DEFAULT_ANALYSIS_OPTIONS,
      generated.analysis,
    );
    expect(evidence.facts.join(' ')).toContain('526');
    expect(evidence.facts.join(' ')).not.toContain('steel');
    expect(evidence.merchantClaims.join(' ')).toContain('steel');
    const facts = JSON.stringify(comparisonFacts(products));
    expect(facts).not.toContain('media-amazon.com');
    expect(facts).not.toContain('analysisHistory');
    expect(facts).toContain('reviewTextCollected');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不得虚构销量');
    expect(COMPARISON_SYSTEM_PROMPT).toContain('不同货币');
  });
  it('uses the existing key transport, schema, no redirects and grounded server evidence', async () => {
    const generated = mockComparison(products);
    const value = {
      ...generated,
      evidence: {
        ...generated.evidence,
        facts: ['Model invented 10,000 sales'],
        merchantClaims: ['Invented waterproof claim'],
      },
    };
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 300, completion_tokens: 500 },
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'stub-not-real-key',
      baseUrl: 'https://example.com/v1',
      responseFormat: 'json_schema',
    });
    const result = await provider.compare(products);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer stub-not-real-key');
    const request = JSON.parse(String(init.body)) as {
      response_format: { json_schema: { name: string } };
      messages: { content: string }[];
    };
    expect(request.response_format.json_schema.name).toBe('productspy_comparison');
    expect(request.messages[1]?.content).not.toContain('media-amazon.com');
    expect(result.evidence.facts.join(' ')).not.toContain('10,000');
    expect(result.evidence.merchantClaims.join(' ')).not.toContain('waterproof');
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 500 });
  });
  it('rejects review impersonation, malformed output and truncated output without retries', async () => {
    const generated = mockComparison(products);
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                ...generated,
                evidence: { ...generated.evidence, reviewTextAnalyzed: true },
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetcher);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'stub-not-real-key',
      baseUrl: 'https://example.com/v1',
    });
    await expect(provider.compare(products)).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(
      Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'length' }] }),
    );
    await expect(provider.compare(products)).rejects.toThrow('长度上限');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('propagates 429 and timeout without silently changing provider or retrying', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '45' } }));
    vi.stubGlobal('fetch', fetcher);
    await expect(
      new OpenAICompatibleProvider({ apiKey: 'stub', baseUrl: 'https://example.com/v1' }).compare(
        products,
      ),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: 45 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockImplementation(
      (_url: string, input: RequestInit) =>
        new Promise((_resolve, reject) =>
          input.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    await expect(
      new OpenAICompatibleProvider({
        apiKey: 'stub',
        baseUrl: 'https://example.com/v1',
        timeoutMs: 5,
      }).compare(products),
    ).rejects.toMatchObject({ status: 504 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
