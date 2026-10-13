import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ANALYSIS_OPTIONS, mergeProduct } from '@productspy/shared';
import { mockComparison } from '../ai/comparison-mock';
import { LocalComparisonRepository } from './comparison-repository';

const products = ['B012345678', 'B012345679', 'B012345680'].map((sourceId) =>
  mergeProduct({
    source: 'amazon',
    sourceId,
    url: `https://www.amazon.com/dp/${sourceId}`,
    title: `Bottle ${sourceId}`,
    price: '$25',
    currency: 'USD',
    images: [],
    videos: [],
    bulletPoints: ['Page-listed steel'],
    groupIds: undefined,
  } as Parameters<typeof mergeProduct>[0]),
);
describe('separate atomic comparison repository', () => {
  let directory: string;
  let repository: LocalComparisonRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-comparison-'));
    repository = new LocalComparisonRepository(directory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  it('creates and reloads independent snapshots without writing source products', async () => {
    const original = JSON.stringify(products);
    const plan = await repository.create('Plan', products.slice(0, 2));
    expect(await new LocalComparisonRepository(directory).get(plan.id)).toEqual(plan);
    expect(JSON.stringify(products)).toBe(original);
    await expect(readFile(join(directory, 'products.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('serializes writes across repository instances and retains all plans', async () => {
    const second = new LocalComparisonRepository(directory);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? second : repository).create(`Plan ${index}`, products.slice(0, 2)),
      ),
    );
    expect(await repository.list()).toHaveLength(8);
  });
  it('retains snapshots after source deletion/update until explicit refresh', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const live = [
      { ...products[0]!, price: '$99', updatedAt: new Date(Date.now() + 10).toISOString() },
    ];
    const renamed = await repository.update(
      plan.id,
      {
        expectedUpdatedAt: plan.updatedAt,
        name: 'Renamed',
        productIds: plan.products.map((p) => p.id),
      },
      live,
    );
    expect(renamed.products[0]?.price).toBe('$25');
    const refreshed = await repository.update(
      plan.id,
      { expectedUpdatedAt: renamed.updatedAt, refreshSnapshots: true },
      live,
    );
    expect(refreshed.products[0]?.price).toBe('$99');
    expect(refreshed.products[1]).toEqual(products[1]);
  });
  it('adds new snapshots while keeping old snapshots and rejects stale writes', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const joined = await repository.update(
      plan.id,
      { expectedUpdatedAt: plan.updatedAt, productIds: products.map((p) => p.id) },
      products,
    );
    expect(joined.products).toHaveLength(3);
    await expect(
      repository.update(plan.id, { expectedUpdatedAt: plan.updatedAt, name: 'stale' }, products),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repository.get(plan.id))?.name).toBe('Plan');
  });
  it('preserves generated/manual/restored versions and their options', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const generated = mockComparison(plan.products);
    const first = await repository.saveAnalysis(plan.id, generated.analysis, plan.updatedAt, {
      kind: 'generated',
      metadata: {
        mode: 'mock',
        options: DEFAULT_ANALYSIS_OPTIONS,
        generatedAt: plan.updatedAt,
        sourceUpdatedAt: plan.updatedAt,
        evidence: generated.evidence,
      },
    });
    const edited = await repository.saveAnalysis(
      plan.id,
      { ...generated.analysis, opportunities: ['Manual opportunity'] },
      first.updatedAt,
    );
    expect(edited.analysisHistory?.[0]?.analysis).toEqual(generated.analysis);
    const restored = await repository.restoreAnalysis(
      plan.id,
      first.analysisHistory![0]!.id,
      edited.updatedAt,
    );
    expect(restored.analysisHistory).toHaveLength(3);
    expect(restored.analysisHistory?.[1]?.analysis.opportunities).toEqual(['Manual opportunity']);
    expect(restored.analysis).toEqual(generated.analysis);
    expect(restored.analysisMetadata?.options).toEqual(DEFAULT_ANALYSIS_OPTIONS);
  });
  it('previews and restores backups conservatively without overwriting manual content', async () => {
    const first = await repository.create('First', products.slice(0, 2));
    const second = await repository.create('Second', products.slice(1));
    const backup = await repository.backup();
    const { revision: _revision, ...data } = backup;
    await repository.delete(second.id, second.updatedAt, true);
    const renamed = await repository.update(
      first.id,
      { expectedUpdatedAt: first.updatedAt, name: 'Keep this edit' },
      products,
    );
    const preview = await repository.importBackup(data, {});
    expect(preview.conflicts).toEqual([{ id: first.id, name: 'First' }]);
    const imported = await repository.importBackup(data, {
      commit: true,
      expectedRevision: preview.revision,
    });
    expect(imported).toMatchObject({ imported: 1, skipped: 1 });
    expect((await repository.get(first.id))?.name).toBe(renamed.name);
    expect((await repository.get(second.id))?.products).toEqual(second.products);
  });
  it('requires backup revision, delete confirmation and protects corrupt files', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    await expect(repository.delete(plan.id, plan.updatedAt, false)).rejects.toMatchObject({
      status: 400,
    });
    const backup = await repository.backup();
    const data = {
      format: backup.format,
      schemaVersion: backup.schemaVersion,
      exportedAt: backup.exportedAt,
      plans: backup.plans,
    };
    await expect(
      repository.importBackup(data, { commit: true, expectedRevision: 'old' }),
    ).rejects.toMatchObject({ status: 409 });
    await writeFile(repository.filePath, '{broken');
    await expect(repository.list()).rejects.toMatchObject({ status: 500 });
    await expect(repository.create('Another', products.slice(0, 2))).rejects.toMatchObject({
      status: 500,
    });
    expect(await readFile(repository.filePath, 'utf8')).toBe('{broken');
  });
  it('rejects mismatched ASIN, unsafe URLs and malformed imports before any writes', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const backup = {
      format: 'productspy-comparisons',
      schemaVersion: 1,
      exportedAt: plan.updatedAt,
      plans: [
        {
          ...plan,
          products: [{ ...products[0], url: 'https://www.amazon.com/dp/B000000000' }, products[1]],
        },
      ],
    };
    await expect(repository.importBackup(backup, {})).rejects.toMatchObject({ status: 400 });
    backup.plans[0]!.products[0] = { ...products[0]!, images: ['http://127.0.0.1/secret'] };
    await expect(repository.importBackup(backup, {})).rejects.toMatchObject({ status: 400 });
    expect(await repository.list()).toEqual([plan]);
  });
  it('keeps snapshot freshness independent of renaming and analysis version writes', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const renamed = await repository.update(
      plan.id,
      { expectedUpdatedAt: plan.updatedAt, name: 'Renamed' },
      products,
    );
    expect(renamed.snapshotUpdatedAt).toBe(plan.snapshotUpdatedAt);
    const generated = mockComparison(plan.products);
    const saved = await repository.saveAnalysis(plan.id, generated.analysis, renamed.updatedAt, {
      metadata: {
        mode: 'mock',
        options: DEFAULT_ANALYSIS_OPTIONS,
        generatedAt: renamed.updatedAt,
        sourceUpdatedAt: renamed.snapshotUpdatedAt!,
        evidence: generated.evidence,
      },
    });
    expect(saved.analysisMetadata?.sourceUpdatedAt).toBe(saved.snapshotUpdatedAt);
    const refreshed = await repository.update(
      plan.id,
      { expectedUpdatedAt: saved.updatedAt, refreshSnapshots: true },
      [{ ...products[0]!, price: '$50' }, products[1]!],
    );
    expect(refreshed.snapshotUpdatedAt).toBe(refreshed.updatedAt);
    expect(refreshed.analysisMetadata?.sourceUpdatedAt).not.toBe(refreshed.snapshotUpdatedAt);
    expect(refreshed.analysisHistory).toEqual(saved.analysisHistory);
  });
  it('archives imported active content before a new manual version and preserves old backup compatibility', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const analysis = mockComparison(plan.products).analysis;
    const legacy = { ...plan, analysis, analysisHistory: undefined, snapshotUpdatedAt: undefined };
    await writeFile(repository.filePath, JSON.stringify({ schemaVersion: 1, plans: [legacy] }));
    const saved = await repository.saveAnalysis(
      plan.id,
      { ...analysis, risks: ['Manual revision'] },
      plan.updatedAt,
    );
    expect(saved.analysisHistory).toHaveLength(2);
    expect(saved.analysisHistory?.[0]?.analysis).toEqual(analysis);
    expect(saved.analysisHistory?.[1]?.analysis.risks).toEqual(['Manual revision']);
  });
  it('stops at the history cap before overwriting any analysis or requesting AI', async () => {
    const plan = await repository.create('Plan', products.slice(0, 2));
    const analysis = mockComparison(plan.products).analysis;
    const full = {
      ...plan,
      analysis,
      analysisHistory: Array.from({ length: 50 }, () => ({
        id: randomUUID(),
        createdAt: plan.updatedAt,
        kind: 'edited',
        analysis,
      })),
    };
    await writeFile(repository.filePath, JSON.stringify({ schemaVersion: 1, plans: [full] }));
    const before = await readFile(repository.filePath, 'utf8');
    await expect(repository.assertAnalysisCapacity(plan.id, plan.updatedAt)).rejects.toMatchObject({
      status: 409,
    });
    await expect(repository.saveAnalysis(plan.id, analysis, plan.updatedAt)).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });
});
