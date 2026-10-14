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
assert.equal(release.version, '1.0.0-rc.1');
const cutoff = (await stat(join('artifacts', release.portable.file))).mtimeMs;
const checks = await json('.test-data/phase20/checks.json');
const unit = await json('.test-data/phase20/unit-report.json');
const e2e = await json('.test-data/phase20/e2e-report.json');
const finalChecks = await json('.test-data/phase20/final-checks.json');
const portablePipeline = await json('.test-data/phase20/portable-checks.json');
assert(
  portablePipeline.passed &&
    portablePipeline.checks.length === 9 &&
    portablePipeline.checks.every((item) => item.passed && item.exitCode === 0),
);
assert(
  finalChecks.passed && finalChecks.checks.every((item) => item.passed && item.exitCode === 0),
);
for (const item of finalChecks.checks) assert.equal(item.logSha256, await sha(item.evidence));
assert(checks.passed && checks.checks.every((check) => check.passed));
assert.deepEqual(
  checks.checks.map((item) => item.name),
  [
    'install',
    'typecheck',
    'lint',
    'format-write',
    'format',
    'unit',
    'build',
    'unit-repeat-1',
    'unit-repeat-2',
    'unit-repeat-3',
    'e2e',
  ],
);
const withinStage = (start, name) => {
  const stage = checks.checks.find((item) => item.name === name);
  assert(
    stage && start >= Date.parse(stage.startedAt) && start <= Date.parse(stage.finishedAt),
    `${name} report must come from the final recorded command`,
  );
};
withinStage(unit.startTime, 'unit');
withinStage(Date.parse(e2e.stats.startTime), 'e2e');
assert(unit.numPassedTests > 0 && unit.testResults.length > 0 && e2e.stats.expected > 0);
for (const check of checks.checks) {
  check.logSha256 = await sha(check.evidence);
  assert((await stat(check.evidence)).mtimeMs >= Date.parse(check.startedAt));
}
assert(unit.success && unit.numFailedTests === 0);
assert(e2e.stats.unexpected === 0 && e2e.stats.skipped === 0 && e2e.stats.flaky === 0);
const portable = await latest(
  '.test-data/phase10-portable',
  (value) =>
    value.package === 'ProductSpy-1.0.0-rc.1-windows-x64' && Date.parse(value.startedAt) >= cutoff,
);
assert(portable.value.passed && portable.value.checks.every((check) => check.passed));
const upgrades = [];
for (const version of ['0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0']) {
  const proof = await latest(
    '.test-data/phase20-upgrade',
    (value) =>
      value.fromVersion === version &&
      value.toVersion === '1.0.0-rc.1' &&
      Date.parse(value.startedAt) >= cutoff,
  );
  assert(proof.value.passed && proof.value.checks.every((check) => check.passed));
  upgrades.push({
    from: version,
    to: '1.0.0-rc.1',
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
const screenshots = await json('docs/screenshots/phase20/provenance.json');
assert(
  screenshots.verified &&
    screenshots.production &&
    screenshots.realAiCalls === 0 &&
    screenshots.screenshots.length >= 40,
);
assert.equal(
  screenshots.portablePackage.bundleManifestSha256,
  await sha(join('artifacts', `ProductSpy-${release.version}-windows-x64`, 'bundle-manifest.json')),
  'Screenshots must show the final frozen portable bundle',
);
assert(Date.parse(screenshots.capturedAt) >= cutoff, 'Capture screenshots after final packaging');
for (const item of screenshots.screenshots) assert.equal(item.sha256, await sha(item.path));
const amazon = await json('docs/phase20/amazon-results.json');
assert(amazon.phase === 20 && amazon.realPages && !amazon.mock);
for (const [file, expected] of [
  [
    'artifacts/ProductSpy-0.8.0-windows-x64.zip',
    'df3ff9852e975d9eae80b458675f6b25bc2de8f635c6f3f846868b24b946a73a',
  ],
  [
    'artifacts/ProductSpy-0.8.0-extension.zip',
    'c3700ecc74b59159bfaae54b69a81205cf4ad8db4bb4417369c64cd24cc40518',
  ],
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
  phase: 20,
  version: '1.0.0-rc.1',
  generatedAt: new Date().toISOString(),
  passed: true,
  environment: await json('.test-data/phase20/environment.json'),
  baseline: {
    sourceCommit: '08eefad297816b6b6b2cb236ba40ef7951960000',
    version: '0.8.0',
    oldArchivesUnchanged: true,
  },
  checks: checks.checks,
  finalChecks: finalChecks.checks,
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
  portablePipeline,
  zip,
  release,
  screenshots: {
    count: screenshots.screenshots.length,
    evidence: 'docs/screenshots/phase20/provenance.json',
    production: true,
    sourcePhase: 17,
    realRetainedProductCaptures: true,
    aiMode: 'mock',
  },
  amazon: {
    evidence: 'docs/phase20/amazon-results.json',
    sha256: await sha('docs/phase20/amazon-results.json'),
    denominator: amazon.denominator,
    browser: amazon.batches[0].browser,
  },
  acceptance: {
    development: true,
    engineeringAutomation: true,
    allRealEnvironment: false,
    publicRelease: false,
    readyForFormalReleaseAcceptance: true,
  },
  desktop: await json('docs/phase20-desktop-evidence.json'),
  realAiCalls: 0,
  realModelQualityVerified: false,
  initialFailures: [
    {
      stage: 'Upgrade test ordering',
      evidence: '.test-data/phase20-upgrade/2026-10-14T06-26-15-379Z-LBjYu8/report.json',
      cause:
        'All first-read byte assertions passed. A later explicit full-backup restore normalized ledger property order before an old read-only byte check. Moved deliberate restore after strict byte checks; unchanged assertions and 28 actual v0.8 checks passed. All five usage records deep-equal, no real request or product data loss.',
    },
    {
      stage: 'Portable fixture ACL restoration',
      evidence: '.test-data/phase20/portable-checks-attempt1.json',
      cause:
        'Write denial was correctly detected. Windows .NET restoration normalized auto-inherited DACL flags and failed exact original-SDDL assertion; test-only restoration corrected with exact Windows DACL API, assertions retained.',
    },
    {
      stage: 'Targeted E2E CLI invocation',
      evidence: '.test-data/phase20/rc-targeted-e2e-cli-initial.log',
      cause:
        'PowerShell split an unquoted reporter comma before any test ran; quoted CLI arguments fixed the harness invocation.',
    },
    {
      stage: 'Initial E2E anonymous-context regression',
      evidence: '.test-data/phase20/initial-anonymous-failure/trace.zip',
      cause:
        'Playwright newContext inherited authenticated storageState. Explicit empty state and before/after cookie checks added; all three 401 assertions retained. Targeted production E2E 2 passed before complete rerun.',
    },
    {
      stage: 'Interrupted initial long run',
      evidence: '.test-data/phase20/amazon-capture.log',
      cause:
        'Initial checks and Amazon jobs interrupted before final report. Six primary Amazon results retained including one navigation timeout; only the four unattempted pages continued in separate evidence batches. Full engineering checks rerun; progress now checkpoints after each command.',
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
await writeFile('docs/phase20-results.json', JSON.stringify(result, null, 2) + '\n');
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
