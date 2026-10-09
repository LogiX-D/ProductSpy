import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  analysisSchema,
  type AnalysisGenerationResponse,
  type Product,
} from '@productspy/shared';
import { getProductRepository } from '../../../lib/server/product-repository';
import { MockAIProvider } from '../../../lib/ai/mock-provider';
import { POST } from './route';
import { webHeaders } from '../../../lib/server/test-auth';
import { getAnalysisUsageLedger } from '../../../lib/server/analysis-usage';

function request(product: unknown): Request {
  return new Request('http://127.0.0.1:3000/api/analyze-product', {
    method: 'POST',
    headers: webHeaders('http://127.0.0.1:3000'),
    body: JSON.stringify(product),
  });
}
describe('analyze-product API', () => {
  let directory: string;
  let product: Product;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-analysis-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    vi.stubEnv('AI_MODE', 'mock');
    vi.stubEnv('AI_API_KEY', '');
    product = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Test bottle',
      images: [],
      videos: [],
      bulletPoints: ['Reusable'],
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('generates and persists a complete Mock analysis', async () => {
    const response = await POST(request(product));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: unknown };
    expect(body.ok).toBe(true);
    const analysis = analysisSchema.parse(body.data);
    expect((await getProductRepository().get(product.id))?.aiAnalysis).toEqual(analysis);
  });
  it('rejects incomplete input and missing products', async () => {
    expect((await POST(request({ id: product.id }))).status).toBe(400);
    await getProductRepository().delete(product.id);
    expect((await POST(request(product))).status).toBe(404);
  });
  it('rejects stale product snapshots before calling AI', async () => {
    await getProductRepository().upsert({ ...product, price: '$20' });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await POST(request(product))).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves previous analysis and data when the AI API fails', async () => {
    const analysis = await new MockAIProvider().analyze(product);
    product = await getProductRepository().saveAnalysis(product.id, analysis);
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network unavailable')));
    expect((await POST(request({ product, authorizeReal: true }))).status).toBe(502);
    expect(await getProductRepository().get(product.id)).toEqual(product);
  });
  it('does not overwrite a product captured again during AI generation', async () => {
    const analysis = await new MockAIProvider().analyze(product);
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    let finish: ((response: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        started?.();
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }),
    );
    const pending = POST(request({ product, authorizeReal: true }));
    await active;
    await getProductRepository().upsert({ ...product, title: 'Updated during analysis' });
    finish?.(Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
    expect((await pending).status).toBe(409);
    const updated = await getProductRepository().get(product.id);
    expect(updated?.title).toBe('Updated during analysis');
    expect(updated?.aiAnalysis).toBeUndefined();
  });

  async function modern(input: unknown): Promise<AnalysisGenerationResponse> {
    const response = await POST(request(input));
    const result = (await response.json()) as {
      ok: boolean;
      data: AnalysisGenerationResponse;
      error?: string;
    };
    expect(response.status, result.error).toBe(200);
    expect(result.ok).toBe(true);
    return result.data;
  }

  it('supports parameters, structured provenance and zero-cost Mock without sending client history to AI', async () => {
    const generate = vi.spyOn(MockAIProvider.prototype, 'generate');
    const result = await modern({
      product: { ...product, title: 'Untrusted client replacement' },
      options: {
        market: 'JP',
        language: 'ja',
        duration: 15,
        customInstructions: 'Do not make claims about reviews.',
      },
      requestId: randomUUID(),
    });
    expect(generate.mock.calls[0]?.[0].title).toBe('Test bottle');
    expect(result.metadata.options).toMatchObject({ market: 'JP', language: 'ja', duration: 15 });
    expect(result.metadata.evidence.reviewTextAnalyzed).toBe(false);
    expect(result.metadata.usage).toMatchObject({ costUsd: 0, inputTokens: 0, outputTokens: 0 });
    expect(result.product.analysisHistory).toHaveLength(1);
    expect(result.product.analysisHistory?.[0]?.kind).toBe('generated');
    expect(result.product.analysisHistory?.[0]?.metadata).toEqual(result.metadata);
    expect(await readFile(join(directory, 'analysis-usage.json'), 'utf8')).not.toContain(
      'Do not make claims about reviews.',
    );
  });

  it('only replaces selected fields and archives existing human edits', async () => {
    const initial = await new MockAIProvider().analyze(product);
    const manual = {
      ...initial,
      summary: 'Human summary\nKeep this exact line',
      hooks: ['Human 1', 'Human 2', 'Human 3', 'Human 4', 'Human 5'],
    };
    product = await getProductRepository().saveAnalysis(product.id, manual, product.updatedAt);
    const {
      analysisHistory: _history,
      aiAnalysis: _analysis,
      analysisMetadata: _metadata,
      ...snapshot
    } = product;
    const result = await modern({
      product: snapshot,
      fields: ['hooks'],
      options: { style: 'humorous' },
    });
    expect(result.analysis.summary).toBe(manual.summary);
    expect(result.analysis.sellingPoints).toEqual(manual.sellingPoints);
    expect(result.analysis.hooks).not.toEqual(manual.hooks);
    expect(result.metadata.selectedFields).toEqual(['hooks']);
    expect(result.product.analysisHistory?.[0]?.analysis).toEqual(manual);
    expect(result.product.analysisHistory).toHaveLength(2);
  });

  it('replays an identical request without another generation and rejects reused IDs with changed options', async () => {
    const generate = vi.spyOn(MockAIProvider.prototype, 'generate');
    const input = { product, options: DEFAULT_ANALYSIS_OPTIONS, requestId: randomUUID() };
    const first = await modern(input);
    const replay = await modern(input);
    expect(replay.replayed).toBe(true);
    expect(replay.analysis).toEqual(first.analysis);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await getAnalysisUsageLedger().report()).totals.requests).toBe(1);
    const edited = await getProductRepository().saveAnalysis(
      product.id,
      { ...first.analysis, summary: 'Edited after generation' },
      first.product.updatedAt,
    );
    const laterReplay = await modern(input);
    expect(laterReplay.analysis).toEqual(first.analysis);
    expect(laterReplay.product.aiAnalysis).toEqual(edited.aiAnalysis);
    expect(await getProductRepository().get(product.id)).toEqual(edited);
    expect(
      (await POST(request({ ...input, options: { ...DEFAULT_ANALYSIS_OPTIONS, language: 'en' } })))
        .status,
    ).toBe(409);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('requires explicit consent for real AI including legacy clients, with no call or usage reservation', async () => {
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await POST(request(product))).status).toBe(428);
    expect((await POST(request({ product, authorizeReal: false }))).status).toBe(428);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getAnalysisUsageLedger().report()).totals.requests).toBe(0);
  });

  it('counts actual tokens, estimates only explicit pricing and keeps missing usage unknown', async () => {
    const analysis = await new MockAIProvider().analyze(product);
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: JSON.stringify(analysis) } }],
          usage: { prompt_tokens: 100, completion_tokens: 250 },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] }),
      );
    vi.stubGlobal('fetch', fetch);
    const first = await modern({
      product,
      authorizeReal: true,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
    });
    expect(first.metadata.mode).toBe('real');
    expect(first.metadata.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 250,
      costUsd: 0.0011,
      costEstimated: true,
    });
    const second = await modern({ product: first.product, authorizeReal: true });
    expect(second.metadata.usage?.inputTokens).toBeUndefined();
    expect(second.metadata.usage?.costUsd).toBeUndefined();
    const report = await getAnalysisUsageLedger().report();
    expect(report.totals.unknownCostRequests).toBe(1);
    expect(report.totals.unknownTokenRequests).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed before AI when the usage ledger cannot be read or persisted', async () => {
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await writeFile(join(directory, 'analysis-usage.json'), '{broken');
    expect((await POST(request({ product, authorizeReal: true }))).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(directory, 'analysis-usage.json'), 'utf8')).toBe('{broken');
    await rm(join(directory, 'analysis-usage.json'));
    const begin = vi
      .spyOn(getAnalysisUsageLedger(), 'begin')
      .mockRejectedValueOnce(new Error('permission denied'));
    expect((await POST(request({ product, authorizeReal: true }))).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
    begin.mockRestore();
  });

  it('respects real request daily limits and avoids retrying rate-limited calls', async () => {
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    vi.stubEnv('AI_DAILY_REQUEST_LIMIT', '1');
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    vi.stubGlobal('fetch', fetch);
    const first = await POST(request({ product, authorizeReal: true, requestId: randomUUID() }));
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('120');
    expect(
      (await POST(request({ product, authorizeReal: true, requestId: randomUUID() }))).status,
    ).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await getAnalysisUsageLedger().report()).limits.cooldownUntil).toBeDefined();
  });

  it('checks the history limit and partial-generation prerequisites before spending', async () => {
    expect((await POST(request({ product, fields: ['hooks'] }))).status).toBe(400);
    const analysis = await new MockAIProvider().analyze(product);
    for (let index = 0; index < 50; index++)
      product = await getProductRepository().saveAnalysis(
        product.id,
        { ...analysis, summary: `Revision ${index}` },
        product.updatedAt,
      );
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect((await POST(request({ product, authorizeReal: true }))).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    expect((await getAnalysisUsageLedger().report()).totals.requests).toBe(0);
  });

  it('caps real requests at two and rejects simultaneous requests for the same product', async () => {
    const second = await getProductRepository().upsert({
      ...product,
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
    });
    const third = await getProductRepository().upsert({
      ...product,
      sourceId: 'B012345680',
      url: 'https://www.amazon.com/dp/B012345680',
    });
    const analysis = await new MockAIProvider().analyze(product);
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'test-placeholder');
    const finishes: Array<(response: Response) => void> = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => finishes.push(resolve)));
    vi.stubGlobal('fetch', fetch);
    const firstPending = POST(request({ product, authorizeReal: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect((await POST(request({ product, authorizeReal: true }))).status).toBe(409);
    const secondPending = POST(request({ product: second, authorizeReal: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((await POST(request({ product: third, authorizeReal: true }))).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const finish of finishes)
      finish(Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
    expect((await firstPending).status).toBe(200);
    expect((await secondPending).status).toBe(200);
    expect((await getAnalysisUsageLedger().report()).totals.realRequests).toBe(2);
  });

  it('keeps a saved result replayable if usage completion storage fails', async () => {
    const generate = vi.spyOn(MockAIProvider.prototype, 'generate');
    const finish = vi
      .spyOn(getAnalysisUsageLedger(), 'finish')
      .mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    const input = { product, requestId: randomUUID() };
    const first = await modern(input);
    expect((await getProductRepository().get(product.id))?.aiAnalysis).toEqual(first.analysis);
    const replay = await modern(input);
    expect(replay.replayed).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await getAnalysisUsageLedger().report()).records[0]?.status).toBe('started');
    finish.mockRestore();
  });
});
