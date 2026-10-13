import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTENT_OPTIONS,
  builtinTemplates,
  contentPlanSchema,
  estimateContentDuration,
  mergeProduct,
  type ContentPlan,
} from '@productspy/shared';
import { mockContent } from '../ai/content-generation';
import { LocalContentRepository } from './content-repository';

function fixture(): ContentPlan {
  const products = ['B012345678', 'B012345679'].map((asin) =>
    mergeProduct({
      source: 'amazon',
      sourceId: asin,
      title: `Fixture ${asin}`,
      url: `https://www.amazon.com/dp/${asin}`,
      images: [],
      videos: [],
      bulletPoints: ['Page claim, unverified'],
    }),
  );
  const time = new Date().toISOString();
  return {
    id: randomUUID(),
    name: 'Synthetic security fixture',
    productId: products[0]!.id,
    productSnapshot: structuredClone(products[0]!),
    templateSnapshot: builtinTemplates[0]!,
    options: DEFAULT_CONTENT_OPTIONS,
    status: 'draft',
    favorite: false,
    createdAt: time,
    updatedAt: time,
    versions: [],
    comparisonSource: {
      id: randomUUID(),
      name: 'Saved source fixture',
      products,
      createdAt: time,
      updatedAt: time,
      analysis: {
        coreDifferences: ['Fixture difference'],
        verifiableSellingPoints: ['Merchant claim'],
        audienceDifferences: ['Hypothesis'],
        opportunities: ['Hypothesis'],
        contentAngles: ['Hypothesis'],
        videoRecommendations: ['Verify before filming'],
        risks: ['No actual reviews'],
      },
    },
  };
}
function backup(plan: ContentPlan) {
  return {
    format: 'productspy-content',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    plans: [plan],
  };
}
describe('independent content import and provenance security review', () => {
  let directory: string;
  let repository: LocalContentRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-content-security-'));
    repository = new LocalContentRepository(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('validates a separate comparison snapshot even when its ID duplicates the selected product ID', async () => {
    const plan = fixture();
    plan.comparisonSource!.products[0]!.url = 'https://evil.example/dp/B012345678';
    await expect(repository.importBackup(backup(plan), {})).rejects.toMatchObject({ status: 400 });
    await expect(readFile(repository.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('does not omit private media addresses in a duplicate-ID source snapshot', async () => {
    const plan = fixture();
    plan.comparisonSource!.products[0]!.images = ['http://127.0.0.1/secret.png'];
    await expect(repository.importBackup(backup(plan), {})).rejects.toMatchObject({ status: 400 });
  });
  it('rejects comparison membership with a copied product ID and different ASIN', async () => {
    const plan = fixture();
    const source = plan.comparisonSource!.products[0]!;
    source.sourceId = 'B012345680';
    source.url = 'https://www.amazon.com/dp/B012345680';
    expect(contentPlanSchema.safeParse(plan).success).toBe(false);
    await expect(repository.importBackup(backup(plan), {})).rejects.toMatchObject({ status: 400 });
  });
  it('rejects generation metadata that cites a different template, source timestamp or unknown version', () => {
    const plan = fixture();
    const generated = mockContent(plan);
    const id = randomUUID();
    const metadata = {
      mode: 'mock' as const,
      options: plan.options,
      generatedAt: plan.updatedAt,
      sourceUpdatedAt: plan.productSnapshot.updatedAt,
      templateId: plan.templateSnapshot.id,
      templateVersionId: plan.templateSnapshot.versions.at(-1)!.id,
      evidence: generated.evidence,
      textDurationEstimate: estimateContentDuration(generated.output, plan.options),
    };
    plan.versions = [
      { id, createdAt: plan.updatedAt, kind: 'generated', output: generated.output, metadata },
    ];
    plan.currentVersionId = id;
    expect(contentPlanSchema.safeParse(plan).success).toBe(true);
    for (const invalidMetadata of [
      { ...metadata, templateId: randomUUID() },
      { ...metadata, templateVersionId: randomUUID() },
      { ...metadata, sourceUpdatedAt: '2000-01-01T00:00:00.000Z' },
    ])
      expect(
        contentPlanSchema.safeParse({
          ...plan,
          versions: [{ ...plan.versions[0], metadata: invalidMetadata }],
        }).success,
      ).toBe(false);
  });
  it('rejects parent or restore history references outside the retained content history', () => {
    const plan = fixture();
    const generated = mockContent(plan);
    const id = randomUUID();
    plan.versions = [{ id, createdAt: plan.updatedAt, kind: 'edited', output: generated.output }];
    plan.currentVersionId = id;
    expect(
      contentPlanSchema.safeParse({
        ...plan,
        versions: [{ ...plan.versions[0], parentVersionId: randomUUID() }],
      }).success,
    ).toBe(false);
    expect(
      contentPlanSchema.safeParse({
        ...plan,
        versions: [{ ...plan.versions[0], kind: 'restored', restoredFrom: randomUUID() }],
      }).success,
    ).toBe(false);
  });
});
