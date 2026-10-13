import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { draftSchema } from '@productspy/shared';
import { AmazonProductExtractor } from '../src/extractors/AmazonProductExtractor';
import { parseLiteral } from '../src/extractors/page-data';

const url = 'https://www.amazon.com/product-name/dp/B012345678?ref=tracking';
function extractor(html: string, sourceUrl = url): AmazonProductExtractor {
  return new AmazonProductExtractor(new JSDOM(html, { url: sourceUrl }).window.document, sourceUrl);
}
function fixture(name: string, sourceUrl = url): AmazonProductExtractor {
  return extractor(
    readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), 'utf8'),
    sourceUrl,
  );
}

describe('AmazonProductExtractor structured sources', () => {
  it('reads JSON-LD graph price, brand, rating and reviews before metadata fallback', () => {
    const product = fixture('jsonld-product').extract();
    expect(product).toMatchObject({
      source: 'amazon',
      sourceId: 'B012345678',
      title: 'Portable Coffee Grinder',
      price: '29.99',
      currency: 'USD',
      brand: 'TrailBean',
      rating: 4.5,
      reviewCount: 526,
      url: 'https://www.amazon.com/dp/B012345678',
      description: 'Fresh coffee anywhere.',
    });
    expect(draftSchema.safeParse(product).success).toBe(true);
  });

  it('handles JSON-LD image objects, deduplicates resized images and extracts public video', () => {
    const product = fixture('jsonld-product').extract();
    expect(product?.images).toEqual([
      'https://m.media-amazon.com/images/I/main.jpg',
      'https://m.media-amazon.com/images/I/detail.jpg',
    ]);
    expect(product?.mainImage).toBe(product?.images[0]);
    expect(product?.videos).toEqual([
      {
        url: 'https://media.example.com/demo.mp4',
        thumbnail: 'https://media.example.com/poster.jpg',
      },
    ]);
  });

  it('prefers a matching product in a JSON-LD array', () => {
    const html =
      '<script type="application/ld+json">[{"@type":"Product","sku":"B098765432","name":"Recommended"},{"@type":"Product","sku":"B012345678","name":"Actual product"}]</script>';
    expect(extractor(html).extractTitle()).toBe('Actual product');
  });

  it('does not use recommendation JSON-LD with a different ASIN', () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","sku":"B098765432","name":"Recommended","image":"https://example.com/recommendation.jpg"}</script><h1 id="productTitle">Actual product</h1><img id="landingImage" src="https://example.com/actual.jpg">';
    const product = extractor(html).extract();
    expect(product?.title).toBe('Actual product');
    expect(product?.images).toEqual(['https://example.com/actual.jpg']);
  });

  it('uses the selected purchase-form variant and its matching structured product', () => {
    const product = fixture('selected-variant').extract();
    expect(product).toMatchObject({
      sourceId: 'B098765432',
      url: 'https://www.amazon.com/dp/B098765432',
      title: 'Selected blue variant',
      price: '24.99',
      currency: 'USD',
      images: ['https://m.media-amazon.com/images/I/blue.jpg'],
    });
  });

  it('falls back to the URL when the purchase form has no usable ASIN', () => {
    const product = extractor(
      '<input id="ASIN" value="invalid"><div data-asin="B098765432">Recommended</div><h1 id="productTitle">Current product</h1>',
    ).extract();
    expect(product?.sourceId).toBe('B012345678');
  });

  it('reads scoped Amazon product-data price without visible DOM pricing', () => {
    const product = extractor(
      '<h1 id="productTitle">Sample</h1><script>var productData = {price:"22.00",priceCurrency:"USD"};</script>',
    ).extract();
    expect(product).toMatchObject({ price: '22.00', currency: 'USD' });
  });

  it('supports aggregate offers and product property fallback', () => {
    const html =
      '<script type="application/ld+json">{"@type":"Product","name":"Sample","offers":{"lowPrice":12.5,"priceCurrency":"USD"},"additionalProperty":[{"name":"Material","value":"Steel"}]}</script>';
    const product = extractor(html).extract();
    expect(product?.price).toBe('12.5');
    expect(product?.bulletPoints).toEqual(['Material: Steel']);
  });

  it('reads metadata and safe Amazon inline literals without executing JavaScript', () => {
    const product = fixture('script-product').extract();
    expect(product).toMatchObject({ title: 'Action Camera', price: '49.00', currency: 'EUR' });
    expect(product?.images).toEqual([
      'https://m.media-amazon.com/images/I/camera.jpg',
      'https://m.media-amazon.com/images/I/camera-detail.jpg',
    ]);
    expect(product?.videos.map((video) => video.url)).toEqual([
      'https://media.example.com/demo.webm',
      'https://media.example.com/stream.m3u8',
    ]);
  });
});

describe('AmazonProductExtractor DOM fallbacks', () => {
  it('does not mistake the observed book author byline for a brand', () => {
    expect(fixture('book-description-boundaries').extractBrand()).toBeUndefined();
  });

  it('keeps an explicit product brand when the book page also has an author byline', () => {
    const html =
      '<meta property="product:brand" content="Publisher imprint"><div id="bylineInfo"><span class="author">Named author</span></div>';
    expect(extractor(html).extractBrand()).toBe('Publisher imprint');
  });

  it('preserves observed book description line, paragraph and list boundaries', () => {
    const product = fixture(
      'book-description-boundaries',
      'https://www.amazon.com/dp/0735211299',
    ).extract();
    expect(product?.description).toBe(
      'The #1 New York Times bestseller. Over 25 million copies sold! Tiny Changes, Remarkable Results No matter your goals, Atomic Habits offers a framework. Learn how to: make time for new habits; design your environment; ...and much more.',
    );
    expect(product?.description).not.toContain('阅读更多');
    expect(product?.description).not.toContain('descriptionScriptMustNotRun');
    expect(product?.title).toBe('Atomic Habits');
    expect(product?.sourceId).toBe('0735211299');
  });

  it('excludes the observed 360 degree gallery control icon', () => {
    const product = extractor(
      '<h1 id="productTitle">Current</h1><img id="landingImage" src="https://m.media-amazon.com/images/I/product.jpg"><div id="altImages"><img src="https://m.media-amazon.com/images/G/01/HomeCustomProduct/360_icon_73x73v2.png"></div>',
    ).extract();
    expect(product?.images).toEqual(['https://m.media-amazon.com/images/I/product.jpg']);
  });

  it('reads actual A+ content after duplicated brand-story and comparison modules', () => {
    const html =
      '<h1 id="productTitle">Current</h1><div id="aplus"><div class="aplus-v2"><div class="apm-brand-story-carousel-container">Other products Store</div></div></div><div id="aplus"><div class="aplus-v2"><style>.hidden{display:none}</style><p>Current product features.</p><a class="a-carousel-goto-prevpage">Previous page</a><div class="premium-module-5-comparison-table-scroller">Recommended product price 9.99</div></div></div>';
    expect(extractor(html).extractDescription()).toBe('Current product features.');
  });

  it('leaves image-only A+ content without a fake description', () => {
    const html =
      '<meta name="description" content="Amazon.com: Current : Category"><h1 id="productTitle">Current</h1><div id="aplus"><div class="aplus-v2"><h2>From the manufacturer</h2><img src="https://example.com/features.jpg"><div class="video-js">Video Player is loading. Current Time 0:00</div></div></div>';
    expect(extractor(html).extractDescription()).toBeUndefined();
  });

  it('accepts only player states bound to the current ASIN and scoped public video', () => {
    const html =
      '<h1 id="productTitle">Current</h1><script type="a-state">{"productAsin":"B012345678","videoUrl":"https://media.example.com/current.m3u8","imageUrl":"https://media.example.com/current.jpg"}</script><script type="a-state">{"nexusMetricsConfig":{"pageAsin":"B098765432"},"videoUrl":"https://media.example.com/other.mp4"}</script><script>var videos=[{url:"https://media.example.com/current.m3u8"},{url:"https://media.example.com/recommended.m3u8"},{asin:"B098765432",url:"https://media.example.com/other.mp4"}];</script><div id="imageBlock"><video src="https://media.example.com/other.mp4"></video><video src="https://media.example.com/public-current.mp4"></video></div><div data-video-url="https://media.example.com/unscoped.mp4"></div>';
    expect(
      extractor(html)
        .extractVideos()
        .map((video) => video.url),
    ).toEqual([
      'https://media.example.com/current.m3u8',
      'https://media.example.com/public-current.mp4',
    ]);
  });

  it('excludes observed A+ video label tooltips from product descriptions', () => {
    const html =
      '<h1 id="productTitle">Current</h1><div id="aplus"><div class="aplus-v2"><p>Absorbent bath mat.</p><div class="vse-player-container"><span class="ive-player-label-tooltip aok-hidden">This video shows the product in use.</span></div></div></div>';
    expect(extractor(html).extractDescription()).toBe('Absorbent bath mat.');
  });

  it('prefers declared product ASIN over a conflicting recommendation player page context', () => {
    const html =
      '<h1 id="productTitle">Current</h1><script type="a-state">{"productAsin":"B098765432","nexusMetricsConfig":{"pageAsin":"B012345678"},"videoUrl":"https://media.example.com/recommended.mp4"}</script>';
    expect(extractor(html).extractVideos()).toEqual([]);
  });

  it('uses the current DOM title, actual description and explicit displayed currency', () => {
    const product = fixture('localized-gallery').extract();
    expect(product).toMatchObject({
      sourceId: 'B098765432',
      title: 'Current blue product',
      price: 'TWD2,142.52',
      currency: 'TWD',
      brand: 'Sample',
      description: 'Actual product description.',
    });
  });

  it('decodes the current gallery and excludes other colors and duplicate resolution aliases', () => {
    expect(fixture('localized-gallery').extractImages()).toEqual([
      'https://m.media-amazon.com/images/I/blue-hi._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/detail-hi._SL1500_.jpg',
      'https://m.media-amazon.com/images/I/fallback._SX1200_.jpg',
    ]);
  });

  it('uses only an identifiable current group when initial gallery data is unavailable', () => {
    const product = extractor(
      '<h1 id="productTitle">Current</h1><img id="landingImage" src="https://m.media-amazon.com/images/I/blue.jpg"><script>var data={colorImages:{Black:[{hiRes:"https://m.media-amazon.com/images/I/black.jpg"}],Blue:[{hiRes:"https://m.media-amazon.com/images/I/blue.jpg"},{hiRes:"https://m.media-amazon.com/images/I/blue-detail.jpg"}]}};</script>',
    ).extract();
    expect(product?.images).toEqual([
      'https://m.media-amazon.com/images/I/blue.jpg',
      'https://m.media-amazon.com/images/I/blue-detail.jpg',
    ]);
  });

  it('keeps a decoded gallery when the main image node is still empty', () => {
    const html =
      '<h1 id="productTitle">Current</h1><img id="landingImage"><script>var data={colorImages:{initial:A.$.parseJSON(\'[{"hiRes":"https://m.media-amazon.com/images/I/ready.jpg"}]\')}};</script>';
    expect(extractor(html).extractImages()).toEqual([
      'https://m.media-amazon.com/images/I/ready.jpg',
    ]);
  });

  it('uses a scoped brand value when the store link is unavailable', () => {
    expect(
      extractor(
        '<h1 id="productTitle">Webcam</h1><table><tr class="po-brand"><td><span class="po-break-word">Logitech</span></td></tr></table>',
      ).extractBrand(),
    ).toBe('Logitech');
  });

  it.each([
    ['访问 CeraVe 品牌旗舰店', 'CeraVe'],
    ['品牌：CeraVe', 'CeraVe'],
    ['访问亚马逊 Echo 和 Alexa 商店', '亚马逊 Echo 和 Alexa'],
    ['Besuche den Logitech-Store', 'Logitech'],
  ])('removes the observed localized store wrapper from %s', (byline, brand) => {
    expect(extractor(`<a id="bylineInfo">${byline}</a>`).extractBrand()).toBe(brand);
  });

  it.each([
    ['TWD604.05', 'TWD'],
    ['NT$604.05', 'TWD'],
    ['US$29.99', 'USD'],
    ['$29.99', undefined],
  ])('reads %s without guessing currency from the storefront', (price, currency) => {
    const product = extractor(
      `<h1 id="productTitle">Current</h1><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">${price}</span></span></div>`,
    ).extract();
    expect(product?.price).toBe(price);
    expect(product?.currency).toBe(currency);
  });

  it('keeps explicit DOM currency when metadata refers to another display currency', () => {
    const product = extractor(
      '<meta property="product:price:currency" content="USD"><h1 id="productTitle">Current</h1><div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">TWD604.05</span></span></div>',
    ).extract();
    expect(product?.currency).toBe('TWD');
  });

  it('extracts title, visible price, ASIN, gallery, bullet points, rating and reviews', () => {
    const product = fixture(
      'dom-product',
      'https://www.amazon.co.uk/gp/product/B012345678',
    ).extract();
    expect(product).toMatchObject({
      title: 'Compact Desk Lamp',
      price: '£19.95',
      currency: 'GBP',
      sourceId: 'B012345678',
      brand: 'Bright Desk',
      rating: 4.3,
      reviewCount: 1234,
      description: 'Light for your desk.',
    });
    expect(product?.images).toEqual([
      'https://m.media-amazon.com/images/I/lamp.jpg',
      'https://m.media-amazon.com/images/I/lamp-detail.jpg',
    ]);
    expect(product?.bulletPoints).toEqual(['USB powered', 'Three lighting modes']);
    expect(product?.videos).toEqual([]);
  });

  it('supports decimal comma rating and localized review separators', () => {
    const product = extractor(
      '<h1 id="productTitle">Test</h1><div id="acrPopover" title="4,7 von 5 Sternen"></div><span id="acrCustomerReviewText">1.526 Bewertungen</span>',
    ).extract();
    expect(product?.rating).toBe(4.7);
    expect(product?.reviewCount).toBe(1526);
  });

  it('selects the largest dynamic gallery image and rejects unrelated images', () => {
    const product = extractor(
      '<h1 id="productTitle">Test</h1><img id="landingImage" data-a-dynamic-image=\'{"https://m.media-amazon.com/images/I/dynamic._AC_SX100_.jpg":[100,100],"https://m.media-amazon.com/images/I/dynamic._AC_SX1200_.jpg":[1200,1200]}\'><img src="https://m.media-amazon.com/images/I/review-photo.jpg">',
    ).extract();
    expect(product?.images).toEqual([
      'https://m.media-amazon.com/images/I/dynamic._AC_SX1200_.jpg',
    ]);
  });

  it('exposes each extractor as an independent method', () => {
    const parser = fixture('dom-product');
    expect(parser.extractTitle()).toBe('Compact Desk Lamp');
    expect(parser.extractPrice().price).toBe('£19.95');
    expect(parser.extractAsin()).toBe('B012345678');
    expect(parser.extractImages()).toHaveLength(2);
    expect(parser.extractVideos()).toEqual([]);
    expect(parser.extractDescription()).toBe('Light for your desk.');
    expect(parser.extractBulletPoints()).toHaveLength(2);
    expect(parser.extractBrand()).toBe('Bright Desk');
    expect(parser.extractRating()).toBe(4.3);
    expect(parser.extractReviewCount()).toBe(1234);
  });
});

describe('AmazonProductExtractor failure isolation', () => {
  it('keeps a usable draft when optional fields are missing', () => {
    const product = extractor('<h1 id="productTitle">Only a title</h1>').extract();
    expect(product).toMatchObject({
      title: 'Only a title',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    expect(product?.price).toBeUndefined();
    expect(product?.rating).toBeUndefined();
    expect(draftSchema.safeParse(product).success).toBe(true);
  });

  it('recovers from malformed JSON-LD, script objects and invalid HTML', () => {
    const product = fixture('malformed-product').extract();
    expect(product?.title).toBe('Malformed but usable');
    expect(product?.images).toEqual(['https://m.media-amazon.com/images/I/fallback.jpg']);
    expect(product?.bulletPoints).toEqual(['Reliable fallback']);
    expect(product?.videos).toEqual([]);
  });

  it('does not fail the complete capture when one field throws', () => {
    const parser = fixture('dom-product');
    vi.spyOn(parser, 'extractPrice').mockImplementation(() => {
      throw new Error('Changed selector');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const product = parser.extract();
    expect(product?.title).toBe('Compact Desk Lamp');
    expect(product?.price).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
  });

  it.each([
    'https://www.amazon.com/s?k=lamp',
    'https://www.amazon.com/',
    'https://amazon.com.evil.example/dp/B012345678',
    'https://www.example.com/dp/B012345678',
  ])('returns unsupported state for %s', (sourceUrl) => {
    expect(extractor('<h1 id="productTitle">Sample</h1>', sourceUrl).extract()).toBeNull();
  });

  it('returns null instead of throwing for an empty document', () => {
    expect(extractor('').extract()).toBeNull();
  });

  it('drops invalid or out-of-range ratings', () => {
    const html =
      '<h1 id="productTitle">Sample</h1><div id="acrPopover" title="999 out of 5 stars"></div>';
    expect(extractor(html).extractRating()).toBeUndefined();
  });

  it('rejects executable page-data expressions', () => {
    expect(() => parseLiteral("{ hiRes: (() => 'secret')() }")).toThrow(
      'Unsupported JavaScript expression',
    );
    expect(
      parseLiteral(
        "{hiRes:'https://example.com/a.jpg', numbers:[1,2,], active:true, value:undefined}",
      ),
    ).toMatchObject({
      hiRes: 'https://example.com/a.jpg',
      numbers: [1, 2],
      active: true,
      value: null,
    });
  });

  it('decodes only known JSON wrappers with a single literal argument', () => {
    expect(
      parseLiteral('{initial:A.$.parseJSON(\'[{"hiRes":"https://example.com/a.jpg"}]\')}'),
    ).toMatchObject({ initial: [{ hiRes: 'https://example.com/a.jpg' }] });
    expect(parseLiteral('{initial:JSON.parse(\'{"safe":true}\')}')).toEqual({
      initial: { safe: true },
    });
    expect(() => parseLiteral('{initial:A.$.parseJSON(globalThis.secret)}')).toThrow();
    expect(() => parseLiteral("{initial:A.$.parseJSON('[]', run())}")).toThrow();
    expect(() => parseLiteral("{initial:A.$.parseJSON('[]') + run()}")).toThrow();
  });
});
