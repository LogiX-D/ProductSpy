import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Read-only audit of a fresh real-page capture. Raw HTML/profile/session details remain ignored.
// This never navigates, saves products, downloads media, calls AI, or modifies frozen files.
const directory = resolve(process.argv[2] ?? '.test-data/final-quality/amazon/current');
const evidenceRoot = resolve('.test-data/final-quality/amazon');
if (!directory.startsWith(`${evidenceRoot}${sep}`))
  throw new Error('Use a dedicated final-quality Amazon evidence subdirectory');
const bytes = await readFile(resolve(directory, 'report.json'));
const input = JSON.parse(bytes.toString('utf8'));
if (!input.realPages || input.mock || input.releaseVersion !== '1.0.0')
  throw new Error('This audit requires actual frozen v1.0.0 real-page evidence');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
const bundle = resolve('artifacts/ProductSpy-1.0.0-windows-x64');
const manifestBytes = await readFile(resolve(bundle, 'bundle-manifest.json'));
const bundleManifest = JSON.parse(manifestBytes.toString('utf8'));
const frozenFiles = [];
for (const item of bundleManifest.files.filter((entry) => entry.path.startsWith('extension/'))) {
  const actual = await readFile(resolve(bundle, item.path));
  if (actual.length !== item.bytes || hash(actual) !== item.sha256)
    throw new Error(`Frozen extension integrity mismatch: ${item.path}`);
  frozenFiles.push({ path: item.path, bytes: item.bytes, sha256: item.sha256 });
}
if (frozenFiles.length < 3) throw new Error('Frozen extension manifest records are missing');

execFileSync(process.execPath, ['scripts/audit-amazon-evidence.mjs', directory], {
  stdio: 'pipe',
});
const auditBytes = await readFile(resolve(directory, 'audit.json'));
const audit = JSON.parse(auditBytes.toString('utf8'));
const rows = [];
for (const [index, raw] of input.reports.entries()) {
  const fields = { ...audit.rows[index]?.fields };
  const row = {
    category: raw.category,
    label: raw.label,
    kind: raw.kind,
    requestedUrl: raw.requestedUrl,
    countryHost: new URL(raw.requestedUrl).hostname,
    capturedAt: raw.capturedAt,
    httpStatus: raw.httpStatus ?? null,
    originalCaptureOutcome: raw.outcome,
    status: raw.outcome === 'captured' ? 'CAPTURED' : 'BLOCKED',
    challenge: raw.challenge ?? null,
    fields,
    publicValues: raw.draft
      ? {
          asin: raw.draft.sourceId,
          title: raw.draft.title,
          price: raw.draft.price ?? null,
          currency: raw.draft.currency ?? null,
          brand: raw.draft.brand ?? null,
          images: raw.draft.images.length,
          videos: raw.draft.videos.length,
          bulletPoints: raw.draft.bulletPoints.length,
          rating: raw.draft.rating ?? null,
          reviewCount: raw.draft.reviewCount ?? null,
          descriptionCharacters: raw.draft.description?.length ?? 0,
        }
      : null,
    repeatCapture: raw.repeatCapture ?? null,
    variationInteraction: raw.variationInteraction ?? null,
    sourceHashes: {
      html: raw.htmlSha256 ?? null,
      screenshot: raw.screenshotSha256 ?? null,
    },
    mediaChecks: {
      mainImage: raw.mainImageHttp
        ? {
            status: raw.mainImageHttp.status ?? null,
            contentType: raw.mainImageHttp.contentType ?? null,
            failed: !!raw.mainImageHttp.error,
          }
        : null,
      videos: (raw.videoNetwork ?? []).map((video) => ({
        urlSha256: hash(video.url),
        host: new URL(video.url).hostname,
        status: video.status ?? null,
        contentType: video.contentType ?? null,
        failed: !!video.error,
        playback: 'NOT_EXECUTED',
      })),
    },
  };
  if (raw.draft) {
    const prefix = `${String(index + 1).padStart(2, '0')}-${row.countryHost}-${raw.requestedUrl.split('/dp/')[1]}`;
    const dom = new JSDOM(await readFile(resolve(directory, `${prefix}.html`), 'utf8'), {
      virtualConsole: new VirtualConsole(),
    });
    try {
      const document = dom.window.document;
      const authorByline = !!document.querySelector('#bylineInfo .author');
      const explicitBrand = document.querySelector(
        'meta[name="brand"],meta[property="product:brand"],.po-brand .po-break-word,#brand,[itemprop="brand"]',
      );
      if (authorByline && !explicitBrand) {
        fields.brand = raw.draft.brand ? 'fail' : 'not-available';
        row.brandNote = 'Author/format byline is not an explicit product brand.';
      }
      const price = raw.dom?.prices[0]?.text;
      const explicitCurrency = price
        ?.match(/\b(USD|CAD|AUD|TWD|EUR|GBP|JPY|INR)\s*(?=[\d$])/i)?.[1]
        ?.toUpperCase();
      const symbolCurrency = price?.includes('€')
        ? 'EUR'
        : price?.includes('£')
          ? 'GBP'
          : /[¥￥]/.test(price ?? '') && row.countryHost.endsWith('amazon.co.jp')
            ? 'JPY'
            : null;
      if (explicitCurrency ?? symbolCurrency)
        fields.currency =
          raw.draft.currency === (explicitCurrency ?? symbolCurrency) ? 'pass' : 'fail';
      if (!raw.draft.bulletPoints.length && !raw.dom.bulletPoints.length && !raw.dom.facts.length)
        fields.bulletPoints = 'not-available';
      const description = clean(raw.draft.description);
      const visibleDescriptions = (raw.dom?.descriptions ?? [])
        .map((entry) => clean(entry.contentVisibleText ?? entry.visibleText))
        .filter(Boolean);
      row.descriptionEvidence = {
        observedVisibleSections: visibleDescriptions.length,
        capturedTextContainedInVisibleSection: description
          ? visibleDescriptions.some((text) => text.includes(description))
          : null,
        merchantClaimsIndependentlyVerified: false,
      };
      if (description && row.descriptionEvidence.capturedTextContainedInVisibleSection)
        fields.description = 'pass';
      row.urlDeduplication = {
        exactUnique: new Set(raw.draft.images).size === raw.draft.images.length,
        metadataBoundToAsin: raw.draft.mediaMetadata.every(
          (entry) => entry.productSourceId === raw.draft.sourceId,
        ),
      };
      row.videoNote = raw.draft.videos.length
        ? 'ASIN binding audited separately from HEAD accessibility; playback/decoding remains unverified.'
        : 'No reliable video URL was extracted at this instant; this does not prove no video exists.';
      row.confirmedFieldFailures = Object.entries(fields)
        .filter(([, status]) => status === 'fail')
        .map(([field]) => field);
    } finally {
      dom.window.close();
    }
  } else {
    row.reason = raw.outcome.startsWith('not-attempted')
      ? 'Host stopped after access verification; no repeated navigation or bypass.'
      : raw.outcome === 'challenge'
        ? 'Amazon access verification; not bypassed.'
        : 'Public page navigation/capture did not complete within a bounded timeout; raw error stays local.';
  }
  rows.push(row);
}
const selected = rows.filter((row) => row.kind === 'primary');
const captured = rows.filter((row) => row.status === 'CAPTURED');
const fieldNames = [...new Set(captured.flatMap((row) => Object.keys(row.fields)))];
const fieldCounts = Object.fromEntries(
  fieldNames.map((field) => [
    field,
    Object.fromEntries(
      ['pass', 'fail', 'unverified', 'not-available', 'requires-content-review'].map((status) => [
        status,
        captured.filter((row) => row.fields[field] === status).length,
      ]),
    ),
  ]),
);
const report = {
  schemaVersion: 1,
  release: '1.0.0',
  evidenceType: 'REAL_PUBLIC_AMAZON_CFT_AUTOMATION',
  startedAt: input.startedAt,
  completedAt: input.completedAt,
  auditedAt: new Date().toISOString(),
  clientTimezone: 'Asia/Shanghai',
  browser: input.browser,
  command:
    'node scripts/phase16-amazon-capture.mjs --phase 21 --extension artifacts/ProductSpy-1.0.0-windows-x64/extension --output .test-data/final-quality/amazon/current',
  auditCommand: `node scripts/final-quality-amazon.mjs ${relative(process.cwd(), directory).replaceAll('\\', '/')}`,
  counts: {
    primaryPlanned: selected.length,
    primaryNavigationsAttempted: selected.filter(
      (row) => !row.originalCaptureOutcome.startsWith('not-attempted'),
    ).length,
    primaryCaptured: selected.filter((row) => row.status === 'CAPTURED').length,
    primaryBlockedOrNotAttempted: selected.filter((row) => row.status === 'BLOCKED').length,
    visibleVariantsCaptured: captured.filter((row) => row.kind === 'visible-variant').length,
    uniqueCapturedAsins: new Set(captured.map((row) => row.publicValues.asin)).size,
    plannedCategories: [...new Set(selected.map((row) => row.category))],
    capturedCategories: [...new Set(captured.map((row) => row.category))],
    plannedCountryHosts: [...new Set(selected.map((row) => row.countryHost))],
    capturedCountryHosts: [...new Set(captured.map((row) => row.countryHost))],
    fields: fieldCounts,
  },
  frozenExtension: {
    bundleManifestSha256: hash(manifestBytes),
    verifiedFiles: frozenFiles,
  },
  evidenceHashes: { captureReport: hash(bytes), independentAudit: hash(auditBytes) },
  boundaries: [
    'Direct ordinary public navigation in a fresh isolated Chrome for Testing profile, not native stable Chrome toolbar acceptance.',
    'No CAPTCHA solving, account login, request interception, response substitution or navigation retry; host stops on verification.',
    'Visible merchant text/data comparison does not independently validate merchant claims or real customer review bodies.',
    'Missing fields are unknown, not fabricated; unavailable values are excluded from field successes.',
    'Raw HTML, captured URLs and browser profiles remain ignored; sanitized output includes no session headers or credentials.',
    'Media HEAD/GET accessibility does not prove complete download, playback or decode success.',
    'Repeated extraction and variant checks make no product-library write; duplicate upsert/persistence is covered elsewhere.',
    'No AI requests or library saves. Normal read-only Popup workspace status checks may occur.',
  ],
  rows,
};
const output = resolve(directory, 'sanitized-results.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, counts: report.counts }, null, 2));
