import { mergeProduct, productKey, type ProductDraft } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CloudCaptureQueue } from './CloudCaptureQueue';

const userId = 'queue-capacity-user';
const keyFor = (owner?: string) =>
  `productspy.cloud-queue.v1.${owner ? `user.${encodeURIComponent(owner)}` : '_unassigned'}`;
const draftFor = (index: number): ProductDraft => ({
  source: 'amazon',
  sourceId: `B${String(index).padStart(9, '0')}`,
  url: `https://www.amazon.com/dp/B${String(index).padStart(9, '0')}`,
  title: `Product ${index}`,
  description: '公开商品资料'.repeat(2000),
  images: [],
  videos: [],
  bulletPoints: [],
});

describe('SaaS outbox capacity and acknowledgement (local storage mocks)', () => {
  let records: Record<string, unknown>;
  let quotaBytes: number;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const set = vi.fn(async (items: Record<string, unknown>) => {
    const next = { ...records, ...structuredClone(items) };
    if (bytes(next) > quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    records = next;
  });
  const state = (owner = userId) =>
    records[keyFor(owner)] as {
      products: Record<string, unknown>;
      pending: Record<string, unknown>;
      notBefore: number;
    };

  beforeEach(() => {
    records = {};
    quotaBytes = 90_000;
    set.mockClear();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => structuredClone({ [key]: records[key] })),
          set,
        },
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not accumulate acknowledged product text across many large successful uploads', async () => {
    for (let index = 0; index < 12; index += 1) {
      const draft = draftFor(index);
      // Each instance represents a new popup/worker operation against the same storage.
      const queue = new CloudCaptureQueue(userId);
      const { capture } = await queue.enqueue(draft);
      expect(bytes(records)).toBeGreaterThan(70_000);
      expect(await queue.acknowledge(capture, mergeProduct(draft))).toBe(true);
      expect(await new CloudCaptureQueue(userId).pending()).toEqual([]);
      expect(state().products).toEqual({});
      expect(bytes(records)).toBeLessThan(300);
    }
    expect(set).toHaveBeenCalledTimes(24);
  });

  it('compacts a previously full account before enqueue while retaining its pending captures', async () => {
    const retained = draftFor(20);
    const pendingProduct = mergeProduct({ ...retained, description: 'Pending text' });
    const capture = {
      captureId: crypto.randomUUID(),
      draft: { ...retained, description: 'Pending text' },
      attempts: 2,
      nextAttemptAt: Date.now() + 60_000,
      error: 'offline',
    };
    records[keyFor(userId)] = {
      products: Object.fromEntries([
        [pendingProduct.id, pendingProduct],
        ...Array.from({ length: 8 }, (_, index) => {
          const product = mergeProduct(draftFor(index));
          return [product.id, product];
        }),
      ]),
      pending: { [productKey(retained)]: capture },
      notBefore: 0,
    };
    const otherAccount = { products: { saved: 'not inspected' }, pending: { raw: 'not changed' } };
    const unassigned = { products: { saved: 'unassigned original' }, pending: { raw: 'kept' } };
    records[keyFor('other-account')] = structuredClone(otherAccount);
    records[keyFor()] = structuredClone(unassigned);
    expect(bytes(records)).toBeGreaterThan(quotaBytes);

    const queue = new CloudCaptureQueue(userId);
    const fresh = await queue.enqueue(draftFor(21));
    expect(await queue.pending()).toEqual([capture, fresh.capture]);
    expect(state().products).toEqual({
      [pendingProduct.id]: pendingProduct,
      [fresh.product.id]: fresh.product,
    });
    expect(records[keyFor('other-account')]).toEqual(otherAccount);
    expect(records[keyFor()]).toEqual(unassigned);
    expect(bytes(records)).toBeLessThan(quotaBytes);
  });

  it('rejects a full pending outbox without evicting earlier captures, then recovers after acknowledgement', async () => {
    const queue = new CloudCaptureQueue(userId);
    const first = await queue.enqueue(draftFor(30));
    const before = structuredClone(records);
    await expect(queue.enqueue(draftFor(31))).rejects.toThrow('QUOTA_BYTES');
    expect(records).toEqual(before);
    expect(await new CloudCaptureQueue(userId).pending()).toEqual([first.capture]);

    await queue.acknowledge(first.capture, mergeProduct(first.capture.draft));
    const next = await queue.enqueue(draftFor(31));
    expect(await queue.pending()).toEqual([next.capture]);
  });

  it('does not copy old server analysis history into a recaptured pending product', async () => {
    const draft = draftFor(35);
    const confirmed = {
      ...mergeProduct(draft),
      analysisHistory: [
        {
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          kind: 'generated',
          analysis: {
            summary: '公'.repeat(12000),
            sellingPoints: ['Selling point'],
            targetAudience: ['Audience'],
            purchaseMotivations: ['Motivation'],
            painPoints: ['Pain point'],
            strengths: ['Strength'],
            weaknesses: ['Weakness'],
            marketingAngles: ['Angle'],
            hooks: ['1', '2', '3', '4', '5'],
            shortVideoScript: 'Hook: 1\nProblem: 2\nSolution: 3\nDemo: 4\nCTA: 5',
            imagePrompts: ['Image'],
            videoPrompts: ['Video'],
          },
        },
      ],
    };
    records[keyFor(userId)] = {
      products: { [confirmed.id]: confirmed },
      pending: {},
      notBefore: 0,
    };
    const pending = await new CloudCaptureQueue(userId).enqueue(draft);
    expect(pending.product.analysisHistory).toBeUndefined();
    expect(state().products).toEqual({ [pending.product.id]: pending.product });
    expect(bytes(records)).toBeLessThan(quotaBytes);
  });

  it('keeps a newer revision intact when an old upload is acknowledged', async () => {
    const queue = new CloudCaptureQueue(userId);
    const draft = draftFor(40);
    const old = await queue.enqueue(draft);
    const recent = await new CloudCaptureQueue(userId).enqueue({
      ...draft,
      title: 'Newer capture',
    });
    const before = structuredClone(records);
    expect(await queue.acknowledge(old.capture, mergeProduct(draft))).toBe(false);
    expect(records).toEqual(before);
    expect(await queue.pending()).toEqual([recent.capture]);
    expect(state().products).toEqual({ [recent.product.id]: recent.product });
  });

  it('preserves an acknowledged capture until its removal is durably written', async () => {
    const queue = new CloudCaptureQueue(userId);
    const queued = await queue.enqueue(draftFor(50));
    const before = structuredClone(records);
    set.mockRejectedValueOnce(new Error('Storage temporarily unavailable'));
    await expect(queue.acknowledge(queued.capture, queued.product)).rejects.toThrow(
      'Storage temporarily unavailable',
    );
    expect(records).toEqual(before);
    expect(await new CloudCaptureQueue(userId).pending()).toEqual([queued.capture]);
    expect(await queue.acknowledge(queued.capture, queued.product)).toBe(true);
    expect(state().products).toEqual({});
  });

  it('serializes acknowledgement with a concurrent recapture across queue instances', async () => {
    const queue = new CloudCaptureQueue(userId);
    const draft = draftFor(60);
    const first = await queue.enqueue(draft);
    const [acknowledged, recent] = await Promise.all([
      queue.acknowledge(first.capture, first.product),
      new CloudCaptureQueue(userId).enqueue({ ...draft, title: 'Captured during acknowledgement' }),
    ]);
    expect(acknowledged).toBe(true);
    expect(await queue.pending()).toEqual([recent.capture]);
    expect(state().products).toEqual({ [recent.product.id]: recent.product });
  });

  it('does not compact unassigned originals or accept an unassigned cloud acknowledgement', async () => {
    const original = mergeProduct({ ...draftFor(70), description: 'Original unassigned text' });
    records[keyFor()] = { products: { [original.id]: original }, pending: {}, notBefore: 0 };
    const queue = new CloudCaptureQueue();
    const pending = await queue.enqueue(draftFor(71));
    const unassigned = records[keyFor()] as { products: Record<string, unknown> };
    expect(unassigned.products[original.id]).toEqual(original);
    const before = structuredClone(records);
    await expect(queue.acknowledge(pending.capture, pending.product)).rejects.toThrow('未归属');
    expect(records).toEqual(before);
    expect(await queue.pending()).toEqual([pending.capture]);
  });
});
