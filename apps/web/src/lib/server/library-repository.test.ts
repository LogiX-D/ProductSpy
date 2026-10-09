import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type LibrarySnapshot, type ProductAnalysis, type ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonProductRepository } from './product-repository';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Synthetic bottle',
  images: [],
  videos: [],
  bulletPoints: ['Reusable'],
};
const analysis: ProductAnalysis = {
  summary: 'Original manual analysis',
  sellingPoints: ['Reusable'],
  targetAudience: ['Travelers'],
  purchaseMotivations: ['Convenience'],
  painPoints: ['Waste'],
  strengths: ['Portable'],
  weaknesses: ['Capacity unverified'],
  marketingAngles: ['Daily commute'],
  hooks: ['1', '2', '3', '4', '5'],
  shortVideoScript: 'Hook: Start\nProblem: Waste\nSolution: Reuse\nDemo: Fill\nCTA: Explore',
  imagePrompts: ['Bottle on a desk'],
  videoPrompts: ['Show filling a bottle'],
};

describe('atomic local library management', () => {
  let directory: string;
  let repository: LocalJsonProductRepository;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-library-'));
    repository = new LocalJsonProductRepository(directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('reads a v0.4 legacy array byte-for-byte without adding fields or rewriting it', async () => {
    const created = await repository.upsert(draft);
    const oldProduct = { ...created, aiAnalysis: analysis };
    const oldFile = JSON.stringify([oldProduct]);
    await writeFile(repository.filePath, oldFile);
    expect(await repository.librarySnapshot()).toEqual({
      products: [oldProduct],
      groups: [],
      tags: [],
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(await repository.get(oldProduct.id)).toEqual(oldProduct);
    expect(await readFile(repository.filePath, 'utf8')).toBe(oldFile);
  });

  it('creates, renames and persists colored groups/tags without changing product identity or analysis', async () => {
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis, product.updatedAt);
    const withGroup = await repository.manageDefinition({
      kind: 'group',
      action: 'create',
      name: 'Kitchen',
      color: '#4D7A62',
    });
    const withTag = await repository.manageDefinition({
      kind: 'tag',
      action: 'create',
      name: 'Review',
      color: '#F59E0B',
    });
    const group = withGroup.groups[0]!;
    const tag = withTag.tags[0]!;
    await repository.batch({
      ids: [product.id],
      operation: 'add-groups',
      groupIds: [group.id],
      expectedUpdatedAt: { [product.id]: analyzed.updatedAt },
    });
    const grouped = (await repository.get(product.id))!;
    await repository.batch({
      ids: [product.id],
      operation: 'add-tags',
      tagIds: [tag.id],
      expectedUpdatedAt: { [product.id]: grouped.updatedAt },
    });
    const tagged = (await repository.get(product.id))!;
    expect(tagged).toMatchObject({
      id: product.id,
      sourceId: draft.sourceId,
      groupIds: [group.id],
      tagIds: [tag.id],
      aiAnalysis: analysis,
      analysisHistory: analyzed.analysisHistory,
    });
    await repository.manageDefinition({
      kind: 'group',
      action: 'rename',
      id: group.id,
      name: 'Kitchen tools',
      color: '#112233',
    });
    const disk = JSON.parse(await readFile(repository.filePath, 'utf8')) as {
      schemaVersion: number;
    };
    expect(disk.schemaVersion).toBe(2);
    const reopened = await new LocalJsonProductRepository(directory).librarySnapshot();
    expect(reopened.groups[0]).toMatchObject({
      id: group.id,
      name: 'Kitchen tools',
      color: '#112233',
    });
    expect(reopened.products[0]).toEqual(tagged);
  });

  it('deleting a definition requires confirmation and removes references while preserving all analysis versions', async () => {
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis, product.updatedAt);
    const snapshot = await repository.manageDefinition({
      kind: 'tag',
      action: 'create',
      name: 'Keep',
      color: '#123456',
    });
    const id = snapshot.tags[0]!.id;
    await repository.batch({ ids: [product.id], operation: 'add-tags', tagIds: [id] });
    const before = await readFile(repository.filePath, 'utf8');
    await expect(
      repository.manageDefinition({ kind: 'tag', action: 'delete', id }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
    await repository.manageDefinition({ kind: 'tag', action: 'delete', id, confirmed: true });
    const after = (await repository.get(product.id))!;
    expect(after.tagIds).toEqual([]);
    expect(after.aiAnalysis).toEqual(analysis);
    expect(after.analysisHistory).toEqual(analyzed.analysisHistory);
    expect((await repository.librarySnapshot()).tags).toEqual([]);
  });

  it('reports mixed successes, missing products and stale updates without losing other records', async () => {
    const first = await repository.upsert(draft);
    const second = await repository.upsert({
      ...draft,
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
    });
    const tag = (
      await repository.manageDefinition({ kind: 'tag', action: 'create', name: 'Chosen' })
    ).tags[0]!;
    const changed = await repository.upsert({
      ...draft,
      sourceId: second.sourceId,
      url: second.url,
      price: '$29',
    });
    const result = await repository.batch({
      ids: [first.id, second.id, 'missing'],
      operation: 'add-tags',
      tagIds: [tag.id],
      expectedUpdatedAt: {
        [first.id]: first.updatedAt,
        [second.id]: second.updatedAt,
        missing: first.updatedAt,
      },
    });
    expect(result.succeededIds).toEqual([first.id]);
    expect(result.failures).toEqual([
      { id: second.id, error: expect.stringContaining('更新') },
      { id: 'missing', error: expect.stringContaining('不存在') },
    ]);
    expect(await repository.get(second.id)).toEqual(changed);
    expect((await new LocalJsonProductRepository(directory).get(first.id))?.tagIds).toEqual([
      tag.id,
    ]);
  });

  it('never reports uncommitted success after an atomic write fails', async () => {
    const product = await repository.upsert(draft);
    const tag = (
      await repository.manageDefinition({ kind: 'tag', action: 'create', name: 'Fail safely' })
    ).tags[0]!;
    const before = await readFile(repository.filePath, 'utf8');
    const storage = repository as unknown as {
      writeLibrary(snapshot: LibrarySnapshot): Promise<void>;
    };
    vi.spyOn(storage, 'writeLibrary').mockRejectedValueOnce(new Error('Disk unavailable'));
    await expect(
      repository.batch({ ids: [product.id], operation: 'add-tags', tagIds: [tag.id] }),
    ).rejects.toThrow('Disk unavailable');
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
    expect((await repository.get(product.id))?.tagIds).toBeUndefined();
  });

  it('preserves memberships on recapture and archives prior analysis instead of overwriting history', async () => {
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis, product.updatedAt);
    const group = (
      await repository.manageDefinition({ kind: 'group', action: 'create', name: 'Selected' })
    ).groups[0]!;
    await repository.batch({ ids: [product.id], operation: 'add-groups', groupIds: [group.id] });
    const recaptured = await repository.upsert({ ...draft, price: '$20' });
    expect(recaptured.id).toBe(product.id);
    expect(recaptured.groupIds).toEqual([group.id]);
    expect(recaptured.aiAnalysis).toBeUndefined();
    expect(recaptured.analysisHistory).toEqual(analyzed.analysisHistory);
    expect(
      (
        await repository.restoreAnalysis(
          product.id,
          analyzed.analysisHistory![0]!.id,
          recaptured.updatedAt,
        )
      ).groupIds,
    ).toEqual([group.id]);
  });

  it('moves between groups and removes tags only with explicit destructive confirmation', async () => {
    const product = await repository.upsert(draft);
    const first = (
      await repository.manageDefinition({ kind: 'group', action: 'create', name: 'First' })
    ).groups[0]!;
    const second = (
      await repository.manageDefinition({ kind: 'group', action: 'create', name: 'Second' })
    ).groups[1]!;
    await repository.batch({ ids: [product.id], operation: 'add-groups', groupIds: [first.id] });
    await expect(
      repository.batch({ ids: [product.id], operation: 'move-group', groupIds: [second.id] }),
    ).rejects.toMatchObject({ status: 400 });
    await repository.batch({
      ids: [product.id],
      operation: 'move-group',
      groupIds: [second.id],
      confirmed: true,
    });
    expect((await repository.get(product.id))?.groupIds).toEqual([second.id]);
    await expect(
      repository.batch({ ids: [product.id], operation: 'remove-groups', groupIds: [second.id] }),
    ).rejects.toMatchObject({ status: 400 });
    await repository.batch({
      ids: [product.id],
      operation: 'remove-groups',
      groupIds: [second.id],
      confirmed: true,
    });
    expect((await repository.get(product.id))?.groupIds).toEqual([]);
  });

  it('rejects unknown definitions, duplicate requests, overlarge batches, invalid names/colors without changing data', async () => {
    const product = await repository.upsert(draft);
    const before = await readFile(repository.filePath, 'utf8');
    const result = await repository.batch({
      ids: [product.id],
      operation: 'add-tags',
      tagIds: [randomUUID()],
    });
    expect(result.succeededIds).toEqual([]);
    expect(result.failures).toHaveLength(1);
    await expect(
      repository.batch({ ids: [product.id, product.id], operation: 'delete', confirmed: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.batch({
        ids: Array.from({ length: 501 }, (_, index) => String(index)),
        operation: 'delete',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      repository.manageDefinition({
        kind: 'tag',
        action: 'create',
        name: 'x'.repeat(49),
        color: 'javascript:alert(1)',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });

  it('does not overwrite corrupt definitions or dangling membership references', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const product = await repository.upsert(draft);
    const invalid = JSON.stringify({
      schemaVersion: 2,
      products: [{ ...product, tagIds: [randomUUID()] }],
      groups: [],
      tags: [],
    });
    await writeFile(repository.filePath, invalid);
    await expect(repository.librarySnapshot()).rejects.toMatchObject({ status: 500 });
    await expect(repository.upsert(draft)).rejects.toMatchObject({ status: 500 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(invalid);
  });

  it('serializes concurrent definition creation and rejects duplicate names', async () => {
    const results = await Promise.allSettled([
      repository.manageDefinition({ kind: 'tag', action: 'create', name: 'Repeat' }),
      new LocalJsonProductRepository(directory).manageDefinition({
        kind: 'tag',
        action: 'create',
        name: 'repeat',
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await repository.librarySnapshot()).tags).toHaveLength(1);
  });

  it('persists confirmed deletion with per-item CAS and preserves nonselected records', async () => {
    const first = await repository.upsert(draft);
    const second = await repository.upsert({
      ...draft,
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
    });
    await expect(repository.batch({ ids: [first.id], operation: 'delete' })).rejects.toMatchObject({
      status: 400,
    });
    const result = await repository.batch({
      ids: [first.id, second.id],
      operation: 'delete',
      confirmed: true,
      expectedUpdatedAt: { [first.id]: first.updatedAt },
    });
    expect(result.succeededIds).toEqual([first.id]);
    expect(result.failures).toEqual([{ id: second.id, error: expect.stringContaining('更新') }]);
    expect(await repository.list()).toEqual([second]);
  });

  it('imports a backup atomically, preserves conflicting current analyses, and rejects a stale preview', async () => {
    const original = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(original.id, analysis, original.updatedAt);
    const before = await repository.librarySnapshot();
    const newId = 'new-synthetic-item';
    const now = new Date().toISOString();
    const group = {
      id: randomUUID(),
      name: 'Imported group',
      color: '#123456',
      createdAt: now,
      updatedAt: now,
    };
    const incoming: LibrarySnapshot = {
      products: [
        {
          ...analyzed,
          title: 'Conflicting imported title',
          aiAnalysis: { ...analysis, summary: 'Must never replace user edits' },
        },
        {
          ...original,
          id: newId,
          sourceId: 'B012345679',
          url: 'https://www.amazon.com/dp/B012345679',
          groupIds: [group.id],
        },
      ],
      groups: [group],
      tags: [],
    };
    const result = await repository.importLibrary(incoming, 'preserve', before.revision);
    expect(result).toMatchObject({
      imported: 1,
      skipped: 1,
      failed: 0,
      groupsAdded: 1,
      importedIds: [newId],
    });
    expect(await repository.get(analyzed.id)).toEqual(analyzed);
    expect((await new LocalJsonProductRepository(directory).get(newId))?.groupIds).toEqual([
      group.id,
    ]);
    const after = await readFile(repository.filePath, 'utf8');
    await expect(repository.importLibrary(incoming, 'skip', before.revision)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(await readFile(repository.filePath, 'utf8')).toBe(after);
    const latest = await repository.librarySnapshot();
    const duplicate = await repository.importLibrary(incoming, 'skip', latest.revision);
    expect(duplicate).toMatchObject({ imported: 0, skipped: 2 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(after);
  });

  it('refuses malformed or unsafe imported media before any persistent change', async () => {
    const product = await repository.upsert(draft);
    const before = await readFile(repository.filePath, 'utf8');
    await expect(
      repository.importLibrary(
        { products: [{ ...product, images: ['http://127.0.0.1/private'] }], groups: [], tags: [] },
        'skip',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
    await expect(
      repository.importLibrary(
        {
          products: [{ ...product, url: 'https://www.amazon.com/dp/B000000000' }],
          groups: [],
          tags: [],
        },
        'preserve',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(await readFile(repository.filePath, 'utf8')).toBe(before);
  });

  it('updates exactly 500 synthetic records in one batch without altering stored analysis or histories', async () => {
    const prototype = await repository.upsert(draft);
    const now = new Date().toISOString();
    const tag = {
      id: randomUUID(),
      name: 'Synthetic benchmark',
      color: '#456789',
      createdAt: now,
      updatedAt: now,
    };
    const products = Array.from({ length: 500 }, (_, index) => {
      const asin = `B0${String(index).padStart(8, '0')}`;
      return {
        ...prototype,
        id: `synthetic:${index}`,
        sourceId: asin,
        url: `https://www.amazon.com/dp/${asin}`,
        title: `Synthetic performance sample ${index}`,
        aiAnalysis: analysis,
      };
    });
    await writeFile(
      repository.filePath,
      JSON.stringify({ schemaVersion: 2, products, groups: [], tags: [tag] }),
    );
    const result = await repository.batch({
      ids: products.map((product) => product.id),
      operation: 'add-tags',
      tagIds: [tag.id],
      expectedUpdatedAt: Object.fromEntries(
        products.map((product) => [product.id, product.updatedAt]),
      ),
    });
    expect(result.succeededIds).toHaveLength(500);
    expect(result.failures).toEqual([]);
    const restored = await new LocalJsonProductRepository(directory).librarySnapshot();
    expect(restored.products).toHaveLength(500);
    expect(
      restored.products.every(
        (product) =>
          product.tagIds?.[0] === tag.id && product.aiAnalysis?.summary === analysis.summary,
      ),
    ).toBe(true);
  });
});
