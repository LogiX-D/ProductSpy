import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analysisSchema, type Product } from '@productspy/shared';
import { getProductRepository } from '../../../lib/server/product-repository';
import { MockAIProvider } from '../../../lib/ai/mock-provider';
import { POST } from './route';
import { webHeaders } from '../../../lib/server/test-auth';

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
    expect((await POST(request(product))).status).toBe(502);
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
    const pending = POST(request(product));
    await active;
    await getProductRepository().upsert({ ...product, title: 'Updated during analysis' });
    finish?.(Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] }));
    expect((await pending).status).toBe(409);
    const updated = await getProductRepository().get(product.id);
    expect(updated?.title).toBe('Updated during analysis');
    expect(updated?.aiAnalysis).toBeUndefined();
  });
});
