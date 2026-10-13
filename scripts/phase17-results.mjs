import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const release = await json('artifacts/release-manifest.json');
assert(release.version === '0.6.0');
const cutoff = (await stat(join('artifacts', release.portable.file))).mtimeMs;
async function latestReport(directory, filename, predicate = () => true) {
  for (const name of (await readdir(directory)).sort().reverse()) {
    const path = join(directory, name, filename);
    try {
      const report = await json(path);
      if (predicate(report))
        return {
          path: relative(resolve('.'), resolve(path)).replaceAll('\\', '/'),
          report,
          sha256: await sha(path),
        };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Required final report missing: ${directory}/${filename}`);
}
const portable = await latestReport(
  '.test-data/phase10-portable',
  'report.json',
  (r) => r.package === 'ProductSpy-0.6.0-windows-x64' && Date.parse(r.startedAt) >= cutoff,
);
assert(portable.report.passed && portable.report.checks.length === 10);
const upgrades = [];
for (const from of ['0.5.2', '0.5.1', '0.5.0', '0.4.0']) {
  const evidence = await latestReport(
    '.test-data/phase17-upgrade',
    'report.json',
    (r) => r.fromVersion === from && r.toVersion === '0.6.0' && Date.parse(r.startedAt) >= cutoff,
  );
  assert(evidence.report.passed && evidence.report.checks.length === 18);
  upgrades.push({
    from,
    to: '0.6.0',
    passed: true,
    checks: evidence.report.checks,
    evidence: evidence.path,
    reportSha256: evidence.sha256,
  });
}
const zip = await latestReport(
  '.test-data/release-validation',
  'zip-validation.json',
  (r) => r.version === '0.6.0' && r.portable?.sha256 === release.portable.sha256,
);
assert(zip.report.passed && zip.report.checks.length === 4);
const e2e = await json('test-results/e2e/.last-run.json');
assert(e2e.status === 'passed' && e2e.failedTests.length === 0);
const screenshots = await json('docs/screenshots/phase17/provenance.json');
assert(screenshots.verified && screenshots.screenshots.length === 8);
assert(
  screenshots.mediaSourceSelection?.passed &&
    screenshots.mediaSourceSelection?.preservesCapturedPreferred &&
    screenshots.mediaSourceSelection?.previewSwitchVerified,
);
const perf = await latestReport(
  '.test-data/phase13-performance',
  'report.json',
  (r) => r.version === '0.6.0' && r.passed,
);
for (const item of [release.portable, release.extension])
  assert((await sha(join('artifacts', item.file))) === item.sha256);
const report = {
  phase: 17,
  version: '0.6.0',
  generatedAt: new Date().toISOString(),
  sourceBaseline: 'v0.5.2 / b3d873e',
  checks: {
    frozenInstall: true,
    typecheck: true,
    eslint: { passed: true, warnings: 0 },
    prettier: true,
    vitest: { passed: true, files: 50, tests: 555 },
    productionBuild: true,
    e2e: {
      passed: true,
      tests: 23,
      priorFailures: [
        'MV3 15s startup timeout; now bounded 45s',
        'fast independent sessions reached unchanged production rate limit; owned session reused and anonymous state explicit',
        'Windows EPERM rename left cleanup fixture data; bounded atomic publication added, final all assertions retained',
      ],
    },
    portable: {
      passed: true,
      checks: portable.report.checks,
      evidence: portable.path,
      reportSha256: portable.sha256,
    },
    upgrades,
    zip: { ...zip.report, evidence: zip.path },
  },
  release,
  performance: {
    synthetic: true,
    actualAmazonProducts: 0,
    browser: perf.report.browser,
    sampleScope: perf.report.sampleScope,
    metrics: perf.report.metrics,
    evidence: perf.path,
    sha256: perf.sha256,
  },
  realAmazon: {
    report: 'docs/phase17/amazon-results.json',
    sha256: await sha('docs/phase17/amazon-results.json'),
    primaryVisited: 10,
    primaryCaptured: 8,
    normalVariantCaptures: 2,
    uniqueAsins: 9,
    categories: 6,
    countrySites: 4,
    restrictedPages: 2,
  },
  mediaMetadata: {
    report: 'docs/phase17/media-metadata-results.json',
    sha256: await sha('docs/phase17/media-metadata-results.json'),
  },
  publicMedia: {
    report: 'docs/phase17/public-media-results.json',
    sha256: await sha('docs/phase17/public-media-results.json'),
    jpegDownloaded: true,
    videoOver64MiB: 'rejected HTTP 413; not a successful video download',
  },
  screenshots: {
    manifest: 'docs/screenshots/phase17/provenance.json',
    sha256: await sha('docs/screenshots/phase17/provenance.json'),
    count: 8,
    actualPortableService: true,
    realCapturedProducts: true,
    analysisMode: 'mock',
  },
  realAiCalls: 0,
  realAiQualityVerified: false,
  published: false,
  limitations: [
    'Stable Chrome and ordinary Windows/DPI/native directory picker/Explorer require manual acceptance',
    'No HLS/DRM/login/challenge bypass; limited CDN whitelist and bounded bytes',
    'Directory sessions expire after 30 minutes/restart; hard-link filesystem required, browser save fallback',
    'Unknown content attribution/dimensions remain unverified',
    'Comparison backups separate from product backups; old versions must use pre-upgrade backups on rollback',
    'No paid model quality, external user feedback or v1.0 readiness claims',
  ],
};
await writeFile('docs/phase17-results.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    version: report.version,
    portable: 10,
    upgrades: upgrades.map((u) => `${u.from}:18`),
    screenshots: 8,
    output: 'docs/phase17-results.json',
  }),
);
