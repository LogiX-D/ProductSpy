import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Product } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockAIProvider } from '../../../../lib/ai/mock-provider';
import { getProductRepository } from '../../../../lib/server/product-repository';
import { webHeaders } from '../../../../lib/server/test-auth';
import { PATCH } from './route';

describe('manual analysis PATCH', () => {
  let directory: string;
  let product: Product;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-edit-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    product = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Bottle',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    product = await getProductRepository().saveAnalysis(
      product.id,
      await new MockAIProvider().analyze(product),
      product.updatedAt,
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function request(body: unknown) {
    return new Request(`http://127.0.0.1:3000/api/products/${encodeURIComponent(product.id)}`, {
      method: 'PATCH',
      headers: webHeaders('http://127.0.0.1:3000'),
      body: JSON.stringify(body),
    });
  }
  it('archives edits and rejects stale updates without truncating history', async () => {
    const analysis = { ...product.aiAnalysis!, summary: 'Manual multiline\nHuman conclusion' };
    const body = { analysis, expectedUpdatedAt: product.updatedAt };
    const context = { params: Promise.resolve({ id: product.id }) };
    const response = await PATCH(request(body), context);
    expect(response.status).toBe(200);
    const updated = (await response.json()) as { data: Product };
    expect(updated.data.analysisHistory).toHaveLength(2);
    expect(updated.data.analysisHistory?.at(-1)?.kind).toBe('edited');
    expect(updated.data.aiAnalysis?.summary).toBe(analysis.summary);
    expect((await PATCH(request(body), context)).status).toBe(409);
    expect(await getProductRepository().get(product.id)).toEqual(updated.data);
  });
});
