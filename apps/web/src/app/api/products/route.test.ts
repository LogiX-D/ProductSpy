import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiResult, Product, ProductAnalysis, ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { DELETE, GET as getProduct, PATCH } from './[id]/route';
import { webHeaders } from '../../../lib/server/test-auth';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Travel bottle',
  price: '$25',
  images: [],
  videos: [],
  bulletPoints: ['Reusable bottle'],
};
const analysis: ProductAnalysis = {
  summary: 'A reusable bottle.',
  sellingPoints: ['Reusable'],
  targetAudience: ['Travelers'],
  purchaseMotivations: ['Convenience'],
  painPoints: ['Disposable waste'],
  strengths: ['Portable'],
  weaknesses: ['Capacity not verified'],
  marketingAngles: ['Commuting'],
  hooks: ['1', '2', '3', '4', '5'],
  shortVideoScript: 'Hook: Start\nProblem: Waste\nSolution: Reuse\nDemo: Fill\nCTA: Explore',
  imagePrompts: ['A bottle on a desk'],
  videoPrompts: ['Show filling a bottle'],
};
function apiRequest(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost:3000/api/products${path}`, {
    method,
    headers: webHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe('products API bridge', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('captures, lists, opens, saves analysis, rejects stale updates, and deletes a product', async () => {
    const capture = await POST(apiRequest('', 'POST', draft));
    expect(capture.status).toBe(200);
    const captureBody = (await capture.json()) as ApiResult<Product>;
    expect(captureBody.ok).toBe(true);
    if (!captureBody.ok) throw new Error('Capture failed');
    const product = captureBody.data;
    const context = { params: Promise.resolve({ id: product.id }) };
    expect(await (await GET(apiRequest(''))).json()).toEqual({ ok: true, data: [product] });
    expect(await (await getProduct(apiRequest(`/${product.id}`), context)).json()).toEqual({
      ok: true,
      data: product,
    });
    const analyzed = await PATCH(
      apiRequest(`/${product.id}`, 'PATCH', { analysis, expectedUpdatedAt: product.updatedAt }),
      context,
    );
    expect(analyzed.status).toBe(200);
    const analyzedBody = (await analyzed.json()) as ApiResult<Product>;
    expect(analyzedBody.ok && analyzedBody.data.aiAnalysis).toEqual(analysis);
    const stale = await PATCH(
      apiRequest(`/${product.id}`, 'PATCH', { analysis, expectedUpdatedAt: product.updatedAt }),
      context,
    );
    expect(stale.status).toBe(409);
    expect(await (await DELETE(apiRequest(`/${product.id}`, 'DELETE'), context)).json()).toEqual({
      ok: true,
      data: null,
    });
    expect((await getProduct(apiRequest(`/${product.id}`), context)).status).toBe(404);
    expect(await (await GET(apiRequest(''))).json()).toEqual({ ok: true, data: [] });
  });

  it('validates capture and PATCH input without writing bad data', async () => {
    expect((await POST(apiRequest('', 'POST', { ...draft, sourceId: 'invalid' }))).status).toBe(
      400,
    );
    expect(await (await GET(apiRequest(''))).json()).toEqual({ ok: true, data: [] });
    const context = { params: Promise.resolve({ id: 'missing' }) };
    expect(
      (
        await PATCH(
          apiRequest('/missing', 'PATCH', { analysis: { summary: 'Incomplete' } }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await PATCH(
          apiRequest('/missing', 'PATCH', { analysis, expectedUpdatedAt: 'bad-date' }),
          context,
        )
      ).status,
    ).toBe(400);
  });

  it('rejects unauthorized browser writes before they can affect the library', async () => {
    const maliciousRequest = new Request('http://localhost:3000/api/products', {
      method: 'POST',
      headers: {
        origin: 'https://evil.example',
        'content-type': 'application/json',
        'x-productspy-client': 'web',
      },
      body: JSON.stringify(draft),
    });
    const denied = await POST(maliciousRequest);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    expect(await (await GET(apiRequest(''))).json()).toEqual({ ok: true, data: [] });
  });
});
