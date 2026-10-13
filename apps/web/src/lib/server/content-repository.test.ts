import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  builtinTemplates,
  contentOptionsSchema,
  estimateContentDuration,
  mergeProduct,
  currentContentVersion,
  type ContentMetadata,
  type ContentPlan,
} from '@productspy/shared';
import { mockContent } from '../ai/content-generation';
import { LocalContentRepository } from './content-repository';
const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Bottle',
  price: '$25',
  currency: 'USD',
  images: [],
  videos: [],
  bulletPoints: ['Page-listed steel'],
});
describe('atomic content storage with safe candidate and edit history', () => {
  let directory: string, repository: LocalContentRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-content-'));
    repository = new LocalContentRepository(directory);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });
  const newPlan = () =>
    repository.create(
      'Campaign',
      product,
      builtinTemplates[0]!,
      contentOptionsSchema.parse({ duration: 45 }),
    );
  async function generate(plan: ContentPlan, fields?: ['hooks']) {
    const result = mockContent(plan, plan.options, fields);
    const metadata: ContentMetadata = {
      mode: 'mock',
      options: plan.options,
      generatedAt: new Date().toISOString(),
      sourceUpdatedAt: product.updatedAt,
      templateId: plan.templateSnapshot.id,
      templateVersionId: plan.templateSnapshot.versions.at(-1)?.id,
      evidence: result.evidence,
      requestId: randomUUID(),
      textDurationEstimate: estimateContentDuration(result.output, plan.options),
    };
    return repository.saveGenerated(plan.id, result.output, plan.updatedAt, metadata, fields);
  }
  it('persists independent plans and original source snapshots across restart', async () => {
    const plan = await newPlan();
    expect(await new LocalContentRepository(directory).get(plan.id)).toEqual(plan);
    expect(plan.options.duration).toBe(45);
    await expect(readFile(join(directory, 'products.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('serializes concurrent writes from separate repository instances', async () => {
    const second = new LocalContentRepository(directory);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        (i % 2 ? repository : second).create(`Campaign ${i}`, product, builtinTemplates[0]!),
      ),
    );
    expect(await repository.list()).toHaveLength(8);
  });
  it('keeps edited current content during full and partial regeneration', async () => {
    const first = await generate(await newPlan());
    const original = first.version.output;
    const manual = await repository.update(first.plan.id, {
      expectedUpdatedAt: first.plan.updatedAt,
      output: {
        ...original,
        voiceover: ['My human edit '.repeat(30)],
        hooks: ['Human 1', 'Human 2', 'Human 3', 'Human 4', 'Human 5'],
      },
    });
    const candidate = await generate(manual, ['hooks']);
    expect(candidate.plan.currentVersionId).toBe(manual.currentVersionId);
    expect(currentContentVersion(candidate.plan)?.output.hooks[0]).toBe('Human 1');
    expect(candidate.version.output.voiceover).toEqual(
      currentContentVersion(manual)?.output.voiceover,
    );
    expect(candidate.version.metadata?.textDurationEstimate).toEqual(
      estimateContentDuration(candidate.version.output, manual.options),
    );
    const full = await generate(candidate.plan);
    expect(full.plan.currentVersionId).toBe(manual.currentVersionId);
    expect(full.plan.versions).toHaveLength(4);
    expect(currentContentVersion(full.plan)?.metadata?.textDurationEstimate).toEqual(
      estimateContentDuration(currentContentVersion(full.plan)!.output, manual.options),
    );
  });
  it('adopts candidates explicitly and restores without deleting edited versions', async () => {
    const first = await generate(await newPlan());
    const second = await generate(first.plan);
    const adopted = await repository.update(second.plan.id, {
      expectedUpdatedAt: second.plan.updatedAt,
      adoptVersionId: second.version.id,
    });
    expect(adopted.currentVersionId).toBe(second.version.id);
    expect(adopted.versions).toHaveLength(2);
    const restored = await repository.update(adopted.id, {
      expectedUpdatedAt: adopted.updatedAt,
      restoreVersionId: first.version.id,
    });
    expect(restored.versions).toHaveLength(3);
    expect(currentContentVersion(restored)?.restoredFrom).toBe(first.version.id);
    expect(currentContentVersion(restored)?.output).toEqual(first.version.output);
  });
  it('rejects stale updates, invalid version IDs and conflicting edit operations', async () => {
    const plan = await newPlan();
    const renamed = await repository.update(plan.id, {
      expectedUpdatedAt: plan.updatedAt,
      name: 'New',
    });
    await expect(
      repository.update(plan.id, { expectedUpdatedAt: plan.updatedAt, name: 'Old' }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      repository.update(plan.id, {
        expectedUpdatedAt: renamed.updatedAt,
        adoptVersionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repository.update(plan.id, {
        expectedUpdatedAt: renamed.updatedAt,
        restoreVersionId: randomUUID(),
        adoptVersionId: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await repository.get(plan.id))?.name).toBe('New');
  });
  it('protects corrupted content without overwriting original bytes', async () => {
    await writeFile(repository.filePath, '{broken', 'utf8');
    await expect(repository.list()).rejects.toMatchObject({ status: 500 });
    await expect(newPlan()).rejects.toMatchObject({ status: 500 });
    expect(await readFile(repository.filePath, 'utf8')).toBe('{broken');
  });
  it('previews import conflicts and preserves all existing analysis and versions', async () => {
    const saved = await generate(await newPlan());
    const exported = await repository.backup();
    const { revision: _revision, ...backup } = exported;
    const conflicting = { ...backup, plans: [{ ...saved.plan, name: 'Overwrite attempt' }] };
    const preview = await repository.importBackup(conflicting, {});
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.imported).toBe(0);
    const committed = await repository.importBackup(conflicting, {
      commit: true,
      expectedRevision: preview.revision,
    });
    expect(committed.skipped).toBe(1);
    expect(await repository.get(saved.plan.id)).toEqual(saved.plan);
    await expect(
      repository.importBackup(backup, { commit: true, expectedRevision: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('restores complete independent content into an empty data directory', async () => {
    const generated = await generate(await newPlan());
    const { revision: _revision, ...backup } = await repository.backup();
    const other = new LocalContentRepository(join(directory, 'restored'));
    const preview = await other.importBackup(backup, {});
    expect(
      (await other.importBackup(backup, { commit: true, expectedRevision: preview.revision }))
        .imported,
    ).toBe(1);
    expect(await other.get(generated.plan.id)).toEqual(generated.plan);
  });
  it('requires confirmation for deleting content and leaves source data intact', async () => {
    const plan = await newPlan();
    await expect(repository.delete(plan.id, plan.updatedAt, false)).rejects.toMatchObject({
      status: 400,
    });
    expect(await repository.get(plan.id)).toBeDefined();
    await repository.delete(plan.id, plan.updatedAt, true);
    expect(await repository.list()).toEqual([]);
  });
  it('refuses generation at the history limit without pruning any old version', async () => {
    const saved = await generate(await newPlan());
    const full: ContentPlan = {
      ...saved.plan,
      versions: Array.from({ length: 50 }, (_, index) => ({
        ...saved.version,
        id: index === 0 ? saved.version.id : randomUUID(),
        kind: 'edited',
      })),
    };
    await writeFile(
      repository.filePath,
      JSON.stringify({ schemaVersion: 1, plans: [full] }),
      'utf8',
    );
    const before = await readFile(repository.filePath, 'utf8');
    await expect(repository.assertCapacity(full.id, full.updatedAt)).rejects.toMatchObject({
      status: 409,
    });
    await expect(generate(full)).rejects.toMatchObject({ status: 409 });
    expect((await repository.get(full.id))?.versions).toHaveLength(50);
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });
});
