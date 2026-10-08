import { mergeProduct, type ProductAnalysis, type ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionLocalStorageAdapter } from './ExtensionLocalStorageAdapter';

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

describe('ExtensionLocalStorageAdapter', () => {
  let persisted: Record<string, unknown>;
  const get = vi.fn(async (key: string): Promise<Record<string, unknown>> => {
    await Promise.resolve();
    return structuredClone({ [key]: persisted[key] });
  });
  const set = vi.fn(async (items: Record<string, unknown>): Promise<void> => {
    await Promise.resolve();
    persisted = { ...persisted, ...structuredClone(items) };
  });

  beforeEach(() => {
    persisted = {};
    get.mockClear();
    set.mockClear();
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('persists asynchronously and is readable from a fresh adapter', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    expect(await repository.list()).toEqual([]);
    const product = await repository.upsert(draft);
    expect(set).toHaveBeenCalled();
    const restarted = new ExtensionLocalStorageAdapter();
    expect(await restarted.get(product.id)).toEqual(product);
    expect(await restarted.list()).toEqual([product]);
  });

  it('serializes concurrent captures and keeps a single product for the same ASIN', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const products = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.upsert({ ...draft, title: `Bottle ${index}`, price: `$${index}` }),
      ),
    );
    expect(new Set(products.map((product) => product.id)).size).toBe(1);
    expect(await repository.list()).toHaveLength(1);
    expect((await repository.list())[0]?.price).toBe('$19');
    expect((await repository.list())[0]?.createdAt).toBe(products[0]?.createdAt);
  });

  it('deduplicates concurrent pending saves and remembers the newest draft', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        repository.enqueue({ ...draft, price: `$${index}` }),
      ),
    );
    expect(await repository.list()).toHaveLength(1);
    expect(await repository.pendingDrafts()).toEqual([{ ...draft, price: '$11' }]);
    expect(await new ExtensionLocalStorageAdapter().pendingDrafts()).toEqual([
      { ...draft, price: '$11' },
    ]);
  });

  it('reconciles successful server captures and clears the matching pending draft', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    await repository.enqueue(draft);
    const otherDraft: ProductDraft = {
      ...draft,
      sourceId: 'B098765432',
      url: 'https://www.amazon.com/dp/B098765432',
    };
    await repository.enqueue(otherDraft);
    const fromServer = { ...mergeProduct({ ...draft, price: '$30' }), id: 'server-product-id' };
    await repository.remember(fromServer);
    expect(
      (await repository.list()).filter((product) => product.sourceId === draft.sourceId),
    ).toEqual([fromServer]);
    expect(await repository.pendingDrafts()).toEqual([otherDraft]);
  });

  it('deletes the product and its pending save together', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const product = await repository.enqueue(draft);
    await repository.delete(product.id);
    expect(await repository.get(product.id)).toBeUndefined();
    expect(await repository.pendingDrafts()).toEqual([]);
    expect(await new ExtensionLocalStorageAdapter().list()).toEqual([]);
  });

  it('saves analysis with a strictly newer version and rejects stale results', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis, product.updatedAt);
    expect(analyzed.aiAnalysis).toEqual(analysis);
    expect(analyzed.updatedAt > product.updatedAt).toBe(true);
    await expect(repository.saveAnalysis(product.id, analysis, product.updatedAt)).rejects.toThrow(
      '商品已更新',
    );
    expect(await repository.get(product.id)).toEqual(analyzed);
  });

  it('rejects analysis when a capture changed the product or it was deleted', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const product = await repository.upsert(draft);
    vi.setSystemTime(new Date('2026-10-08T00:00:01.000Z'));
    const updated = await repository.upsert({ ...draft, price: '$40' });
    await expect(repository.saveAnalysis(product.id, analysis, product.updatedAt)).rejects.toThrow(
      '商品已更新',
    );
    expect(await repository.get(product.id)).toEqual(updated);
    await repository.delete(product.id);
    await expect(repository.saveAnalysis(product.id, analysis)).rejects.toThrow('商品不存在');
  });

  it('preserves valid data after a storage write failure and keeps the queue usable', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const first = await repository.upsert(draft);
    set.mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(repository.enqueue({ ...draft, price: '$99' })).rejects.toThrow(
      'Storage unavailable',
    );
    expect(await repository.get(first.id)).toEqual(first);
    expect(await repository.pendingDrafts()).toEqual([]);
    await repository.enqueue({ ...draft, price: '$30' });
    expect((await repository.pendingDrafts())[0]?.price).toBe('$30');
  });

  it('validates stored records and rejects invalid analysis before writing', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const product = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(product.id, analysis);
    await expect(repository.saveAnalysis(product.id, { ...analysis, hooks: [] })).rejects.toThrow();
    expect(await repository.get(product.id)).toEqual(analyzed);
    persisted = {
      'productspy.local.v1': {
        products: { invalid: { id: 'bad' } },
        pending: { invalid: { title: 'bad' } },
      },
    };
    expect(await repository.list()).toEqual([]);
    expect(await repository.pendingDrafts()).toEqual([]);
  });

  it('retains pending updates after a failed synchronization cache write', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const saved = await repository.upsert(draft);
    const pending = { ...draft, price: '$35' };
    await repository.enqueue(pending);
    const synchronized = mergeProduct(pending, saved);
    set.mockRejectedValueOnce(new Error('Storage quota exceeded'));
    await expect(repository.remember(synchronized)).rejects.toThrow('Storage quota exceeded');
    const restarted = new ExtensionLocalStorageAdapter();
    expect(await restarted.pendingDrafts()).toEqual([pending]);
    expect((await restarted.list())[0]?.createdAt).toBe(saved.createdAt);
    await restarted.remember(synchronized);
    expect(await restarted.pendingDrafts()).toEqual([]);
    expect(await restarted.get(saved.id)).toEqual(synchronized);
  });

  it('keeps other pending products after partially successful synchronization', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const second: ProductDraft = {
      ...draft,
      sourceId: 'B098765432',
      url: 'https://www.amazon.com/dp/B098765432',
      title: 'Kitchen bottle',
    };
    await repository.enqueue(draft);
    await repository.enqueue(second);
    await repository.remember(mergeProduct(draft));
    expect(await repository.list()).toHaveLength(2);
    expect(await repository.pendingDrafts()).toEqual([second]);
    expect(await new ExtensionLocalStorageAdapter().pendingDrafts()).toEqual([second]);
  });

  it('does not discard saved analysis or queued captures when validation fails', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const saved = await repository.upsert(draft);
    const analyzed = await repository.saveAnalysis(saved.id, analysis);
    await repository.enqueue(draft);
    await expect(repository.enqueue({ ...draft, sourceId: 'invalid' })).rejects.toThrow();
    await expect(
      repository.remember({ ...analyzed, images: ['javascript:alert(1)'] }),
    ).rejects.toThrow();
    const restarted = new ExtensionLocalStorageAdapter();
    expect((await restarted.get(saved.id))?.aiAnalysis).toEqual(analysis);
    expect(await restarted.pendingDrafts()).toEqual([draft]);
    expect(await restarted.list()).toHaveLength(1);
  });

  it('allows recovery from a transient read failure without replacing saved state', async () => {
    const repository = new ExtensionLocalStorageAdapter();
    const saved = await repository.upsert(draft);
    get.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    await expect(repository.enqueue({ ...draft, price: '$99' })).rejects.toThrow(
      'Storage temporarily unavailable',
    );
    expect(await repository.get(saved.id)).toEqual(saved);
    expect(await repository.pendingDrafts()).toEqual([]);
    await repository.enqueue({ ...draft, price: '$36' });
    expect((await repository.pendingDrafts())[0]?.price).toBe('$36');
    expect((await repository.list())[0]?.createdAt).toBe(saved.createdAt);
  });
});
