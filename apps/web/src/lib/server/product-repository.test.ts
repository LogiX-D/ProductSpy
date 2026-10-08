import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProductAnalysis, ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalJsonProductRepository } from './product-repository';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Travel bottle',
  price: '$25',
  currency: 'USD',
  mainImage: 'https://m.media-amazon.com/images/I/bottle.jpg',
  images: ['https://m.media-amazon.com/images/I/bottle.jpg'],
  videos: [],
  bulletPoints: ['Reusable stainless steel bottle'],
};
const analysis: ProductAnalysis = {
  summary: 'A reusable travel bottle.',
  sellingPoints: ['Reusable'],
  targetAudience: ['Travelers'],
  purchaseMotivations: ['Convenience'],
  painPoints: ['Disposable waste'],
  strengths: ['Portable'],
  weaknesses: ['Capacity must be verified'],
  marketingAngles: ['Daily commute'],
  hooks: ['One', 'Two', 'Three', 'Four', 'Five'],
  shortVideoScript: 'Hook: Start\nProblem: Waste\nSolution: Reuse\nDemo: Fill\nCTA: Explore',
  imagePrompts: ['A bottle on a clean desk'],
  videoPrompts: ['Show a commuter filling a bottle'],
};

describe('LocalJsonProductRepository', () => {
  let directory: string;
  let repository: LocalJsonProductRepository;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-repository-'));
    repository = new LocalJsonProductRepository(directory);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('starts with an empty library', async () => {
    expect(await repository.list()).toEqual([]);
  });

  it('deduplicates concurrent captures across instances and persists them', async () => {
    const secondRepository = new LocalJsonProductRepository(directory);
    const captures = await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        (index % 2 ? repository : secondRepository).upsert({ ...draft, price: `$${index}` }),
      ),
    );
    expect(new Set(captures.map((product) => product.id)).size).toBe(1);
    const reloaded = await new LocalJsonProductRepository(directory).list();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]?.price).toBe('$14');
    expect(reloaded[0]?.createdAt).toBe(captures[0]?.createdAt);
    expect(reloaded[0]?.updatedAt).not.toBe(captures[0]?.updatedAt);
  });

  it('normalizes ASIN and updates product content while preserving identity', async () => {
    const first = await repository.upsert(draft);
    const updated = await repository.upsert({
      ...draft,
      sourceId: ' b012345678 ',
      price: '$30',
      title: 'Updated bottle',
    });
    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.sourceId).toBe('B012345678');
    expect(updated.price).toBe('$30');
    expect(updated.title).toBe('Updated bottle');
    expect(updated.updatedAt > first.updatedAt).toBe(true);
    expect(await repository.get(updated.id)).toEqual(updated);
  });

  it('reads current disk content on each list and deletes persistently', async () => {
    const product = await repository.upsert(draft);
    await repository.delete(product.id);
    expect(await new LocalJsonProductRepository(directory).get(product.id)).toBeUndefined();
    await expect(repository.delete(product.id)).rejects.toMatchObject({ status: 404 });
    await writeFile(repository.filePath, JSON.stringify([product]));
    expect(await repository.list()).toHaveLength(1);
  });

  it('does not overwrite malformed JSON and recovers its queue after failure', async () => {
    await writeFile(repository.filePath, '{broken');
    await expect(repository.list()).rejects.toMatchObject({ status: 500 });
    await expect(repository.upsert(draft)).rejects.toMatchObject({ status: 500 });
    expect(await readFile(repository.filePath, 'utf8')).toBe('{broken');
    await writeFile(repository.filePath, '[]');
    expect((await repository.upsert(draft)).title).toBe(draft.title);
  });

  it('rejects schema-invalid or duplicate on-disk records without overwriting', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(repository.filePath, '[{"id":"wrong"}]');
    await expect(repository.upsert(draft)).rejects.toMatchObject({ status: 500 });
    expect(await readFile(repository.filePath, 'utf8')).toBe('[{"id":"wrong"}]');
    await writeFile(repository.filePath, '[]');
    const product = await repository.upsert(draft);
    await writeFile(repository.filePath, JSON.stringify([product, product]));
    await expect(repository.list()).rejects.toMatchObject({ status: 500 });
    errorLog.mockRestore();
  });

  it('validates and saves analysis, invalidating it after a meaningful capture update', async () => {
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis, product.updatedAt);
    expect(analyzed.aiAnalysis).toEqual(analysis);
    const unchanged = await repository.upsert(draft);
    expect(unchanged.aiAnalysis).toEqual(analysis);
    const changed = await repository.upsert({ ...draft, price: '$29' });
    expect(changed.aiAnalysis).toBeUndefined();
  });

  it('rejects stale analysis and does not revive a deleted product', async () => {
    const product = await repository.upsert(draft);
    const updated = await repository.upsert({ ...draft, price: '$29' });
    await expect(
      repository.saveAnalysis(product.id, analysis, product.updatedAt),
    ).rejects.toMatchObject({ status: 409 });
    expect(await repository.get(product.id)).toEqual(updated);
    await repository.delete(product.id);
    await expect(
      repository.saveAnalysis(product.id, analysis, updated.updatedAt),
    ).rejects.toMatchObject({ status: 404 });
    expect(await repository.list()).toEqual([]);
  });

  it('leaves previous valid analysis untouched when the new response fails validation', async () => {
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis);
    await expect(
      repository.saveAnalysis(product.id, { ...analysis, hooks: [] }),
    ).rejects.toMatchObject({ status: 502 });
    expect(await repository.get(product.id)).toEqual(analyzed);
  });
});
