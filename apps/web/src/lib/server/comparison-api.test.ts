import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  type ComparisonGenerationResponse,
  type ComparisonPlan,
} from '@productspy/shared';
import * as ai from '../ai';
import { mockComparison } from '../ai/comparison-mock';
import { POST as session } from '../../app/api/session/route';
import { GET as list, POST as create } from '../../app/api/comparisons/route';
import { PATCH as update, DELETE as remove } from '../../app/api/comparisons/[id]/route';
import { POST as analyze } from '../../app/api/analyze-comparison/route';
import { GET as backup, POST as importBackup } from '../../app/api/comparisons/backup/route';
import { getProductRepository } from './product-repository';
import { getComparisonRepository } from './comparison-repository';
import { getAnalysisUsageLedger } from './analysis-usage';
const origin = 'http://127.0.0.1:3000';
let cookie = '';
function request(
  path: string,
  body?: unknown,
  method = 'POST',
  overrides: Record<string, string> = {},
): Request {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      origin,
      cookie,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-productspy-client': 'web',
      ...overrides,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function newPlan(): Promise<ComparisonPlan> {
  const products = await getProductRepository().list();
  const response = await create(
    request('comparisons', { name: 'Plan', productIds: products.map((p) => p.id) }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ComparisonPlan }).data;
}
describe('web-only comparison API, explicit authorization and request reservations', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-comparison-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    vi.stubEnv('AI_MODE', 'mock');
    vi.stubEnv('AI_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cookie = '';
    const response = await session(request('session'));
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    for (const sourceId of ['B012345678', 'B012345679'])
      await getProductRepository().upsert({
        source: 'amazon',
        sourceId,
        url: `https://www.amazon.com/dp/${sourceId}`,
        title: sourceId,
        images: [],
        videos: [],
        bulletPoints: ['Seller claim'],
      });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  it('denies anonymous, extension and cross-origin management', async () => {
    expect((await list(request('comparisons', undefined, 'GET', { cookie: '' }))).status).toBe(401);
    expect(
      (
        await create(
          request('comparisons', {}, 'POST', {
            origin: `chrome-extension://${'a'.repeat(32)}`,
            'x-productspy-client': 'extension',
            'sec-fetch-site': 'none',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await create(request('comparisons', {}, 'POST', { origin: 'https://example.com' }))).status,
    ).toBe(403);
  });
  it('persists Mock analysis and replays a lost response before version conflicts', async () => {
    const plan = await newPlan();
    const original = await readFile(join(directory, 'products.json'), 'utf8');
    const body = {
      comparisonId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: DEFAULT_ANALYSIS_OPTIONS,
      requestId: randomUUID(),
    };
    const first = await analyze(request('analyze-comparison', body));
    expect(first.status).toBe(200);
    const firstData = ((await first.json()) as { data: ComparisonGenerationResponse }).data;
    expect(firstData.plan.analysisHistory).toHaveLength(1);
    const second = await analyze(request('analyze-comparison', body));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: ComparisonGenerationResponse }).data.replayed).toBe(
      true,
    );
    expect((await getAnalysisUsageLedger().report()).records).toHaveLength(1);
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(original);
    expect(
      (
        await analyze(
          request('analyze-comparison', {
            ...body,
            options: { ...DEFAULT_ANALYSIS_OPTIONS, language: 'en' },
          }),
        )
      ).status,
    ).toBe(409);
  });
  it('requires per-request real authorization before creating provider or calling fetch', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-not-real');
    const factory = vi.spyOn(ai, 'createAIProvider');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await analyze(
      request('analyze-comparison', {
        comparisonId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        requestId: randomUUID(),
      }),
    );
    expect(response.status).toBe(428);
    expect(factory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getAnalysisUsageLedger().report()).records).toHaveLength(0);
  });
  it('reserves an authorized Stub once and refuses retry after unknown failure', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-not-real');
    const compare = vi.fn().mockRejectedValue(new Error('Stub network failure'));
    vi.spyOn(ai, 'createAIProvider').mockReturnValue({ analyze: vi.fn(), compare });
    const body = {
      comparisonId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      requestId: randomUUID(),
      authorizeReal: true,
    };
    expect((await analyze(request('analyze-comparison', body))).status).toBe(500);
    expect((await analyze(request('analyze-comparison', body))).status).toBe(409);
    expect(compare).toHaveBeenCalledTimes(1);
    expect((await getAnalysisUsageLedger().report()).records[0]?.status).toBe('failed');
  });
  it('records shared-ledger limits and rejects a second paid Stub at the daily ceiling', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-not-real');
    vi.stubEnv('AI_DAILY_REQUEST_LIMIT', '1');
    const compare = vi.fn().mockResolvedValue(mockComparison(plan.products));
    vi.spyOn(ai, 'createAIProvider').mockReturnValue({ analyze: vi.fn(), compare });
    const response = await analyze(
      request('analyze-comparison', {
        comparisonId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        requestId: randomUUID(),
        authorizeReal: true,
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      }),
    );
    expect(response.status).toBe(200);
    const saved = ((await response.json()) as { data: ComparisonGenerationResponse }).data.plan;
    expect(saved.analysisMetadata?.usage?.costEstimated).toBe(true);
    expect(
      (
        await analyze(
          request('analyze-comparison', {
            comparisonId: plan.id,
            expectedUpdatedAt: saved.updatedAt,
            requestId: randomUUID(),
            authorizeReal: true,
          }),
        )
      ).status,
    ).toBe(429);
    expect(compare).toHaveBeenCalledTimes(1);
  });
  it('edits/restores append history and delete requires confirmation', async () => {
    const plan = await newPlan();
    const context = { params: Promise.resolve({ id: plan.id }) };
    const generated = await analyze(
      request('analyze-comparison', { comparisonId: plan.id, expectedUpdatedAt: plan.updatedAt }),
    );
    const saved = ((await generated.json()) as { data: ComparisonGenerationResponse }).data.plan;
    const editedResponse = await update(
      request(
        `comparisons/${plan.id}`,
        {
          expectedUpdatedAt: saved.updatedAt,
          analysis: { ...saved.analysis, risks: ['Manual risk'] },
        },
        'PATCH',
      ),
      context,
    );
    expect(editedResponse.status).toBe(200);
    const edited = ((await editedResponse.json()) as { data: ComparisonPlan }).data;
    const restoredResponse = await update(
      request(
        `comparisons/${plan.id}`,
        { expectedUpdatedAt: edited.updatedAt, restoreVersionId: saved.analysisHistory?.[0]?.id },
        'PATCH',
      ),
      context,
    );
    expect(restoredResponse.status).toBe(200);
    const restored = ((await restoredResponse.json()) as { data: ComparisonPlan }).data;
    expect(restored.analysisHistory).toHaveLength(3);
    expect(
      (
        await remove(
          request(`comparisons/${plan.id}`, { expectedUpdatedAt: restored.updatedAt }, 'DELETE'),
          context,
        )
      ).status,
    ).toBe(400);
    expect((await getComparisonRepository().get(plan.id))?.analysisHistory).toHaveLength(3);
  });
  it('backs up full snapshots and preserves duplicate IDs during preview/commit', async () => {
    const plan = await newPlan();
    const response = await backup(request('comparisons/backup', undefined, 'GET'));
    const file = ((await response.json()) as { data: unknown }).data;
    const preview = await importBackup(
      request('comparisons/backup', { backup: file, commit: false }),
    );
    expect(preview.status).toBe(200);
    const previewData = ((await preview.json()) as { data: { revision: string; skipped: number } })
      .data;
    expect(previewData.skipped).toBe(1);
    const committed = await importBackup(
      request('comparisons/backup', {
        backup: file,
        commit: true,
        expectedRevision: previewData.revision,
        policy: 'preserve',
      }),
    );
    expect(committed.status).toBe(200);
    expect((await getComparisonRepository().get(plan.id))?.products).toEqual(plan.products);
  });
});
