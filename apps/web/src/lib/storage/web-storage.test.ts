import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { WebLocalStorageAdapter } from './web-storage';
import type { ProductDraft } from '@productspy/shared';
const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345679',
  url: 'https://www.amazon.com/dp/B012345679',
  title: 'Cache product',
  images: [],
  videos: [],
  bulletPoints: [],
};
describe('IndexedDB adapter', () => {
  it('persists data across adapter instances and deduplicates', async () => {
    const first = new WebLocalStorageAdapter();
    await first.replace([]);
    const saved = await first.upsert(draft);
    const second = new WebLocalStorageAdapter();
    expect((await second.get(saved.id))?.title).toBe(draft.title);
    await second.upsert({ ...draft, price: '$19' });
    expect(await second.list()).toHaveLength(1);
    expect((await first.get(saved.id))?.price).toBe('$19');
    await first.delete(saved.id);
    expect(await second.list()).toHaveLength(0);
  });
});
