import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
async function latest(directory, predicate) {
  for (const name of (await readdir(directory)).sort().reverse()) {
    const path = join(directory, name, 'report.json');
    try {
      const value = await json(path);
      if (predicate(value))
        return {
          value,
          path: relative(resolve('.'), resolve(path)).replaceAll('\\', '/'),
          sha256: await sha(path),
        };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Missing actual evidence: ${directory}`);
}
const release = await json('artifacts/release-manifest.json');
assert.equal(release.version, '0.7.0');
const cutoff = (await stat(join('artifacts', release.portable.file))).mtimeMs;
const checks = await json('.test-data/phase18/checks.json');
const unit = await json('.test-data/phase18/unit-report.json');
const e2e = await json('.test-data/phase18/e2e-report.json');
assert(checks.passed && checks.checks.every((check) => check.passed));
assert(unit.success && unit.numFailedTests === 0 && unit.numPassedTests >= 642);
assert(
  e2e.stats.unexpected === 0 &&
    e2e.stats.skipped === 0 &&
    e2e.stats.flaky === 0 &&
    e2e.stats.expected >= 27,
);
const portable = await latest(
  '.test-data/phase10-portable',
  (value) =>
    value.package === 'ProductSpy-0.7.0-windows-x64' && Date.parse(value.startedAt) >= cutoff,
);
assert(portable.value.passed && portable.value.checks.every((check) => check.passed));
const upgrades = [];
for (const version of ['0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0']) {
  const proof = await latest(
    '.test-data/phase17-upgrade',
    (value) =>
      value.fromVersion === version &&
      value.toVersion === '0.7.0' &&
      Date.parse(value.startedAt) >= cutoff,
  );
  assert(proof.value.passed && proof.value.checks.every((check) => check.passed));
  upgrades.push({
    from: version,
    to: '0.7.0',
    passed: true,
    checks: proof.value.checks.length,
    evidence: proof.path,
    sha256: proof.sha256,
  });
}
let zip;
for (const name of (await readdir('.test-data/release-validation')).sort().reverse()) {
  const path = join('.test-data/release-validation', name, 'zip-validation.json');
  const value = await json(path);
  if (value.portable?.file === release.portable.file && Date.parse(value.checkedAt) >= cutoff) {
    zip = { ...value, evidence: path.replaceAll('\\', '/'), reportSha256: await sha(path) };
    break;
  }
}
assert(zip?.passed && zip.failures.length === 0);
assert.equal(zip.portable.sha256, await sha(join('artifacts', release.portable.file)));
assert.equal(zip.extension.sha256, await sha(join('artifacts', release.extension.file)));
const screenshots = await json('docs/screenshots/phase18/provenance.json');
assert(
  screenshots.verified &&
    screenshots.production &&
    screenshots.realAiCalls === 0 &&
    screenshots.screenshots.length >= 7,
);
for (const item of screenshots.screenshots) assert.equal(item.sha256, await sha(item.path));
assert.equal(
  await sha('artifacts/ProductSpy-0.6.0-windows-x64.zip'),
  '3ddbb37bfb0b222d709a002dc5f201983b38389d1703ec93355e8ffe505cfa78',
);
assert.equal(
  await sha('artifacts/ProductSpy-0.6.0-extension.zip'),
  '12af684bdd9d7aee2f98622a68e745bac56097e4aa1deaa7a2964d5b57f7d841',
);
const result = {
  phase: 18,
  version: '0.7.0',
  generatedAt: new Date().toISOString(),
  passed: true,
  phase17Gate: {
    remoteMainVerified: 'a1c749e0760015f58c258b56837a416e2d4cb74a',
    version: '0.6.0',
    cleanBeforePhase18: true,
    unitTests: 555,
    e2eTests: 23,
    portableChecks: 10,
    upgrade: { from: '0.5.2', checks: 18 },
    zipVerified: true,
    releaseDraftVerified: true,
    assets: 9,
    oldArchivesUnchanged: true,
  },
  checks: checks.checks,
  unit: {
    files: unit.testResults.length,
    passed: unit.numPassedTests,
    failed: unit.numFailedTests,
  },
  e2e: e2e.stats,
  portable: {
    passed: portable.value.passed,
    checks: portable.value.checks.length,
    evidence: portable.path,
    sha256: portable.sha256,
  },
  upgrades,
  zip,
  release,
  screenshots: {
    count: screenshots.screenshots.length,
    evidence: 'docs/screenshots/phase18/provenance.json',
    actualProductionService: true,
    realRetainedProductCaptures: true,
    sourcePhase: 17,
    aiMode: 'mock',
  },
  quality: {
    realAiCalls: 0,
    realModelQualityVerified: false,
    mockSyntheticCategories: 6,
    mockLanguages: ['zh-CN', 'en', 'ja'],
    paidApiAuthorized: false,
    report: 'docs/phase18-ai-quality.md',
  },
  initialFailures: [
    {
      stage: 'format',
      cause: 'Concurrent unfinished new test formatting; completed and rerun',
      evidence: '.test-data/phase18/checks-format-attempt.json',
    },
    {
      stage: 'e2e',
      cause:
        'New assertion confused forbidden missing web context403 with trusted-origin anonymous401; now separately tests both',
      evidence: '.test-data/phase18/e2e-first-attempt.json',
    },
  ],
  manualPending: [
    'Stable Chrome mouse acceptance',
    'Windows10/11 other devices and highDPI/SmartScreen',
    'Native folderpicker/Explorer',
    'Actual paidmodel content accuracy, market language and filming quality',
    'Real external user feedback',
  ],
  published: false,
  chromeWebStoreSubmitted: false,
};
await writeFile('docs/phase18-results.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      passed: true,
      unit: result.unit,
      e2e: result.e2e,
      portable: result.portable.checks,
      upgrades: upgrades.map((item) => ({ from: item.from, checks: item.checks })),
      screenshots: result.screenshots.count,
      output: 'docs/phase18-results.json',
    },
    null,
    2,
  ),
);
