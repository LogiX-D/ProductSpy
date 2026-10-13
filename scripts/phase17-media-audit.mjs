import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Offline audit of retained real-page evidence. Never executes page scripts or requests media.
// Only hashes, public ASINs, counts and verdicts are published; profiles and raw HTML stay ignored.
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const evidence = resolve(argument('--evidence', '.test-data/phase17-amazon/acceptance'));
const output = resolve(argument('--output', 'docs/phase17/media-metadata-results.json'));
const reportBytes = await readFile(resolve(evidence, 'report.json'));
const report = JSON.parse(reportBytes.toString('utf8'));
if (report.realPages !== true || report.mock !== false || report.phase !== 17)
  throw new Error('Expected Phase 17 evidence captured from real Amazon pages, not a fixture');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => value?.replace(/[\s\u00a0]+/g, ' ').trim() ?? '';
const decodeSource = (value) =>
  value
    .replace(/\\u([a-f0-9]{4})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([a-f0-9]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\([/\\'"])/g, '$1')
    .replace(/&amp;/g, '&');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function absolute(value, base) {
  if (!value) return undefined;
  try {
    const url = new URL(value.replaceAll('&amp;', '&'), base);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function identity(value) {
  try {
    const url = new URL(value);
    // Image identities are compared only for attribution; this never creates a downloadable URL.
    return `${url.hostname}${url.pathname.replace(/\._[^.]*_\.(\w+)$/, '.$1')}`;
  } catch {
    return value;
  }
}
function counted(items, status) {
  return items.filter((item) => item === status).length;
}
const ownedImageSelector =
  '#landingImage, #imgBlkFront, #main-image, #ebooksImgBlkFront, #altImages img, #imageBlock img.a-dynamic-image';
const ownedTableSelector =
  '#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, #productDetails_detailBullets_sections1 tr';
const rows = [];
for (const [index, capture] of report.reports.entries()) {
  const requested = new URL(capture.requestedUrl);
  const requestedAsin = requested.pathname.match(/\/dp\/([A-Z0-9]{10})/i)?.[1];
  if (!requestedAsin) throw new Error('Retained evidence URL lacks an ASIN');
  const filename = `${String(index + 1).padStart(2, '0')}-${requested.hostname}-${requestedAsin}.html`;
  const htmlBytes = await readFile(resolve(evidence, filename));
  const sourceMatches = capture.htmlSha256 === hash(htmlBytes);
  if (!sourceMatches) throw new Error(`Evidence hash mismatch at row ${index + 1}`);
  const html = htmlBytes.toString('utf8');
  const dom = new JSDOM(html, {
    url: capture.pageUrl ?? capture.requestedUrl,
    virtualConsole: new VirtualConsole(),
  });
  const document = dom.window.document;
  const challenge = Boolean(
    document.querySelector('form[action*="validateCaptcha" i], #captchacharacters'),
  );
  const row = {
    index: index + 1,
    kind: capture.kind,
    category: capture.category,
    countryHost: requested.hostname,
    requestedAsin,
    asin: capture.draft?.sourceId ?? null,
    outcome: capture.outcome,
    challengePresentInRetainedHtml: challenge,
    capturedAt: capture.capturedAt,
    htmlSha256: hash(htmlBytes),
    verifiedEvidenceIntegrity: sourceMatches,
  };
  if (!capture.draft) {
    rows.push({
      ...row,
      metadata: null,
      specifications: null,
      reason: challenge
        ? 'Amazon verification page; no bypass attempted. Metadata could not be collected.'
        : 'Capture did not produce a product; metadata could not be audited.',
    });
    dom.window.close();
    continue;
  }
  const product = capture.draft;
  const ownedIdentities = new Set();
  const mainIdentities = new Set();
  const domDimensions = new Map();
  const domUrls = new Set();
  for (const element of document.querySelectorAll(ownedImageSelector)) {
    const sources = [element.getAttribute('src'), element.getAttribute('data-old-hires')];
    let dynamic = {};
    try {
      dynamic = JSON.parse(element.getAttribute('data-a-dynamic-image') ?? '{}');
    } catch {
      /* Unknown dimensions remain unknown. */
    }
    for (const [value, size] of Object.entries(dynamic)) {
      const url = absolute(value, product.url);
      if (!url) continue;
      sources.push(url);
      if (
        Array.isArray(size) &&
        size.length === 2 &&
        size.every((number) => Number.isInteger(number) && number > 0 && number <= 30000)
      )
        domDimensions.set(url, size);
    }
    for (const value of sources) {
      const url = absolute(value, product.url);
      if (!url) continue;
      domUrls.add(url);
      ownedIdentities.add(identity(url));
      if (element.matches('#landingImage, #imgBlkFront, #main-image, #ebooksImgBlkFront'))
        mainIdentities.add(identity(url));
    }
  }
  const decodedHtml = decodeSource(html);
  const decodedScripts = [...document.querySelectorAll('script')]
    .map((script) => decodeSource(script.textContent ?? ''))
    .join('\n');
  const declaredImageIdentities = new Set(product.images.map(identity));
  const declaredVideoUrls = new Set(product.videos.map((video) => video.url));
  const entries = (product.mediaMetadata ?? []).map((asset) => {
    const urlInPage =
      domUrls.has(asset.url) ||
      decodedHtml.includes(asset.url) ||
      decodedScripts.includes(asset.url);
    const source = new URL(asset.sourceUrl);
    const sourceAsin = source.pathname.match(/\/dp\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
    const ownerMatches =
      asset.productSourceId === product.sourceId &&
      sourceAsin === product.sourceId &&
      source.hostname === new URL(product.url).hostname;
    const milliseconds = Date.parse(asset.extractedAt);
    const timeMatches =
      Number.isFinite(milliseconds) &&
      milliseconds >= Date.parse(report.startedAt) &&
      milliseconds <= Date.parse(report.completedAt) &&
      milliseconds >= Date.parse(capture.capturedAt) - 1000 &&
      milliseconds <= Date.parse(capture.capturedAt) + 30000;
    const hasDimensions = asset.width !== undefined || asset.height !== undefined;
    let dimensions = hasDimensions ? 'unverified' : 'not-collected';
    let dimensionSource = null;
    if (hasDimensions) {
      const explicit = domDimensions.get(asset.url);
      if (explicit) {
        dimensions = explicit[0] === asset.width && explicit[1] === asset.height ? 'pass' : 'fail';
        dimensionSource = 'current-image DOM data-a-dynamic-image';
      } else {
        const pattern = new RegExp(
          `["']${escapeRegex(asset.url)}["']\\s*:\\s*\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]`,
        );
        const match = decodedScripts.match(pattern);
        if (match) {
          dimensions =
            Number(match[1]) === asset.width && Number(match[2]) === asset.height ? 'pass' : 'fail';
          dimensionSource =
            'literal URL/dimension pair in retained page script (does not prove current-variant ownership)';
        }
      }
    }
    let attribution = 'unverified';
    let attributionReason =
      'URL exists in captured page data, but current-ASIN media ownership needs visual or explicit per-video evidence.';
    if (asset.kind === 'image') {
      const key = identity(asset.url);
      if (mainIdentities.has(key)) {
        attribution = 'pass';
        attributionReason = 'Matches current main-image identity in retained DOM.';
      } else if (capture.kind !== 'visible-variant' && ownedIdentities.has(key)) {
        attribution = 'pass';
        attributionReason =
          'Matches the current product image gallery DOM; no recommendation table scanned.';
      } else if (capture.kind === 'visible-variant') {
        attributionReason =
          'Non-primary gallery images after a live variant click may retain initial gallery data; exact child-variant appearance not verified.';
      }
      if (!declaredImageIdentities.has(key)) {
        attribution = 'fail';
        attributionReason = 'Metadata image identity is absent from extracted product images.';
      }
    } else if (!declaredVideoUrls.has(asset.url)) {
      attribution = 'fail';
      attributionReason = 'Video metadata is absent from the product video list.';
    }
    return {
      urlSha256: hash(asset.url),
      kind: asset.kind,
      declaredFormat:
        asset.kind === 'image'
          ? 'image'
          : /\.m3u8(?:\?|$)/i.test(asset.url)
            ? 'hls'
            : /\.mp4(?:\?|$)/i.test(asset.url)
              ? 'mp4'
              : /\.webm(?:\?|$)/i.test(asset.url)
                ? 'webm'
                : 'unknown',
      urlPresentInRetainedPage: urlInPage ? 'pass' : 'unverified',
      ownerMetadata: ownerMatches ? 'pass' : 'fail',
      extractionTime: timeMatches ? 'pass' : 'fail',
      dimensionMetadata: dimensions,
      dimensionSource,
      width: asset.width ?? null,
      height: asset.height ?? null,
      currentAsinContentAttribution: attribution,
      attributionReason,
    };
  });
  const ownedSpecs = [];
  for (const tableRow of document.querySelectorAll(ownedTableSelector)) {
    const cells = tableRow.querySelectorAll('th, td');
    const name = clean(cells[0]?.textContent)
      .replace(/[:：]$/, '')
      .trim();
    const value = clean(cells[1]?.textContent);
    if (name && value)
      ownedSpecs.push({
        name,
        value,
        tableId:
          tableRow.closest('table')?.id || tableRow.closest('[id]')?.id || 'owned-product-table',
      });
  }
  const specs = (product.specifications ?? []).map((specification) => {
    const evidence = ownedSpecs.find(
      (value) => value.name === specification.name && value.value === specification.value,
    );
    return {
      nameSha256: hash(specification.name),
      valueSha256: hash(specification.value),
      pageCellMatch: evidence ? 'pass' : 'unverified',
      sourceLabel: specification.source === 'page' ? 'pass' : 'fail',
      ownerTable: evidence?.tableId ?? null,
      independentlyConfirmedAccuracy: 'not-performed',
    };
  });
  rows.push({
    ...row,
    metadata: {
      total: entries.length,
      images: entries.filter((asset) => asset.kind === 'image').length,
      videos: entries.filter((asset) => asset.kind === 'video').length,
      uniqueUrlHashes: new Set(entries.map((asset) => asset.urlSha256)).size,
      baseImagesCovered: product.images.every((url) =>
        entries.some((asset) => asset.kind === 'image' && asset.urlSha256 === hash(url)),
      ),
      baseVideosCovered: product.videos.every((video) =>
        entries.some((asset) => asset.kind === 'video' && asset.urlSha256 === hash(video.url)),
      ),
      entries,
    },
    specifications: {
      count: specs.length,
      status: specs.length
        ? specs.every((spec) => spec.pageCellMatch === 'pass' && spec.sourceLabel === 'pass')
          ? 'pass'
          : 'unverified'
        : 'not-collected',
      entries: specs,
      semanticBoundary:
        'Merchant-listed specifications matched against owned product-table text, not independent measurements or functionality verification.',
    },
  });
  dom.window.close();
}
const entries = rows.flatMap((row) => row.metadata?.entries ?? []);
const specifications = rows.flatMap((row) => row.specifications?.entries ?? []);
const statusCounts = (field) =>
  Object.fromEntries(
    ['pass', 'fail', 'unverified', 'not-collected'].map((status) => [
      status,
      counted(
        entries.map((entry) => entry[field]),
        status,
      ),
    ]),
  );
const result = {
  schemaVersion: 1,
  phase: 17,
  version: report.extensionVersion,
  auditedAt: new Date().toISOString(),
  realPages: true,
  mock: false,
  method:
    'Independent offline inspection of retained real Amazon DOM/script literals; JSDOM does not execute scripts or load resources.',
  reportSha256: hash(reportBytes),
  browser: report.browser,
  counts: {
    primaryNavigations: rows.filter((row) => row.kind === 'primary').length,
    primaryCaptured: rows.filter((row) => row.kind === 'primary' && row.metadata).length,
    normalVariantCaptures: rows.filter((row) => row.kind === 'visible-variant' && row.metadata)
      .length,
    capturedRows: rows.filter((row) => row.metadata).length,
    uniqueAsins: new Set(rows.filter((row) => row.asin).map((row) => row.asin)).size,
    challengedRows: rows.filter((row) => row.challengePresentInRetainedHtml).length,
    metadataEntries: entries.length,
    dimensionEntries: entries.filter((entry) => entry.width !== null || entry.height !== null)
      .length,
    specificationEntries: specifications.length,
  },
  fieldResults: {
    urlPresentInRetainedPage: statusCounts('urlPresentInRetainedPage'),
    ownerMetadata: statusCounts('ownerMetadata'),
    extractionTime: statusCounts('extractionTime'),
    dimensionMetadata: statusCounts('dimensionMetadata'),
    currentAsinContentAttribution: statusCounts('currentAsinContentAttribution'),
    specificationPageCells: {
      pass: counted(
        specifications.map((spec) => spec.pageCellMatch),
        'pass',
      ),
      unverified: counted(
        specifications.map((spec) => spec.pageCellMatch),
        'unverified',
      ),
      independentlyMeasured: 0,
    },
  },
  limitations: [
    'No image/video bytes were fetched by this audit. Dimension metadata is page-declared information, not a verified decoded image resolution.',
    'Source URL/ASIN metadata consistency does not by itself prove that every gallery image or video depicts the selected child variant.',
    'Non-primary images after live variant clicks and media without explicit current-product ownership remain unverified.',
    'Retained page-table specifications are merchant information. This audit does not confirm the truth of hardware, material, performance or effect claims.',
    'HLS recognition is only resource-type identification; playback and downloadability were not tested.',
    'Formal Chrome Stable manual acceptance, operating-system dialogs and real AI quality are outside this offline audit.',
  ],
  networkRequestsMade: 0,
  aiRequestsMade: 0,
  rows,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({ output, counts: result.counts, fieldResults: result.fieldResults }, null, 2),
);
if (
  entries.some(
    (entry) =>
      entry.ownerMetadata === 'fail' ||
      entry.extractionTime === 'fail' ||
      entry.dimensionMetadata === 'fail' ||
      entry.currentAsinContentAttribution === 'fail',
  )
)
  process.exitCode = 1;
