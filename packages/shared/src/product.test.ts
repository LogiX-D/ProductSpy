import { describe, expect, it } from 'vitest';
import { analysisSchema, draftSchema, isAmazonProductUrl, isAmazonUrl } from './schema';
import { mergeProduct, productKey } from './product';
import type { ProductDraft } from './types';

const draft: ProductDraft = {
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Portable coffee maker',
  price: '$29.99',
  images: ['https://m.media-amazon.com/images/I/a.jpg'],
  videos: [],
  bulletPoints: ['Portable'],
};
describe('product identity and deduplication', () => {
  it('uses source + normalized ASIN and preserves identity and creation date', () => {
    const first = mergeProduct(draft, undefined, '2026-10-01T00:00:00.000Z');
    const updated = mergeProduct(
      { ...draft, price: '$25.99', images: [...draft.images, ...draft.images] },
      first,
      '2026-10-08T00:00:00.000Z',
    );
    expect(updated.id).toBe(first.id);
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBe('2026-10-08T00:00:00.000Z');
    expect(updated.price).toBe('$25.99');
    expect(updated.images).toHaveLength(1);
    expect(productKey({ source: 'amazon', sourceId: 'b012345678' })).toBe(first.id);
  });
  it('accepts missing optional fields and rejects invalid protocols or deceptive hosts', () => {
    expect(draftSchema.safeParse(draft).success).toBe(true);
    expect(draftSchema.safeParse({ ...draft, mainImage: 'javascript:alert(1)' }).success).toBe(
      false,
    );
    expect(isAmazonUrl('https://amazon.com.evil.example/dp/B012345678')).toBe(false);
    expect(isAmazonProductUrl('https://www.amazon.co.uk/dp/B012345678/ref=something')).toBe(true);
    expect(isAmazonProductUrl('https://www.amazon.com/s?k=coffee')).toBe(false);
  });
  it('always advances the update version, even inside the same millisecond', () => {
    const first = mergeProduct(draft, undefined, '2026-10-08T00:00:00.000Z');
    const second = mergeProduct(draft, first, first.updatedAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });
});
describe('AI response schema validation', () => {
  it('rejects empty and partial responses', () => {
    expect(analysisSchema.safeParse({}).success).toBe(false);
    expect(analysisSchema.safeParse({ summary: 'test', hooks: ['one'] }).success).toBe(false);
  });
});
