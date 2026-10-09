import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Product } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '../../../../../lib/ai/mock-provider';
import { getProductRepository } from '../../../../../lib/server/product-repository';
import { webHeaders } from '../../../../../lib/server/test-auth';
import { GET, POST } from './route';

describe('analysis-history API', () => {
  let directory: string;
  let product: Product;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-history-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    product = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Bottle',
      images: [],
      videos: [],
      bulletPoints: ['Portable'],
    });
    const analysis = await new MockAIProvider().analyze(product);
    product = await getProductRepository().saveAnalysis(product.id, analysis, product.updatedAt);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function context() {
    return { params: Promise.resolve({ id: product.id }) };
  }
  function request(method = 'GET', body?: unknown, authenticated = true) {
    return new Request(
      `http://127.0.0.1:3000/api/products/${encodeURIComponent(product.id)}/analysis-history`,
      {
        method,
        headers: {
          ...webHeaders('http://127.0.0.1:3000'),
          ...(!authenticated ? { cookie: '' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
  }

  it('only returns history to an authenticated local workspace', async () => {
    expect((await GET(request('GET', undefined, false), context())).status).toBe(401);
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown[] }).data).toHaveLength(1);
    const external = new Request('http://127.0.0.1:3000/api/products/x/analysis-history', {
      headers: { ...webHeaders('http://127.0.0.1:3000'), origin: 'https://evil.example' },
    });
    expect((await GET(external, context())).status).toBe(403);
  });

  it('requires a current version, restores by appending, and denies stale repeat restores', async () => {
    const versionId = product.analysisHistory![0]!.id;
    expect((await POST(request('POST', { versionId }), context())).status).toBe(400);
    const input = { versionId, expectedUpdatedAt: product.updatedAt };
    const restored = await POST(request('POST', input), context());
    expect(restored.status).toBe(200);
    const result = (await restored.json()) as { data: Product };
    expect(result.data.analysisHistory).toHaveLength(2);
    expect(result.data.analysisHistory?.at(-1)?.kind).toBe('restored');
    expect(result.data.aiAnalysis).toEqual(product.aiAnalysis);
    expect((await POST(request('POST', input), context())).status).toBe(409);
    expect(await getProductRepository().get(product.id)).toEqual(result.data);
  });
});
