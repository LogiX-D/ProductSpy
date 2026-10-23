import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinTemplates,
  contentOptionsSchema,
  currentContentVersion,
  templateDefinition,
  type ContentPlan,
  type ContentGenerationResponse,
} from '@productspy/shared';
import * as ai from '../ai/channels';
import { mockContent } from '../ai/content-generation';
import { POST as session } from '../../app/api/session/route';
import { GET as list, POST as create } from '../../app/api/content-plans/route';
import {
  GET as get,
  PATCH as update,
  DELETE as remove,
} from '../../app/api/content-plans/[id]/route';
import { GET as backup, POST as importBackup } from '../../app/api/content-plans/backup/route';
import { POST as generate } from '../../app/api/generate-content/route';
import { getProductRepository } from './product-repository';
import { getContentRepository } from './content-repository';
import { getAnalysisUsageLedger } from './analysis-usage';
import { getTemplateRepository } from './template-repository';
const origin = 'http://127.0.0.1:3000';
let cookie = '';
function request(
  path: string,
  body?: unknown,
  method = 'POST',
  headers: Record<string, string> = {},
): Request {
  return new Request(`${origin}/api/${path}`, {
    method,
    headers: {
      origin,
      cookie,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      'x-productspy-client': 'web',
      ...headers,
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
}
async function newPlan(): Promise<ContentPlan> {
  const product = (await getProductRepository().list())[0]!;
  const response = await create(
    request('content-plans', {
      name: 'Campaign',
      productId: product.id,
      templateId: builtinTemplates[0]!.id,
      options: contentOptionsSchema.parse({ duration: 45 }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: ContentPlan }).data;
}
const context = (id: string) => ({ params: Promise.resolve({ id }) });
describe('content API, explicit cost consent and protected generation history', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-content-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    vi.stubEnv('AI_MODE', 'mock');
    vi.stubEnv('AI_API_KEY', '');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cookie = '';
    const response = await session(request('session'));
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Bottle',
      images: [],
      videos: [],
      bulletPoints: ['Merchant page-listed material'],
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  it('denies anonymous, extension and cross-origin content management', async () => {
    expect((await list(request('content-plans', undefined, 'GET', { cookie: '' }))).status).toBe(
      401,
    );
    expect(
      (
        await create(
          request('content-plans', {}, 'POST', {
            origin: `chrome-extension://${'a'.repeat(32)}`,
            'x-productspy-client': 'extension',
            'sec-fetch-site': 'none',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await create(request('content-plans', {}, 'POST', { origin: 'https://example.com' })))
        .status,
    ).toBe(403);
  });
  it('saves Mock content once and replays a lost response before version conflicts', async () => {
    const plan = await newPlan(),
      original = await readFile(join(directory, 'products.json'), 'utf8');
    const body = {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      requestId: randomUUID(),
    };
    const first = await generate(request('generate-content', body));
    expect(first.status).toBe(200);
    const firstData = ((await first.json()) as { data: ContentGenerationResponse }).data;
    expect(firstData.plan.versions).toHaveLength(1);
    expect(firstData.version.metadata?.options.duration).toBe(45);
    const second = await generate(request('generate-content', body));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: ContentGenerationResponse }).data.replayed).toBe(true);
    expect((await getAnalysisUsageLedger().report()).records).toHaveLength(1);
    expect((await getAnalysisUsageLedger().report()).records[0]?.contentOptions?.duration).toBe(45);
    expect((await getAnalysisUsageLedger().report()).records[0]?.options).toBeUndefined();
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(original);
    expect(
      (
        await generate(
          request('generate-content', { ...body, options: { ...plan.options, language: 'en' } }),
        )
      ).status,
    ).toBe(409);
  });
  it('requires authorization before constructing provider or making any real request', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-key-not-real');
    const factory = vi.spyOn(ai, 'createAIProviderForExecution'),
      fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      (
        await generate(
          request('generate-content', {
            planId: plan.id,
            expectedUpdatedAt: plan.updatedAt,
            requestId: randomUUID(),
          }),
        )
      ).status,
    ).toBe(428);
    expect(factory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getAnalysisUsageLedger().report()).records).toHaveLength(0);
  });
  it('generates only the first explicitly selected content fields and records their scope', async () => {
    const plan = await newPlan();
    const response = await generate(
      request('generate-content', {
        planId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        options: plan.options,
        selectedFields: ['hooks'],
        requestId: randomUUID(),
      }),
    );
    expect(response.status).toBe(200);
    const data = ((await response.json()) as { data: ContentGenerationResponse }).data;
    expect(data.plan.currentVersionId).toBe(data.version.id);
    expect(data.version.output.hooks[0]).not.toContain('未选择');
    expect(data.version.output.sellingCopy).toEqual(['未选择此内容，未生成']);
    expect(data.version.output.shortVideoScript[0]).toBe('Hook: 未选择此内容，未生成');
    expect(data.version.metadata?.selectedFields).toEqual(['hooks']);
    expect((await getAnalysisUsageLedger().report()).records[0]?.contentFields).toEqual(['hooks']);
  });
  it('reserves an authorized Stub once and forbids retries after unknown billing failure', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-key-not-real');
    const createContent = vi.fn().mockRejectedValue(new Error('Stub network failure'));
    vi.spyOn(ai, 'createAIProviderForExecution').mockResolvedValue({
      analyze: vi.fn(),
      createContent,
    });
    const body = {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      requestId: randomUUID(),
      authorizeReal: true,
    };
    expect((await generate(request('generate-content', body))).status).toBe(500);
    expect((await generate(request('generate-content', body))).status).toBe(409);
    expect(createContent).toHaveBeenCalledTimes(1);
    expect((await getAnalysisUsageLedger().report()).records[0]?.status).toBe('failed');
    expect((await getContentRepository().get(plan.id))?.versions).toHaveLength(0);
  });
  it('saves authenticated Stub usage with real tokens, configured price and rebuilt evidence', async () => {
    const plan = await newPlan();
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-key-not-real');
    const result = mockContent(plan);
    result.usage = { inputTokens: 100, outputTokens: 200 };
    result.evidence.facts = ['Invented sales'];
    vi.spyOn(ai, 'createAIProviderForExecution').mockResolvedValue({
      analyze: vi.fn(),
      createContent: vi.fn().mockResolvedValue(result),
    });
    const response = await generate(
      request('generate-content', {
        planId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        options: {
          ...plan.options,
          customPrompt: 'Private prompt',
          creativeDirection: 'Private creative',
        },
        requestId: randomUUID(),
        authorizeReal: true,
        pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
      }),
    );
    expect(response.status).toBe(200);
    const data = ((await response.json()) as { data: ContentGenerationResponse }).data;
    expect(data.version.metadata?.usage?.costUsd).toBeCloseTo(0.001);
    expect(data.version.metadata?.evidence.facts.join(' ')).not.toContain('Invented');
    const record = (await getAnalysisUsageLedger().report()).records[0];
    expect(record?.contentOptions?.customPrompt).toBe('');
    expect(record?.contentOptions?.creativeDirection).toBe('');
    expect(data.version.metadata?.options.customPrompt).toBe('Private prompt');
  });
  it('supports manual edits, candidate regeneration, explicit adoption and restore', async () => {
    const initial = await newPlan();
    const response = await generate(
      request('generate-content', {
        planId: initial.id,
        expectedUpdatedAt: initial.updatedAt,
        options: initial.options,
      }),
    );
    const first = ((await response.json()) as { data: ContentGenerationResponse }).data;
    const editedResponse = await update(
      request(
        `content-plans/${initial.id}`,
        {
          expectedUpdatedAt: first.plan.updatedAt,
          output: { ...first.version.output, sellingCopy: ['Human rewrite'] },
        },
        'PATCH',
      ),
      context(initial.id),
    );
    const edited = ((await editedResponse.json()) as { data: ContentPlan }).data;
    const regenerated = await generate(
      request('generate-content', {
        planId: initial.id,
        expectedUpdatedAt: edited.updatedAt,
        options: initial.options,
        selectedFields: ['hooks'],
      }),
    );
    const candidate = ((await regenerated.json()) as { data: ContentGenerationResponse }).data;
    expect(candidate.plan.currentVersionId).toBe(edited.currentVersionId);
    expect(candidate.version.output.sellingCopy).toEqual(['Human rewrite']);
    const adoptedResponse = await update(
      request(
        `content-plans/${initial.id}`,
        { expectedUpdatedAt: candidate.plan.updatedAt, adoptVersionId: candidate.version.id },
        'PATCH',
      ),
      context(initial.id),
    );
    const adopted = ((await adoptedResponse.json()) as { data: ContentPlan }).data;
    const restoredResponse = await update(
      request(
        `content-plans/${initial.id}`,
        { expectedUpdatedAt: adopted.updatedAt, restoreVersionId: first.version.id },
        'PATCH',
      ),
      context(initial.id),
    );
    const restored = ((await restoredResponse.json()) as { data: ContentPlan }).data;
    expect(restored.versions).toHaveLength(4);
    expect(currentContentVersion(restored)?.output).toEqual(first.version.output);
    expect(
      (await get(request(`content-plans/${initial.id}`, undefined, 'GET'), context(initial.id)))
        .status,
    ).toBe(200);
  });
  it('exports an importable strict backup and preserves conflict history', async () => {
    const plan = await newPlan();
    const exportedResponse = await backup(request('content-plans/backup', undefined, 'GET'));
    const exported = ((await exportedResponse.json()) as { data: unknown }).data;
    const previewResponse = await importBackup(
      request('content-plans/backup', { backup: exported }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = (
      (await previewResponse.json()) as { data: { revision: string; conflicts: unknown[] } }
    ).data;
    expect(preview.conflicts).toHaveLength(1);
    const commitResponse = await importBackup(
      request('content-plans/backup', {
        backup: exported,
        commit: true,
        expectedRevision: preview.revision,
        policy: 'preserve',
      }),
    );
    expect(commitResponse.status).toBe(200);
    expect(await getContentRepository().get(plan.id)).toEqual(plan);
  });
  it('rejects invalid imports, missing sources and unconfirmed deletion', async () => {
    expect(
      (await importBackup(request('content-plans/backup', { backup: { format: 'unknown' } })))
        .status,
    ).toBe(400);
    expect(
      (
        await create(
          request('content-plans', {
            name: 'Missing',
            productId: 'no-product',
            templateId: builtinTemplates[0]!.id,
          }),
        )
      ).status,
    ).toBe(404);
    const plan = await newPlan();
    expect(
      (
        await remove(
          request(`content-plans/${plan.id}`, { expectedUpdatedAt: plan.updatedAt }, 'DELETE'),
          context(plan.id),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await remove(
          request(
            `content-plans/${plan.id}`,
            { expectedUpdatedAt: plan.updatedAt, confirmed: true },
            'DELETE',
          ),
          context(plan.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (await get(request(`content-plans/${plan.id}`, undefined, 'GET'), context(plan.id))).status,
    ).toBe(404);
    expect(await getProductRepository().list()).toHaveLength(1);
  });
  it('validates expanded prompts before reserving or calling an authorized real Stub', async () => {
    const product = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Bottle',
      images: [],
      videos: [],
      bulletPoints: [],
      description: 'x'.repeat(50000),
    });
    const template = await getTemplateRepository().create({
      ...templateDefinition(builtinTemplates[0]!),
      name: 'Repeated expansion',
      prompt: '{{description}} '.repeat(100),
    });
    const created = await create(
      request('content-plans', {
        name: 'Large intent',
        productId: product.id,
        templateId: template.id,
      }),
    );
    expect(created.status).toBe(200);
    const plan = ((await created.json()) as { data: ContentPlan }).data;
    vi.stubEnv('AI_MODE', 'real');
    vi.stubEnv('AI_API_KEY', 'stub-key-not-real');
    const factory = vi.spyOn(ai, 'createAIProviderForExecution'),
      fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await generate(
      request('generate-content', {
        planId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        requestId: randomUUID(),
        authorizeReal: true,
      }),
    );
    expect([400, 413]).toContain(response.status);
    expect(factory).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect((await getAnalysisUsageLedger().report()).records).toHaveLength(0);
  });
});
