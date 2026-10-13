import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  builtinTemplates,
  contentOptionsSchema,
  contentPlanSchema,
  templateDefinition,
  DEFAULT_ANALYSIS_OPTIONS,
  type Product,
  type ContentPlan,
} from '@productspy/shared';
import { getProductRepository } from './product-repository';
import { getComparisonRepository } from './comparison-repository';
import { getTemplateRepository } from './template-repository';
import { getContentRepository } from './content-repository';
import { historySummary, exportHistoryArchive, cleanupArchivedHistory } from './history-management';
import { MockAIProvider } from '../ai/mock-provider';
import { mockComparison } from '../ai/comparison-mock';
import { mockContent } from '../ai/content-generation';
import * as atomic from './atomic-file';
import { GET, POST } from '../../app/api/history/route';
import { POST as archivePOST } from '../../app/api/history/archive/route';
import { webHeaders } from './test-auth';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
describe('history archives, protected cleanup and exact revision writes', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-history-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    vi.stubEnv('AI_MODE', 'mock');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  async function productWithHistory(count = 4): Promise<Product> {
    const repository = getProductRepository();
    let product = await repository.upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Test bottle',
      images: [],
      videos: [],
      bulletPoints: ['Merchant-listed steel'],
    });
    const analysis = await new MockAIProvider().analyze(product);
    for (let index = 0; index < count; index++)
      product = await repository.saveAnalysis(
        product.id,
        { ...analysis, summary: `Draft ${index}` },
        product.updatedAt,
        { kind: index % 2 ? 'edited' : 'generated' },
      );
    return product;
  }
  async function contentWithHistory(): Promise<ContentPlan> {
    const product = await productWithHistory(1);
    const repository = getContentRepository();
    let plan = await repository.create(
      'Content',
      product,
      builtinTemplates[0]!,
      contentOptionsSchema.parse({}),
    );
    const output = mockContent(plan, plan.options).output;
    for (let index = 0; index < 4; index++)
      plan = await repository.update(plan.id, {
        expectedUpdatedAt: plan.updatedAt,
        output: { ...output, voiceover: [`Manual ${index}`] },
      });
    return plan;
  }
  it('archives exact full snapshot and selected edits, preserving current on cleanup', async () => {
    const product = await productWithHistory();
    const versionIds = [product.analysisHistory![1]!.id];
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds,
    };
    const archive = await exportHistoryArchive(input);
    expect(archive.sha256).toBe(digest(archive.archive));
    expect(archive.archive).toMatchObject({ snapshot: product, selectedVersionIds: versionIds });
    const result = await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    const stored = await getProductRepository().get(product.id);
    expect(result.removed).toBe(1);
    expect(stored?.aiAnalysis).toEqual(product.aiAnalysis);
    expect(stored?.analysisHistory).toHaveLength(3);
    expect(stored?.analysisHistory?.[1]?.archivedParentSha256).toBe(archive.sha256);
    expect(stored?.analysisHistory?.at(-1)?.id).toBe(product.analysisHistory?.at(-1)?.id);
  });
  it('refuses current and first recovery nodes without modifying bytes', async () => {
    const product = await productWithHistory();
    const original = await readFile(join(directory, 'products.json'), 'utf8');
    for (const version of [product.analysisHistory![0]!, product.analysisHistory!.at(-1)!]) {
      const input = {
        kind: 'product' as const,
        id: product.id,
        expectedUpdatedAt: product.updatedAt,
        versionIds: [version.id],
      };
      const archive = await exportHistoryArchive(input);
      await expect(
        cleanupArchivedHistory({
          ...input,
          confirmed: true,
          archiveReceipt: archive.archiveReceipt,
        }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(original);
  });
  it('protects restored source versions and retains all saved restore references', async () => {
    let product = await productWithHistory();
    const sourceId = product.analysisHistory![1]!.id;
    product = await getProductRepository().restoreAnalysis(product.id, sourceId, product.updatedAt);
    expect(
      (await historySummary('product', product.id)).versions.find(
        (version) => version.id === sourceId,
      )?.protected,
    ).toBe(true);
    const otherId = product.analysisHistory![2]!.id;
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: [otherId],
    };
    const archive = await exportHistoryArchive(input);
    await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    expect(
      (await getProductRepository().get(product.id))?.analysisHistory?.at(-1)?.restoredFrom,
    ).toBe(sourceId);
  });
  it('rejects forged, reused, mismatched and stale receipts', async () => {
    const product = await productWithHistory();
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: [product.analysisHistory![1]!.id],
    };
    const archive = await exportHistoryArchive(input);
    await expect(
      cleanupArchivedHistory({
        ...input,
        confirmed: true,
        archiveReceipt: `${archive.archiveReceipt}x`,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      cleanupArchivedHistory({
        ...input,
        versionIds: [product.analysisHistory![2]!.id],
        confirmed: true,
        archiveReceipt: archive.archiveReceipt,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('expires archives without cleaning and blocks same timestamp content changes', async () => {
    const product = await productWithHistory();
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: [product.analysisHistory![1]!.id],
    };
    const archive = await exportHistoryArchive(input);
    const original = await readFile(join(directory, 'products.json'), 'utf8');
    const time = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(time + 31 * 60 * 1000);
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toMatchObject({ status: 409 });
    vi.restoreAllMocks();
    const changed = JSON.parse(original) as { products: Product[] };
    changed.products[0]!.title = 'Different bytes, same timestamp';
    await writeFile(join(directory, 'products.json'), JSON.stringify(changed));
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await getProductRepository().get(product.id))?.analysisHistory).toHaveLength(4);
  });
  it('cleans descriptive content lineage with archive provenance and valid schema', async () => {
    const plan = await contentWithHistory();
    const input = {
      kind: 'content' as const,
      id: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      versionIds: [plan.versions[1]!.id],
    };
    const archive = await exportHistoryArchive(input);
    await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    const stored = (await getContentRepository().get(plan.id))!;
    expect(contentPlanSchema.safeParse(stored).success).toBe(true);
    expect(stored.currentVersionId).toBe(plan.currentVersionId);
    expect(stored.versions[1]?.archivedParentVersionId).toBe(plan.versions[1]!.id);
    expect(stored.versions[1]?.archivedParentSha256).toBe(archive.sha256);
    expect(stored.versions.at(-1)?.output).toEqual(plan.versions.at(-1)?.output);
  });
  it('cleans template and comparison histories independently and preserves snapshots', async () => {
    const product = await productWithHistory(1);
    const templateRepository = getTemplateRepository();
    let template = await templateRepository.create({
      ...templateDefinition(builtinTemplates[0]!),
      name: 'History template',
    });
    for (let index = 0; index < 3; index++)
      template = await templateRepository.update(template.id, {
        expectedUpdatedAt: template.updatedAt,
        definition: { ...templateDefinition(template), name: `Name ${index}` },
      });
    const templateInput = {
      kind: 'template' as const,
      id: template.id,
      expectedUpdatedAt: template.updatedAt,
      versionIds: [template.versions[1]!.id],
    };
    const templateArchive = await exportHistoryArchive(templateInput);
    await cleanupArchivedHistory({
      ...templateInput,
      confirmed: true,
      archiveReceipt: templateArchive.archiveReceipt,
    });
    expect((await templateRepository.get(template.id))?.versions).toHaveLength(3);
    const second = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
      title: 'Other bottle',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    const repository = getComparisonRepository();
    let plan = await repository.create('Comparison', [product, second]);
    const result = mockComparison(plan.products, DEFAULT_ANALYSIS_OPTIONS);
    for (let index = 0; index < 4; index++)
      plan = await repository.saveAnalysis(
        plan.id,
        { ...result.analysis, coreDifferences: [`Diff ${index}`] },
        plan.updatedAt,
      );
    const input = {
      kind: 'comparison' as const,
      id: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      versionIds: [plan.analysisHistory![1]!.id],
    };
    const archive = await exportHistoryArchive(input);
    await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    expect((await repository.get(plan.id))?.products).toEqual(plan.products);
    expect((await repository.get(plan.id))?.analysis).toEqual(plan.analysis);
  });
  it('reopens full 50 version capacity only after explicit archival cleanup', async () => {
    const product = await productWithHistory(50);
    expect((await historySummary('product', product.id)).approachingLimit).toBe(true);
    await expect(
      getProductRepository().assertAnalysisCapacity(product.id, product.updatedAt),
    ).rejects.toMatchObject({ status: 409 });
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: product.analysisHistory!.slice(1, 11).map((version) => version.id),
    };
    const archive = await exportHistoryArchive(input);
    const cleared = await cleanupArchivedHistory({
      ...input,
      confirmed: true,
      archiveReceipt: archive.archiveReceipt,
    });
    const updated = await getProductRepository().saveAnalysis(
      product.id,
      product.aiAnalysis!,
      cleared.summary.updatedAt,
    );
    expect(updated.analysisHistory).toHaveLength(41);
    expect(updated.aiAnalysis).toEqual(product.aiAnalysis);
  });
  it('preserves original file after permanent atomic write failure and corrupt JSON', async () => {
    const product = await productWithHistory();
    const input = {
      kind: 'product' as const,
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: [product.analysisHistory![1]!.id],
    };
    const archive = await exportHistoryArchive(input);
    const original = await readFile(join(directory, 'products.json'), 'utf8');
    vi.spyOn(atomic, 'publishAtomicFile').mockRejectedValueOnce(new Error('Permanent EPERM'));
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toThrow('Permanent EPERM');
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(original);
    await writeFile(join(directory, 'products.json'), '{corrupt');
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe('{corrupt');
  });
  it('protects history API from anonymous, extension and unconfirmed cleanup requests', async () => {
    const product = await productWithHistory();
    const origin = 'http://localhost:3000',
      headers = webHeaders();
    const body = {
      kind: 'product',
      id: product.id,
      expectedUpdatedAt: product.updatedAt,
      versionIds: [product.analysisHistory![1]!.id],
    };
    const request = (
      path: string,
      method: string,
      payload?: unknown,
      replacement: Record<string, string> = {},
    ) =>
      new Request(`${origin}/api/${path}`, {
        method,
        headers: { ...headers, ...replacement },
        ...(method === 'GET' ? {} : { body: JSON.stringify(payload) }),
      });
    expect(
      (
        await GET(
          request(`history?kind=product&id=${product.id}`, 'GET', undefined, { cookie: '' }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await archivePOST(
          request('history/archive', 'POST', body, {
            origin: `chrome-extension://${'a'.repeat(32)}`,
            'x-productspy-client': 'extension',
            'sec-fetch-site': 'none',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request('history', 'POST', {
            ...body,
            confirmed: false,
            archiveReceipt: 'x'.repeat(100),
          }),
        )
      ).status,
    ).toBe(400);
    expect((await GET(request(`history?kind=product&id=${product.id}`, 'GET'))).status).toBe(200);
    expect((await archivePOST(request('history/archive', 'POST', body))).status).toBe(200);
  });
  it('does not permit built-in history cleanup', async () => {
    const template = builtinTemplates[0]!;
    const input = {
      kind: 'template' as const,
      id: template.id,
      expectedUpdatedAt: template.updatedAt,
      versionIds: [template.versions[0]!.id],
    };
    const archive = await exportHistoryArchive(input);
    await expect(
      cleanupArchivedHistory({ ...input, confirmed: true, archiveReceipt: archive.archiveReceipt }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(readFile(join(directory, 'templates.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
