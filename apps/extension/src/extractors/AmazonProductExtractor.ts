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
      this.text('#productTitle', '#title_feature_div h1', 'h1.a-size-large') ??
      this.productText('name') ??
      this.meta('og:title', 'twitter:title', 'title')
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
            currency:
              this.inferCurrency(price) ??
              cleanText(record.priceCurrency ?? specification?.priceCurrency),
          };
      }
    }
    const metadataPrice = this.meta('product:price:amount', 'og:price:amount', 'price');
    const metadataCurrency = this.meta(
      'product:price:currency',
      'og:price:currency',
      'priceCurrency',
    );
    if (metadataPrice)
      return {
        price: metadataPrice,
        currency: this.inferCurrency(metadataPrice) ?? metadataCurrency,
      };
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
          currency:
            this.inferCurrency(price) ??
            cleanText(record.currency ?? record.priceCurrency) ??
            metadataCurrency,
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
    return { price, currency: this.inferCurrency(price) ?? metadataCurrency };
  }

  extractAsin(): string | undefined {
    const activeAsin = this.activePageAsin();
    if (activeAsin) return activeAsin;
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
    const aliases = new Map<string, string>();
    const identity = (value: string): string => {
      const key = this.imageIdentity(value);
      const parent = aliases.get(key);
      return parent && parent !== key ? identity(parent) : key;
    };
    const associate = (values: unknown[]): void => {
      const keys = values.flatMap((value) => {
        const url = httpUrl(value, this.url);
        return url ? [identity(url)] : [];
      });
      const first = keys[0];
      if (first) keys.slice(1).forEach((key) => aliases.set(key, first));
    };
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
      if (
        !url ||
        /(?:sprite|logo|play[-_]?icon|360[-_]icon|video[-_]?thumb|\.gif(?:\?|$))/i.test(url)
      )
        return;
      candidates.push({ url, score });
    };
    const addElement = (element: Element, isMain = false): void => {
      if (element.closest('[data-video-url], .videoThumbnail, .video-thumb')) return;
      const urls: { url: unknown; score: number }[] = [
        { url: element.getAttribute('data-old-hires'), score: 300 },
        { url: element.getAttribute('src'), score: 80 },
      ];
      const dynamic = element.getAttribute('data-a-dynamic-image');
      if (dynamic) {
        try {
          const parsed = asRecord(JSON.parse(dynamic) as unknown);
          if (parsed)
            Object.entries(parsed)
              .sort((a, b) => this.imageSize(b[1]) - this.imageSize(a[1]))
              .forEach(([url], index) => urls.push({ url, score: 250 - index }));
        } catch {
          /* A corrupt image attribute does not discard other images. */
        }
      }
      associate(urls.map((item) => item.url));
      urls
        .sort((a, b) => b.score - a.score)
        .some((item) => {
          if (!httpUrl(item.url, this.url)) return false;
          add(item.url, item.score + (isMain ? 100 : 0));
          return true;
        });
    };
    const mainElement = this.document.querySelector(
      '#landingImage, #imgBlkFront, #main-image, #ebooksImgBlkFront',
    );
    if (mainElement) addElement(mainElement, true);
    const mainKeys = new Set(candidates.map((candidate) => this.imageIdentity(candidate.url)));
    this.products.forEach((product) => add(product.image, 150));
    if (!mainKeys.size) add(this.meta('og:image', 'twitter:image'), 140);
    const variationLabels = scriptValues(this.document, ['asinVariationValues']).flatMap(
      (value) => {
        const labels = asRecord(value)?.[this.extractAsin() ?? ''];
        return Array.isArray(labels)
          ? labels.filter((label): label is string => typeof label === 'string')
          : [];
      },
    );
    for (const value of scriptValues(this.document, [
      'colorImages',
      'imageGalleryData',
      'imageData',
    ])) {
      const record = asRecord(value);
      const groups: unknown[] = [];
      const hasCurrentMain = (group: unknown): boolean =>
        flattenRecords(group).some((image) =>
          [image.hiRes, image.large, image.thumb, ...Object.keys(asRecord(image.main) ?? {})].some(
            (url) => typeof url === 'string' && mainKeys.has(identity(url)),
          ),
        );
      if (Array.isArray(value)) groups.push(value);
      else if (record) {
        const initial = record.initial;
        if (initial && (!mainKeys.size || hasCurrentMain(initial))) groups.push(initial);
        const labeled = variationLabels.flatMap((label) =>
          Array.isArray(record[label]) ? [record[label]] : [],
        );
        if (labeled.length) groups.push(...labeled);
        else {
          const matching = Object.values(record).filter(
            (group) => Array.isArray(group) && hasCurrentMain(group),
          );
          if (matching.length) groups.push(...matching);
          else if (!initial && Object.values(record).length === 1)
            groups.push(...Object.values(record));
          else if ('hiRes' in record || 'large' in record || 'main' in record) groups.push(record);
        }
      }
      for (const image of groups.flatMap((group) => flattenRecords(group))) {
        const main = asRecord(image.main);
        const dynamic = Object.entries(main ?? {}).sort(
          (a, b) => this.imageSize(b[1]) - this.imageSize(a[1]),
        );
        associate([image.hiRes, image.large, image.thumb, ...dynamic.map(([url]) => url)]);
        const best = [image.hiRes, dynamic[0]?.[0], image.large].find(
          (url) => httpUrl(url, this.url) !== undefined,
        );
        if (best) add(best, image.hiRes === best ? 300 : 200);
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
        addElement(element, element === mainElement);
      }
    }
    const unique = new Map<string, { url: string; score: number }>();
    for (const candidate of candidates) {
      const key = identity(candidate.url);
      const existing = unique.get(key);
      if (!existing || candidate.score > existing.score) unique.set(key, candidate);
    }
    return [...unique.values()].map((candidate) => candidate.url).slice(0, 100);
  }

  extractVideos(): ProductVideo[] {
    const videos = new Map<string, ProductVideo>();
    const currentAsin = this.extractAsin();
    const identities = new Map<string, boolean>();
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
    // Amazon's a-state JSON binds a rendered player's URL to productAsin/pageAsin.
    // The general videos array can also contain videos for other products or variants.
    for (const script of this.document.querySelectorAll('script[type="a-state"]')) {
      try {
        const text = script.textContent ?? '';
        if (text.length > 2_000_000) continue;
        const data = JSON.parse(text) as unknown;
        for (const record of flattenRecords(data)) {
          const url = httpUrl(record.videoUrl ?? record.url, this.url);
          const asins = this.videoRecordAsins(record);
          if (!url || !asins.length) continue;
          const matching = !!currentAsin && asins.includes(currentAsin);
          identities.set(url, matching || identities.get(url) === true);
          if (matching) add(record.videoUrl ?? record.url, record.imageUrl ?? record.thumbnailUrl);
        }
      } catch {
        /* A malformed player state cannot discard other verified media. */
      }
    }
    for (const value of scriptValues(this.document, ['videos', 'videoData', 'videoGalleryData'])) {
      for (const record of flattenRecords(value)) {
        const value = record.url ?? record.videoUrl ?? record.contentUrl ?? record.mediaUrl;
        const url = httpUrl(value, this.url);
        const asins = this.videoRecordAsins(record);
        if (
          !url ||
          (asins.length
            ? !currentAsin || !asins.includes(currentAsin)
            : identities.get(url) !== true)
        )
          continue;
        add(value, record.thumbnail ?? record.thumbnailUrl ?? record.poster);
      }
    }
    for (const element of this.document.querySelectorAll(
      '#imageBlock video, #imageBlock source, #video-player video, #video-player source, #imageBlock [data-video-url], #video-player [data-video-url]',
    )) {
      const url = httpUrl(
        element.getAttribute('src') ?? element.getAttribute('data-video-url'),
        this.url,
      );
      if (url && identities.get(url) === false) continue;
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
      this.text('#productDescription', '#bookDescription_feature_div') ??
      this.aplusDescription();
    if (!description) return undefined;
    const container = this.document.createElement('div');
    container.innerHTML = description;
    container.querySelectorAll('script,style').forEach((element) => element.remove());
    return cleanText(container.textContent)?.slice(0, 50_000);
  }

  private aplusDescription(): string | undefined {
    const paragraphs: string[] = [];
    // Real pages can contain more than one #aplus: brand navigation comes first.
    for (const element of this.document.querySelectorAll('#aplus .aplus-v2')) {
      if (element.querySelector('.apm-brand-story-carousel-container')) continue;
      const copy = element.cloneNode(true) as Element;
      copy
        .querySelectorAll(
          'script,style,noscript,video,source,button,.video-js,.vjs-control-bar,.vse-player-container,.a-carousel-goto-prevpage,.a-carousel-goto-nextpage,.aplus-carousel-nav,[class*="comparison-table"]',
        )
        .forEach((node) => node.remove());
      const text = cleanText(copy.textContent);
      if (
        text &&
        !/^(?:From the manufacturer|Product Description|来自制造商|商品描述|产品描述)$/i.test(text)
      )
        paragraphs.push(text);
    }
    return cleanText([...new Set(paragraphs)].join('\n'));
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
      this.text('.po-brand .po-break-word', '#bylineInfo', '#brand', '[itemprop="brand"]');
    return brand
      ?.replace(/^Visit the\s+/i, '')
      .replace(/\s+Store$/i, '')
      .replace(/^Besuche den\s+/i, '')
      .replace(/-Store$/i, '')
      .replace(/^Brand:\s*/i, '')
      .replace(/^访问\s*/, '')
      .replace(/\s*(?:品牌旗舰店|商店)$/, '')
      .replace(/^品牌\s*[:：]\s*/, '')
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
    const asin = this.activePageAsin();
    const matching = records.filter((record) => this.matchesAsin(record, asin));
    // Product recommendation JSON-LD must not contaminate the active product's media.
    return matching.length
      ? matching
      : records.filter((record) => this.recordAsins(record).length === 0);
  }

  private activePageAsin(): string | undefined {
    // Amazon's purchase form follows the selected child variant, even while the URL
    // still names its parent. A recommendation's arbitrary data-asin is not authoritative.
    for (const element of this.document.querySelectorAll(
      'input#ASIN, #buybox input[name="ASIN"], #desktop_buybox input[name="ASIN"]',
    )) {
      const value = element.getAttribute('value');
      if (value && ASIN_PATTERN.test(value)) return value.toUpperCase();
    }
    return new URL(this.url).pathname
      .match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1]
      ?.toUpperCase();
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

  private videoRecordAsins(record: PageRecord): string[] {
    const direct = [record.productAsin, record.asin, record.videoAsin].filter(
      (value): value is string => typeof value === 'string' && ASIN_PATTERN.test(value),
    );
    const values = direct.length
      ? direct
      : flattenRecords(record).flatMap((child) => {
          const asin = child.pageAsin;
          return typeof asin === 'string' && ASIN_PATTERN.test(asin) ? [asin] : [];
        });
    return [...new Set(values.map((asin) => asin.toUpperCase()))];
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
    if (!Array.isArray(value)) return 0;
    const width = Number(value[0]);
    const height = Number(value[1]);
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? width * height
      : 0;
  }

  private imageIdentity(url: string): string {
    return url.replace(/\._[^/]*_\.(?=[a-z]{3,4}(?:[?]|$))/i, '.').split('?')[0];
  }

  private inferCurrency(price: string): string | undefined {
    const explicit = price.match(
      /\b(USD|CAD|AUD|SGD|MXN|BRL|TWD|HKD|NZD|EUR|GBP|INR|JPY|AED|SAR|SEK|PLN|TRY|EGP|ZAR|CNY|CHF)\s*(?=[\d$])/i,
    )?.[1];
    if (explicit) return explicit.toUpperCase();
    if (/(?:NT|US|CA|AU|SG|HK|NZ)\s*\$/i.test(price)) {
      const prefix = price.match(/(NT|US|CA|AU|SG|HK|NZ)\s*\$/i)?.[1]?.toUpperCase();
      const currencies: Record<string, string> = {
        NT: 'TWD',
        US: 'USD',
        CA: 'CAD',
        AU: 'AUD',
        SG: 'SGD',
        HK: 'HKD',
        NZ: 'NZD',
      };
      if (prefix) return currencies[prefix];
    }
    if (/R\s*\$/.test(price)) return 'BRL';
    if (/€/.test(price)) return 'EUR';
    if (/£/.test(price)) return 'GBP';
    if (/₹/.test(price)) return 'INR';
    if (/¥|￥/.test(price))
      return new URL(this.url).hostname.endsWith('amazon.co.jp') ? 'JPY' : undefined;
    // A bare dollar symbol is ambiguous: the same storefront can display several
    // buyer-selected currencies. Leave it unknown unless page metadata identifies it.
    return undefined;
  }
}
