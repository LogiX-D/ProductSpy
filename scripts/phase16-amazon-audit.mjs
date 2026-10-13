import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

// Publish field verdicts / hashes only. Raw HTML, browser profiles and captured drafts stay ignored.
const outputIndex = process.argv.indexOf('--output');
const output = resolve(
  outputIndex >= 0 ? process.argv[outputIndex + 1] : 'docs/phase16/amazon-results.json',
);
const directories = process.argv
  .slice(2, outputIndex >= 0 ? outputIndex : undefined)
  .map((path) => resolve(path));
if (!directories.length) throw new Error('Provide at least one real capture evidence directory');
const clean = (value) => value?.replace(/\s+/g, ' ').trim() ?? '';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const rows = [];
const batches = [];

for (const directory of directories) {
  execFileSync(process.execPath, ['scripts/audit-amazon-evidence.mjs', directory], {
    cwd: resolve('.'),
    stdio: 'pipe',
  });
  const reportBytes = await readFile(resolve(directory, 'report.json'));
  const auditBytes = await readFile(resolve(directory, 'audit.json'));
  const report = JSON.parse(reportBytes.toString('utf8'));
  const audit = JSON.parse(auditBytes.toString('utf8'));
  batches.push({
    extensionVersion: report.extensionVersion,
    browser: report.browser,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    evidenceDirectory: relative(resolve('.'), directory).replaceAll('\\', '/'),
    reportSha256: hash(reportBytes),
    auditSha256: hash(auditBytes),
    primaryAttempted: report.reports.filter(
      (row) => row.kind === 'primary' && !row.outcome.startsWith('not-attempted'),
    ).length,
    primaryCaptured: report.reports.filter(
      (row) => row.kind === 'primary' && row.outcome === 'captured',
    ).length,
    variantsCaptured: report.reports.filter(
      (row) => row.kind === 'visible-variant' && row.outcome === 'captured',
    ).length,
  });
  for (const [index, raw] of report.reports.entries()) {
    const audited = audit.rows[index];
    const fields = { ...audited?.fields };
    const row = {
      extensionVersion: report.extensionVersion,
      category: raw.category,
      label: raw.label,
      kind: raw.kind,
      url: raw.requestedUrl,
      finalPublicProductUrl: raw.draft?.url ?? null,
      asin: raw.draft?.sourceId ?? null,
      title: raw.draft?.title ?? null,
      capturedAt: raw.capturedAt,
      httpStatus: raw.httpStatus ?? null,
      outcome: raw.outcome,
      challenge: raw.challenge ?? null,
      price: raw.draft?.price ?? null,
      currency: raw.draft?.currency ?? null,
      brand: raw.draft?.brand ?? null,
      images: raw.draft?.images?.length ?? null,
      videos: raw.draft?.videos?.length ?? null,
      bullets: raw.draft?.bulletPoints?.length ?? null,
      rating: raw.draft?.rating ?? null,
      reviewCount: raw.draft?.reviewCount ?? null,
      descriptionCharacters: raw.draft?.description?.length ?? 0,
      variationInteraction: raw.variationInteraction ?? { status: 'not-performed' },
      repeatCapture: raw.repeatCapture ?? null,
      fields,
      screenshotRecorded: !!raw.screenshotSha256,
      evidenceHashes: {
        htmlSha256: raw.htmlSha256 ?? null,
        screenshotSha256: raw.screenshotSha256 ?? null,
      },
      videoNetwork: (raw.videoNetwork ?? []).map((video) => ({
        urlSha256: hash(video.url),
        publicHost: new URL(video.url).hostname,
        status: video.status ?? null,
        contentType: video.contentType ?? null,
        error: video.error ? 'Network request failed; details remain in ignored evidence' : null,
        playback: 'not-performed',
      })),
    };
    if (raw.error)
      row.failureReason =
        raw.outcome === 'navigation-or-capture-error'
          ? 'Direct navigation or capture failed within bounded timeout; no protection bypass or retry'
          : 'Capture failed; technical details remain in ignored evidence';
    if (raw.draft) {
      const prefix = `${String(index + 1).padStart(2, '0')}-${new URL(raw.requestedUrl).hostname}-${raw.requestedUrl.split('/dp/')[1]}`;
      const document = new JSDOM(await readFile(resolve(directory, `${prefix}.html`), 'utf8'), {
        virtualConsole: new VirtualConsole(),
      }).window.document;
      const authorByline = !!document.querySelector('#bylineInfo .author');
      const explicitBrand = document.querySelector(
        'meta[name="brand"],meta[property="product:brand"],.po-brand .po-break-word,#brand,[itemprop="brand"]',
      );
      if (authorByline && !explicitBrand) {
        fields.brand = raw.draft.brand ? 'fail' : 'not-available';
        row.brandObservation =
          'Visible author / format byline is not a product brand; no explicit brand was observed';
      }
      const price = raw.dom?.prices[0]?.text;
      const explicitCurrency = price
        ?.match(/\b(USD|CAD|AUD|TWD|EUR|GBP|JPY|INR)\s*(?=[\d$])/i)?.[1]
        ?.toUpperCase();
      if (explicitCurrency)
        fields.currency = raw.draft.currency === explicitCurrency ? 'pass' : 'fail';
      // Matching an empty collection proves no data was collected, not successful coverage.
      if (!raw.draft.bulletPoints.length && !raw.dom.bulletPoints.length && !raw.dom.facts.length)
        fields.bulletPoints = 'not-available';
      const description = clean(raw.draft.description);
      const observedDescriptions = (raw.dom?.descriptions ?? []).map((entry) =>
        clean(entry.contentVisibleText ?? entry.visibleText),
      );
      const matched =
        description && observedDescriptions.some((source) => source.includes(description));
      row.descriptionObservation = {
        visibleSources: observedDescriptions.length,
        visibleTextSubstringMatch: description ? !!matched : null,
        contentClaimsVerified: false,
        status: description ? 'requires-content-review' : 'not-available',
      };
      const descriptionBoundaryDefect =
        raw.label === 'Atomic Habits' &&
        /bestseller\.Over|ResultsNo matter|how to:make time/.test(description);
      const descriptionControlDefect =
        raw.label === 'Atomic Habits' && /阅读更多$/.test(description);
      if (descriptionBoundaryDefect || descriptionControlDefect) {
        fields.description = 'fail';
        row.confirmedDescriptionDefects = {
          adjacentSentencesJoined: descriptionBoundaryDefect,
          expanderControlIncluded: descriptionControlDefect,
        };
      }
      // HEAD/GET accessibility is deliberately separate from end-to-end decoding or playback.
      row.mainImageHttp =
        raw.mainImageHttp?.status === 200 && raw.mainImageHttp?.contentType?.startsWith('image/')
          ? 'pass'
          : 'fail';
      row.videoPlayback = raw.draft.videos.length
        ? 'pending-manual-or-decoder-acceptance'
        : 'not-available';
      if (
        !raw.dom.variations.length &&
        raw.category === 'clothing' &&
        !raw.variationInteraction?.activeAsin
      )
        row.variationObservation =
          'Initial tool could not find legacy tiles; later isolated Crocs batch checks actual inline twister';
    }
    rows.push(row);
  }
}

const initial = rows
  .filter((row) => row.kind === 'primary' && row.extensionVersion === '0.5.1')
  .slice(0, 10);
const countFields = (selected) =>
  Object.fromEntries(
    [...new Set(selected.flatMap((row) => Object.keys(row.fields)))].map((field) => [
      field,
      Object.fromEntries(
        ['pass', 'fail', 'unverified', 'not-available', 'requires-content-review'].map((status) => [
          status,
          selected.filter((row) => row.fields[field] === status).length,
        ]),
      ),
    ]),
  );
const publicReport = {
  schemaVersion: 1,
  phase: 16,
  auditedAt: new Date().toISOString(),
  realPages: true,
  mock: false,
  method:
    'Original production extension, activeTab granted by actual action, untouched direct Amazon pages and bounded settling. Independent live DOM values / retained HTML gallery data. Fresh isolated profiles; no accounts, proxy rotation, interception, CAPTCHA bypass, library saves or AI calls. Stop a host after the first challenge. Normal visible variant click, never force. All raw artifacts stay in ignored .test-data.',
  denominator: {
    initialPrimaryPages: initial.length,
    captured: initial.filter((row) => row.outcome === 'captured').length,
    distinctCategories: [...new Set(initial.map((row) => row.category))],
    countryHosts: [...new Set(initial.map((row) => new URL(row.url).hostname))],
    uniqueAsinsIncludingVariant: [...new Set(rows.map((row) => row.asin).filter(Boolean))].length,
    additionalRepeatPagesAreNotNewProducts: true,
    initialFieldCounts: countFields(initial),
  },
  boundaries: [
    'Chrome for Testing automation does not replace stable Chrome / mouse / high-DPI / ordinary Windows manual acceptance.',
    'Visible or structured merchant content comparison does not verify the merchant claims themselves.',
    'No current buybox price on two initial pages; other variant / recommendation prices were not substituted.',
    'Missing videos do not prove no video exists. HEAD status 200 is not playback or decoding success; video playback remains pending.',
    'Initial book author-as-brand and joined-description defects remain shown as failures, separate from later corrected captures.',
    'Actual duplicate library upsert / persistence belongs to isolated E2E and portable tests; this report repeats live extraction without saving to a library.',
  ],
  batches,
  rows,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(publicReport, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      output,
      initialPages: initial.length,
      initialCaptured: publicReport.denominator.captured,
      uniqueAsins: publicReport.denominator.uniqueAsinsIncludingVariant,
      batches: batches.length,
      rows: rows.length,
      initialFieldCounts: publicReport.denominator.initialFieldCounts,
    },
    null,
    2,
  ),
);
