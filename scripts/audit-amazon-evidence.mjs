import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Compare the extension's real capture with independently observed DOM / gallery data.
// Raw HTML stays in the ignored evidence directory; this output has only field results.
const directory = resolve(process.argv[2] ?? '.test-data/phase9-evidence/verified');
const input = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8'));
const clean = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
const imageKey = (value) =>
  value?.replace(/\._[^/]*_\.(?=[a-z]{3,4}(?:[?]|$))/i, '.').split('?')[0];
const compare = (actual, expected) =>
  expected === undefined || expected === ''
    ? actual === undefined || actual === ''
      ? 'not-available'
      : 'unverified'
    : actual === expected
      ? 'pass'
      : 'fail';
const rows = [];
for (const [index, row] of input.reports.entries()) {
  const asin = row.requestedUrl.split('/dp/')[1];
  const prefix = `${String(index + 1).padStart(2, '0')}-${new URL(row.requestedUrl).hostname}-${asin}`;
  if (!row.draft) {
    rows.push({ asin, url: row.requestedUrl, category: row.category, outcome: row.outcome });
    continue;
  }
  const draft = row.draft;
  const document = new JSDOM(await readFile(resolve(directory, `${prefix}.html`), 'utf8'), {
    virtualConsole: new VirtualConsole(),
  }).window.document;
  const text = (selector) => clean(document.querySelector(selector)?.textContent);
  const brand = text('.po-brand .po-break-word') || text('#bylineInfo') || text('#brand');
  const expectedBrand = brand
    .replace(/^Visit the\s+/i, '')
    .replace(/\s+Store$/i, '')
    .replace(/^Besuche den\s+/i, '')
    .replace(/-Store$/i, '')
    .replace(/^Brand:\s*/i, '')
    .replace(/^访问\s*/, '')
    .replace(/\s*(?:品牌旗舰店|商店)$/, '')
    .replace(/^品牌\s*[:：]\s*/, '')
    .trim();
  const price = row.dom.prices[0]?.text;
  const currency = price
    ?.match(/\b(USD|CAD|AUD|TWD|EUR|GBP|JPY|INR)(?=[\d$])/i)?.[1]
    ?.toUpperCase();
  const expectedRating = Number(row.dom.rating.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
  const expectedCount = Number(
    row.dom.reviewCount.match(/[\d][\d\s,.\u00a0]*/)?.[0]?.replace(/\D/g, ''),
  );
  const scripts = [...document.querySelectorAll('script')].map((node) => node.textContent ?? '');
  const galleries = scripts.flatMap((script) =>
    [
      ...script.matchAll(/['"]initial['"]\s*:\s*A\.\$\.parseJSON\(\s*'((?:\\.|[^'\\])*)'\s*\)/g),
    ].flatMap((match) => {
      try {
        const gallery = JSON.parse(match[1].replace(/\\([\\/'"])/g, '$1'));
        return Array.isArray(gallery) ? [gallery] : [];
      } catch {
        return [];
      }
    }),
  );
  const gallery = galleries.find((items) =>
    items.some((item) =>
      [item.hiRes, item.large, item.thumb].some(
        (url) => imageKey(url) === imageKey(row.dom.mainImage),
      ),
    ),
  );
  const productGallery = gallery?.filter(
    (item) =>
      typeof (item.hiRes ?? item.large) === 'string' &&
      !/(?:360[-_]icon|play[-_]?icon|sprite|logo|\.gif)/i.test(item.hiRes ?? item.large),
  );
  const expectedImages = productGallery?.map((item) => item.hiRes ?? item.large);
  const galleryComplete = expectedImages?.every((url) =>
    draft.images.some((image) => imageKey(image) === imageKey(url)),
  );
  const galleryOnly =
    productGallery &&
    draft.images.every((image) =>
      productGallery.some((item) =>
        [item.hiRes, item.large, item.thumb, ...Object.keys(item.main ?? {})].some(
          (url) => imageKey(url) === imageKey(image),
        ),
      ),
    );
  const bestImage = (item) =>
    item.hiRes ??
    Object.entries(item.main ?? {}).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0]?.[0] ??
    item.large;
  const highResolution =
    productGallery &&
    draft.images.every((image) => productGallery.some((item) => image === bestImage(item)));
  const videoBindings = new Map();
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value.videoUrl === 'string') {
      const linkedAsin =
        value.productAsin ?? value.asin ?? value.videoAsin ?? value.nexusMetricsConfig?.pageAsin;
      if (typeof linkedAsin === 'string')
        videoBindings.set(value.videoUrl, linkedAsin.toUpperCase());
    }
    Object.values(value).forEach(walk);
  };
  for (const state of document.querySelectorAll('script[type="a-state"]')) {
    try {
      walk(JSON.parse(state.textContent ?? ''));
    } catch {
      /* incomplete state */
    }
  }
  const scopedUrls = new Set(
    [
      ...document.querySelectorAll(
        '#imageBlock video,#imageBlock source,#video-player video,#video-player source,#imageBlock [data-video-url],#video-player [data-video-url]',
      ),
    ].map((node) => node.getAttribute('src') ?? node.getAttribute('data-video-url')),
  );
  const boundVideos = [...videoBindings].filter(([, id]) => id === draft.sourceId);
  const videoCorrect = draft.videos.every(
    ({ url }) =>
      videoBindings.get(url) === draft.sourceId ||
      (scopedUrls.has(url) &&
        videoBindings.get(url) !== undefined &&
        videoBindings.get(url) === draft.sourceId),
  );
  const fields = {
    asin: compare(draft.sourceId, row.dom.asin),
    title: compare(draft.title, row.dom.title),
    price: compare(draft.price, price),
    currency: price ? compare(draft.currency, currency) : 'not-available',
    brand: compare(draft.brand, expectedBrand),
    mainImage: compare(imageKey(draft.mainImage), imageKey(row.dom.mainImage)),
    gallery: !productGallery
      ? 'unverified'
      : galleryComplete &&
          galleryOnly &&
          new Set(draft.images.map(imageKey)).size === draft.images.length
        ? 'pass'
        : 'fail',
    highResolution: !productGallery ? 'unverified' : highResolution ? 'pass' : 'fail',
    bulletPoints: compare(
      JSON.stringify(draft.bulletPoints),
      JSON.stringify(
        row.dom.bulletPoints.length
          ? row.dom.bulletPoints
          : [...document.querySelectorAll('#productFactsDesktopExpander li')]
              .map((node) => clean(node.textContent))
              .filter(Boolean),
      ),
    ),
    rating: compare(draft.rating, Number.isFinite(expectedRating) ? expectedRating : undefined),
    reviewCount: compare(
      draft.reviewCount,
      Number.isFinite(expectedCount) ? expectedCount : undefined,
    ),
    videos: draft.videos.length
      ? videoCorrect
        ? 'pass'
        : 'unverified'
      : boundVideos.length
        ? 'fail'
        : 'not-available',
    mainImageHttp:
      row.mainImageHttp?.status === 200 && row.mainImageHttp.contentType?.startsWith('image/')
        ? 'pass'
        : 'fail',
    description: draft.description ? 'requires-content-review' : 'not-available',
  };
  rows.push({
    asin: draft.sourceId,
    url: row.requestedUrl,
    category: row.category,
    capturedAt: row.capturedAt,
    httpStatus: row.httpStatus,
    outcome: row.outcome,
    challenge: row.challenge,
    price: draft.price ?? null,
    currency: draft.currency ?? null,
    brand: draft.brand ?? null,
    images: draft.images.length,
    videos: draft.videos.length,
    bullets: draft.bulletPoints.length,
    rating: draft.rating,
    reviewCount: draft.reviewCount,
    descriptionCharacters: draft.description?.length ?? 0,
    independentGalleryCount: productGallery?.length ?? null,
    fields,
  });
}
const fields = [...new Set(rows.flatMap((row) => Object.keys(row.fields ?? {})))];
const counts = Object.fromEntries(
  fields.map((field) => [
    field,
    Object.fromEntries(
      ['pass', 'fail', 'unverified', 'not-available', 'requires-content-review'].map((status) => [
        status,
        rows.filter((row) => row.fields?.[field] === status).length,
      ]),
    ),
  ]),
);
const audit = { realPages: true, mock: false, auditedAt: new Date().toISOString(), counts, rows };
await writeFile(resolve(directory, 'audit.json'), JSON.stringify(audit, null, 2));
console.log(JSON.stringify({ counts, evidence: resolve(directory, 'audit.json') }, null, 2));
