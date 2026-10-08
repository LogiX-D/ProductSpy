import { isAmazonProductUrl, type ProductDraft, type ProductVideo } from '@productspy/shared';
import {
  asRecord,
  cleanText,
  flattenRecords,
  httpUrl,
  scriptValues,
  type PageRecord,
} from './page-data';

interface PriceValue {
  price?: string;
  currency?: string;
}

const ASIN_PATTERN = /^[A-Z0-9]{10}$/i;

/** Field extractors deliberately operate independently, with per-field failure isolation. */
export class AmazonProductExtractor {
  private readonly products: PageRecord[];

  constructor(
    private readonly document: Document,
    private readonly url: string,
  ) {
    this.products = this.field('structured product data', () => this.readProducts()) ?? [];
  }

  extract(): ProductDraft | null {
    if (!isAmazonProductUrl(this.url)) return null;
    const sourceId = this.field('ASIN', () => this.extractAsin());
    const title = this.field('title', () => this.extractTitle());
    if (!sourceId || !title) return null;
    const price = this.field('price', () => this.extractPrice()) ?? {};
    const images = this.field('images', () => this.extractImages()) ?? [];
    return {
      source: 'amazon',
      sourceId,
      url: new URL(`/dp/${sourceId}`, this.url).href,
      title,
      ...price,
      mainImage: images[0],
      images,
      videos: this.field('videos', () => this.extractVideos()) ?? [],
      description: this.field('description', () => this.extractDescription()),
      bulletPoints: this.field('bullet points', () => this.extractBulletPoints()) ?? [],
      brand: this.field('brand', () => this.extractBrand()),
      rating: this.field('rating', () => this.extractRating()),
      reviewCount: this.field('review count', () => this.extractReviewCount()),
    };
  }

  extractTitle(): string | undefined {
    return (
      this.productText('name') ??
      this.meta('og:title', 'twitter:title', 'title') ??
      this.text('#productTitle', '#title_feature_div h1', 'h1.a-size-large')
    );
  }

  extractPrice(): PriceValue {
    for (const product of this.products) {
      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      for (const offer of offers) {
        const record = asRecord(offer);
        if (!record) continue;
        const specification = asRecord(record.priceSpecification);
        const price = cleanText(record.price ?? record.lowPrice ?? specification?.price);
        if (price)
          return {
            price,
            currency: cleanText(record.priceCurrency ?? specification?.priceCurrency),
          };
      }
    }
    const metadataPrice = this.meta('product:price:amount', 'og:price:amount', 'price');
    const metadataCurrency = this.meta(
      'product:price:currency',
      'og:price:currency',
      'priceCurrency',
    );
    if (metadataPrice) return { price: metadataPrice, currency: metadataCurrency };
    for (const value of scriptValues(this.document, [
      'productData',
      'productDetail',
      'detailPageData',
    ])) {
      const record = asRecord(value);
      if (!record) continue;
      const price = cleanText(record.price ?? record.displayPrice);
      if (price)
        return {
          price,
          currency: cleanText(record.currency ?? record.priceCurrency) ?? metadataCurrency,
        };
    }
    const price = this.text(
      '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
      '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '#price_inside_buybox',
      '#newBuyBoxPrice',
      '#tp_price_block_total_price_ww .a-offscreen',
      '[itemprop="price"]',
    );
    if (!price) return {};
    return { price, currency: metadataCurrency ?? this.inferCurrency(price) };
  }

  extractAsin(): string | undefined {
    const urlAsin = new URL(this.url).pathname.match(
      /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    )?.[1];
    if (urlAsin) return urlAsin.toUpperCase();
    for (const selector of ['input#ASIN', 'input[name="ASIN"]', '[data-asin]']) {
      const element = this.document.querySelector(selector);
      const value = element?.getAttribute('value') ?? element?.getAttribute('data-asin');
      if (value && ASIN_PATTERN.test(value)) return value.toUpperCase();
    }
    for (const product of this.products) {
      for (const value of [product.sku, product.productID, product.asin]) {
        const asin = cleanText(value)?.replace(/^ASIN:\s*/i, '');
        if (asin && ASIN_PATTERN.test(asin)) return asin.toUpperCase();
      }
    }
    return undefined;
  }

  extractImages(): string[] {
    const candidates: { url: string; score: number }[] = [];
    const add = (value: unknown, score = 100): void => {
      if (Array.isArray(value)) {
        value.forEach((item) => add(item, score));
        return;
      }
      const record = asRecord(value);
      if (record) {
        add(record.contentUrl ?? record.url, score);
        return;
      }
      const url = httpUrl(value, this.url);
      if (!url || /(?:sprite|logo|play[-_]?icon|video[-_]?thumb|\.gif(?:\?|$))/i.test(url)) return;
      candidates.push({ url, score });
    };
    this.products.forEach((product) => add(product.image, 150));
    add(this.meta('og:image', 'twitter:image'), 140);
    for (const value of scriptValues(this.document, [
      'colorImages',
      'imageGalleryData',
      'imageData',
    ])) {
      const record = asRecord(value);
      const current = record?.initial ?? value;
      for (const image of flattenRecords(current)) {
        add(image.hiRes, 300);
        add(image.large, 200);
        if (!image.hiRes && !image.large) {
          const main = asRecord(image.main);
          if (main)
            Object.entries(main)
              .sort((a, b) => this.imageSize(b[1]) - this.imageSize(a[1]))
              .forEach(([url]) => add(url, 200));
        }
      }
    }
    for (const selector of [
      '#landingImage',
      '#imgBlkFront',
      '#main-image',
      '#ebooksImgBlkFront',
      '#altImages img',
      '#imageBlock img.a-dynamic-image',
    ]) {
      for (const element of this.document.querySelectorAll(selector)) {
        if (element.closest('[data-video-url], .videoThumbnail, .video-thumb')) continue;
        add(element.getAttribute('data-old-hires'), 300);
        const dynamic = element.getAttribute('data-a-dynamic-image');
        if (dynamic) {
          try {
            const parsed = asRecord(JSON.parse(dynamic) as unknown);
            if (parsed)
              Object.entries(parsed)
                .sort((a, b) => this.imageSize(b[1]) - this.imageSize(a[1]))
                .forEach(([url]) => add(url, 250));
          } catch {
            /* A corrupt image attribute does not discard other images. */
          }
        }
        add(element.getAttribute('src'), 80);
      }
    }
    const unique = new Map<string, { url: string; score: number }>();
    for (const candidate of candidates) {
      const key = candidate.url.replace(/\._[^/]*_\.(?=[a-z]{3,4}(?:[?]|$))/i, '.').split('?')[0];
      const existing = unique.get(key);
      if (!existing || candidate.score > existing.score) unique.set(key, candidate);
    }
    return [...unique.values()].map((candidate) => candidate.url).slice(0, 100);
  }

  extractVideos(): ProductVideo[] {
    const videos = new Map<string, ProductVideo>();
    const add = (value: unknown, thumbnail?: unknown): void => {
      const url = httpUrl(value, this.url);
      // Only direct public media URLs already exposed by the current page are collected.
      if (!url || !/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(url)) return;
      const poster = httpUrl(thumbnail, this.url);
      videos.set(url, { url, ...(poster ? { thumbnail: poster } : {}) });
    };
    for (const product of this.products) {
      for (const record of flattenRecords(product.video))
        add(record.contentUrl ?? record.url, record.thumbnailUrl);
    }
    for (const value of scriptValues(this.document, ['videos', 'videoData', 'videoGalleryData'])) {
      for (const record of flattenRecords(value)) {
        add(
          record.url ?? record.videoUrl ?? record.contentUrl ?? record.mediaUrl,
          record.thumbnail ?? record.thumbnailUrl ?? record.poster,
        );
      }
    }
    for (const element of this.document.querySelectorAll(
      '#imageBlock video, #imageBlock source, #video-player video, #video-player source, [data-video-url]',
    )) {
      add(
        element.getAttribute('src') ?? element.getAttribute('data-video-url'),
        element.getAttribute('poster'),
      );
    }
    return [...videos.values()].slice(0, 30);
  }

  extractDescription(): string | undefined {
    const description =
      this.productText('description') ??
      this.meta('description', 'og:description') ??
      this.text(
        '#productDescription',
        '#bookDescription_feature_div',
        '#aplus .aplus-v2',
        '#aplus',
      );
    if (!description) return undefined;
    const container = this.document.createElement('div');
    container.innerHTML = description;
    container.querySelectorAll('script,style').forEach((element) => element.remove());
    return cleanText(container.textContent)?.slice(0, 50_000);
  }

  extractBulletPoints(): string[] {
    const values: string[] = [];
    const selectors = [
      '#feature-bullets li .a-list-item',
      '#feature-bullets li',
      '#productFactsDesktopExpander li',
    ];
    for (const selector of selectors) {
      for (const element of this.document.querySelectorAll(selector)) {
        const text = cleanText(element.textContent);
        if (text && !/^(?:Make sure this fits|See more product details|Show more)/i.test(text))
          values.push(text);
      }
      if (values.length) break;
    }
    if (!values.length) {
      for (const product of this.products) {
        const properties = Array.isArray(product.additionalProperty)
          ? product.additionalProperty
          : [];
        for (const property of properties) {
          const record = asRecord(property);
          const value = cleanText(record?.value);
          const name = cleanText(record?.name);
          if (value) values.push(name ? `${name}: ${value}` : value);
        }
      }
    }
    return [...new Set(values)].slice(0, 50);
  }

  extractBrand(): string | undefined {
    for (const product of this.products) {
      const brand = cleanText(asRecord(product.brand)?.name ?? product.brand);
      if (brand) return brand;
    }
    const brand =
      this.meta('brand', 'product:brand') ??
      this.text('#bylineInfo', '#brand', '[itemprop="brand"]');
    return brand
      ?.replace(/^Visit the\s+/i, '')
      .replace(/\s+Store$/i, '')
      .replace(/^Brand:\s*/i, '')
      .trim();
  }

  extractRating(): number | undefined {
    for (const product of this.products) {
      const value = this.number(asRecord(product.aggregateRating)?.ratingValue);
      if (value !== undefined && value >= 0 && value <= 5) return value;
    }
    const value = this.number(
      this.meta('ratingValue') ??
        this.text(
          '#acrPopover .a-icon-alt',
          '#averageCustomerReviews .a-icon-alt',
          '[itemprop="ratingValue"]',
        ) ??
        this.document.querySelector('#acrPopover')?.getAttribute('title'),
    );
    return value !== undefined && value >= 0 && value <= 5 ? value : undefined;
  }

  extractReviewCount(): number | undefined {
    for (const product of this.products) {
      const rating = asRecord(product.aggregateRating);
      const value = this.count(rating?.reviewCount ?? rating?.ratingCount);
      if (value !== undefined) return value;
    }
    return this.count(
      this.meta('reviewCount', 'ratingCount') ??
        this.text(
          '#acrCustomerReviewText',
          '#averageCustomerReviews [data-hook="total-review-count"]',
          '[itemprop="reviewCount"]',
        ),
    );
  }

  private readProducts(): PageRecord[] {
    const records: PageRecord[] = [];
    for (const script of this.document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const content = (script.textContent ?? '').trim();
        if (content.length > 2_000_000) continue;
        const data = JSON.parse(content) as unknown;
        records.push(
          ...flattenRecords(data).filter((record) => {
            const type = Array.isArray(record['@type']) ? record['@type'] : [record['@type']];
            return type.some(
              (value) => typeof value === 'string' && /(?:^|[/#])Product$/i.test(value),
            );
          }),
        );
      } catch {
        /* Malformed JSON-LD falls back to metadata and DOM. */
      }
    }
    const asin = this.url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1];
    const matching = records.filter((record) => this.matchesAsin(record, asin));
    // Product recommendation JSON-LD must not contaminate the active product's media.
    return matching.length
      ? matching
      : records.filter((record) => this.recordAsins(record).length === 0);
  }

  private matchesAsin(record: PageRecord, asin?: string): boolean {
    return !!asin && this.recordAsins(record).includes(asin.toUpperCase());
  }

  private recordAsins(record: PageRecord): string[] {
    const ids: string[] = [];
    for (const value of [record.sku, record.productID, record.asin]) {
      const id = cleanText(value)?.replace(/^ASIN:\s*/i, '');
      if (id && ASIN_PATTERN.test(id)) ids.push(id.toUpperCase());
    }
    for (const value of [record.url, record['@id']]) {
      if (typeof value !== 'string') continue;
      const id = value.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1];
      if (id) ids.push(id.toUpperCase());
    }
    return ids;
  }

  private field<T>(name: string, extract: () => T): T | undefined {
    try {
      return extract();
    } catch (error) {
      console.warn(`[ProductSpy] Unable to extract ${name}`, error);
      return undefined;
    }
  }

  private productText(field: string): string | undefined {
    for (const product of this.products) {
      const value = cleanText(product[field]);
      if (value) return value;
    }
    return undefined;
  }

  private meta(...names: string[]): string | undefined {
    for (const name of names) {
      const value = cleanText(
        this.document
          .querySelector(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`)
          ?.getAttribute('content'),
      );
      if (value) return value;
    }
    return undefined;
  }

  private text(...selectors: string[]): string | undefined {
    for (const selector of selectors) {
      const element = this.document.querySelector(selector);
      const copy = element?.cloneNode(true) as Element | undefined;
      copy?.querySelectorAll('script,style,noscript').forEach((node) => node.remove());
      const value = cleanText(element?.getAttribute('content') ?? copy?.textContent);
      if (value) return value;
    }
    return undefined;
  }

  private number(value: unknown): number | undefined {
    const match = cleanText(value)?.match(/\d+(?:[.,]\d+)?/);
    if (!match) return undefined;
    const number = Number(match[0].replace(',', '.'));
    return Number.isFinite(number) ? number : undefined;
  }

  private count(value: unknown): number | undefined {
    const text = cleanText(value)?.match(/[\d][\d\s,.\u00a0]*/)?.[0];
    if (!text) return undefined;
    const number = Number(text.replace(/\D/g, ''));
    return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  }

  private imageSize(value: unknown): number {
    return Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number'
      ? value[0] * value[1]
      : 0;
  }

  private inferCurrency(price: string): string | undefined {
    if (/€/.test(price)) return 'EUR';
    if (/£/.test(price)) return 'GBP';
    if (/₹/.test(price)) return 'INR';
    if (/¥|￥/.test(price))
      return new URL(this.url).hostname.endsWith('amazon.co.jp') ? 'JPY' : undefined;
    if (!/\$/.test(price)) return undefined;
    const hostname = new URL(this.url).hostname;
    if (hostname.endsWith('amazon.ca')) return 'CAD';
    if (hostname.endsWith('amazon.com.au')) return 'AUD';
    if (hostname.endsWith('amazon.sg')) return 'SGD';
    if (hostname.endsWith('amazon.com.mx')) return 'MXN';
    return hostname.endsWith('amazon.com') ? 'USD' : undefined;
  }
}
