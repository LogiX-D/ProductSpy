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
          evidence: relative(resolve('.'), resolve(path)).replaceAll('\\', '/'),
          sha256: await sha(path),
        };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Missing actual evidence: ${directory}`);
}
const release = await json('artifacts/release-manifest.json');
assert.equal(release.version, '0.8.0');
const cutoff = (await stat(join('artifacts', release.portable.file))).mtimeMs;
const checks = await json('.test-data/phase19/checks.json');
const unit = await json('.test-data/phase19/unit-report.json');
const e2e = await json('.test-data/phase19/e2e-report.json');
assert(checks.passed && checks.checks.every((check) => check.passed));
assert(unit.success && unit.numFailedTests === 0);
assert(e2e.stats.unexpected === 0 && e2e.stats.skipped === 0 && e2e.stats.flaky === 0);
const portable = await latest(
  '.test-data/phase10-portable',
  (value) =>
    value.package === 'ProductSpy-0.8.0-windows-x64' && Date.parse(value.startedAt) >= cutoff,
);
assert(portable.value.passed && portable.value.checks.every((check) => check.passed));
const upgrades = [];
for (const version of ['0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0']) {
  const proof = await latest(
    '.test-data/phase19-upgrade',
    (value) =>
      value.fromVersion === version &&
      value.toVersion === '0.8.0' &&
      Date.parse(value.startedAt) >= cutoff,
  );
  assert(proof.value.passed && proof.value.checks.every((check) => check.passed));
  upgrades.push({
    from: version,
    to: '0.8.0',
    checks: proof.value.checks.length,
    passed: true,
    evidence: proof.evidence,
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
const screenshots = await json('docs/screenshots/phase19/provenance.json');
assert(
  screenshots.verified &&
    screenshots.production &&
    screenshots.realAiCalls === 0 &&
    screenshots.screenshots.length >= 40,
);
for (const item of screenshots.screenshots) assert.equal(item.sha256, await sha(item.path));
const performance = [];
for (const version of ['0.7.0', '0.8.0']) {
  const path = `.test-data/phase19/performance-${version}.json`;
  const report = await json(path);
  assert(report.passed && report.production && report.synthetic && report.realAiCalls === 0);
  performance.push({ ...report, evidence: path, sha256: await sha(path) });
}
const amazon = await json('docs/phase19/amazon-results.json');
assert(amazon.phase === 19 && amazon.realPages && !amazon.mock);
for (const [file, expected] of [
  [
    'artifacts/ProductSpy-0.7.0-windows-x64.zip',
    'ca6b3932664dc826522db00c7d5c6a8abca8a6cf26299a02191be60e048c0416',
  ],
  [
    'artifacts/ProductSpy-0.7.0-extension.zip',
    '22026c734b06d46f5f29bd922b028914326995173ff5c5d01ec67bb5ddbc59ee',
  ],
])
  assert.equal(await sha(file), expected, 'Frozen previous archive must not change.');
const result = {
  phase: 19,
  version: '0.8.0',
  generatedAt: new Date().toISOString(),
  passed: true,
  baseline: {
    sourceCommit: 'a0f12f19f4b216eba3aeebb3b69b199d11ab4213',
    version: '0.7.0',
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
    passed: true,
    checks: portable.value.checks.length,
    evidence: portable.evidence,
    sha256: portable.sha256,
  },
  upgrades,
  zip,
  release,
  performance,
  screenshots: {
    count: screenshots.screenshots.length,
    evidence: 'docs/screenshots/phase19/provenance.json',
    production: true,
    sourcePhase: 17,
    realRetainedProductCaptures: true,
    aiMode: 'mock',
  },
  amazon: {
    evidence: 'docs/phase19/amazon-results.json',
    sha256: await sha('docs/phase19/amazon-results.json'),
    denominator: amazon.denominator,
    browser: amazon.batches[0].browser,
  },
  realAiCalls: 0,
  realModelQualityVerified: false,
  initialFailures: [
    {
      stage: 'TypeScript',
      cause:
        'New E2E generic inference included undefined; explicit validated response types added',
      evidence: '.test-data/phase19/typecheck-attempt1.log',
    },
    {
      stage: 'Repeated unit harness',
      cause:
        'Filesystem/report timeouts on watched source-tree fixture paths. Isolated OS temp artifacts and post-worker evidence publication added; assertions and timeouts unchanged, three complete repeat runs verified.',
      evidence: '.test-data/phase19/unit-timeout-attempt3.log',
    },
    {
      stage: 'E2E harness',
      cause:
        'Latest-data workflow creates a review form before creating a new plan; zero-selection archive button has no count suffix. Tests corrected to perform the real actions.',
      evidence: '.test-data/phase19/e2e-attempt1.log',
    },
    {
      stage: 'History feedback',
      cause:
        'Actual cleanup succeeded but parent timestamp refresh cleared success notice; fixed effect dependencies, retained strict regression assertion.',
      evidence: '.test-data/phase19/e2e-integration-focused.log',
    },
    {
      stage: 'Visual inspection',
      cause:
        'Duplicate quality-source cards grouped into one asset; adding a selector exposed caption grid placement regression. Explicit caption column and readable-width E2E assertion added.',
      evidence: 'docs/screenshots/phase19/provenance.json',
    },
  ],
  manualPending: [
    'Google Chrome stable native popup and original small pairing window',
    'Multi-device Windows10/11 GUI, high DPI, SmartScreen and native folder dialog',
    'Actual decoded video playback, complete description content review',
    'Real paid AI quality with explicit model, key, request ceiling and budget',
    'Power loss and physical disk-failure testing (fault-injection process recovery passed)',
  ],
};
await writeFile('docs/phase19-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    version: result.version,
    passed: true,
    unit: result.unit,
    e2e: result.e2e,
    portable: result.portable.checks,
    upgrades: upgrades.map((row) => ({ from: row.from, checks: row.checks })),
    screenshots: result.screenshots.count,
  }),
);
