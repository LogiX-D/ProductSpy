import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { draftSchema } from '@productspy/shared';
import { AmazonProductExtractor } from '../src/extractors/AmazonProductExtractor';

const url = 'https://www.amazon.com/dp/B012345678';
const html = readFileSync(new URL('./fixtures/media-specifications.html', import.meta.url), 'utf8');
const extract = (source = html) =>
  new AmazonProductExtractor(new JSDOM(source).window.document, url).extract();
describe('current product specifications and media provenance', () => {
  it('keeps merchant specifications separate from recommendations, review counts and mismatched ASINs', () => {
    expect(extract()?.specifications).toEqual([
      { name: 'Brand', value: 'TrailBean', source: 'page' },
      { name: 'Material', value: 'Stainless steel', source: 'page' },
      { name: 'Weight', value: '450 g', source: 'page' },
    ]);
  });
  it('records actual current-image variants/dimensions, ASIN, page and extraction time without synthesizing URLs', () => {
    const product = extract();
    expect(product?.images).toEqual(['https://m.media-amazon.com/images/I/grinder.jpg']);
    expect(product?.mediaMetadata).toHaveLength(2);
    expect(product?.mediaMetadata).toContainEqual(
      expect.objectContaining({
        url: 'https://m.media-amazon.com/images/I/grinder.jpg',
        width: 1800,
        height: 1800,
        productSourceId: 'B012345678',
        sourceUrl: url,
      }),
    );
    expect(
      product?.mediaMetadata?.every((asset) => Number.isFinite(Date.parse(asset.extractedAt))),
    ).toBe(true);
    expect(draftSchema.safeParse(product).success).toBe(true);
  });
  it('bad dimension JSON cannot erase valid URLs or crash capture', () => {
    expect(
      extract(html.replace('[1800,1800]', '[999999,-1]'))?.mediaMetadata?.find((asset) =>
        asset.url.endsWith('grinder.jpg'),
      )?.width,
    ).toBeUndefined();
    expect(extract('<h1 id="productTitle">Minimal</h1>')).toMatchObject({
      specifications: [],
      mediaMetadata: [],
    });
  });
});
