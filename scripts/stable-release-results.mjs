import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { format, resolveConfig } from 'prettier';

const version = '1.0.0';
const output = '.test-data/stable-release';
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = async (path) => ({ path, sha256: sha(await readFile(path)) });
const baseline = await json(`${output}/baseline.json`);
const build = await json(`${output}/build-latest.json`);
const regression = await json(`${output}/regression-latest.json`);
const expectedSources = [
  '1.0.0-rc.2',
  '1.0.0-rc.1',
  '0.8.0',
  '0.7.0',
  '0.6.0',
  '0.5.2',
  '0.5.1',
  '0.5.0',
  '0.4.0',
];
const expectedChecks = {
  build: ['install', 'typecheck', 'lint', 'format', 'unit', 'build', 'package'],
  regression: ['e2e', 'portable', ...expectedSources.map((v) => `upgrade-${v}`), 'zip-validation'],
};
for (const [stage, data] of [
  ['build', build],
  ['regression', regression],
]) {
  assert.equal(data.version, version);
  assert.equal(data.stage, stage);
  assert.equal(data.passed, true, `${stage} must actually finish successfully`);
  assert.equal(data.paidAiCalls, 0);
  assert.deepEqual(
    data.checks.map((row) => row.name),
    expectedChecks[stage],
  );
  assert(data.startedAt && data.finishedAt && data.finishedAt >= data.startedAt);
  for (const row of data.checks) {
    assert(row.passed && row.exitCode === 0, `Failed or incomplete check: ${row.name}`);
    assert.equal(sha(await readFile(row.log)), row.sha256, `Check log changed: ${row.name}`);
    assert(row.startedAt >= data.startedAt && row.finishedAt <= data.finishedAt);
  }
}

const unit = await json(`${output}/unit.json`);
assert(unit.success && unit.numFailedTests === 0 && unit.numPendingTests === 0);
assert(unit.numPassedTests > 0 && unit.testResults.length > 0);
const e2e = await json(`${output}/e2e-report.json`);
assert(e2e.stats.unexpected === 0 && e2e.stats.flaky === 0 && e2e.stats.skipped === 0);
assert(e2e.stats.expected > 0);
const workflow = await json(`${output}/workflow.json`);
assert(workflow.passed && workflow.version === version && workflow.ai === 'mock');
assert.equal(workflow.paidRequests, 0);
assert(workflow.sessions.length > 0 && workflow.sessions.every((row) => row.verifiedOwned));
assert.equal(workflow.cleanup.launcherExitCode, 0);
const archive = await json('artifacts/release-manifest.json');
assert.equal(archive.version, version);
for (const [kind, row] of [
  ['portable', archive.portable],
  ['extension', archive.extension],
]) {
  assert.equal(row.file, `ProductSpy-${version}-${kind === 'portable' ? 'windows-x64' : kind}.zip`);
  const bytes = await readFile(`artifacts/${row.file}`);
  assert.equal(bytes.length, row.bytes);
  assert.equal(sha(bytes), row.sha256);
}
assert.equal(archive.extension.extensionVersionName, version);
const numeric = archive.extension.extensionVersion.split('.').map(Number);
assert(numeric.every((part) => Number.isInteger(part) && part >= 0 && part <= 65535));
const priorNumeric = [1, 0, 0, 2];
const comparisonIndex = priorNumeric.findIndex((part, index) => (numeric[index] ?? 0) !== part);
assert(comparisonIndex >= 0 && (numeric[comparisonIndex] ?? 0) > priorNumeric[comparisonIndex]);

assert.equal(baseline.packages.length, 22, 'All 22 frozen old archives must be inventoried');
assert.equal(baseline.releases.length, 11, 'All 11 old Releases must be inventoried');
for (const row of baseline.packages) {
  assert(!row.name.includes('/') && !row.name.includes('\\'));
  const bytes = await readFile(`artifacts/${row.name}`);
  assert.equal(bytes.length, row.bytes);
  assert.equal(sha(bytes), row.sha256, `Old ZIP changed: ${row.name}`);
}
const releases = JSON.parse(
  execFileSync('gh', ['api', 'repos/LogiX-D/ProductSpy/releases', '--paginate', '--slurp'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  }),
)
  .flat()
  .map((release) => ({
    id: release.id,
    tag: release.tag_name,
    target: release.target_commitish,
    draft: release.draft,
    prerelease: release.prerelease,
    publishedAt: release.published_at,
    assets: release.assets
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        size: asset.size,
        digest: asset.digest,
        updatedAt: asset.updated_at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
for (const old of baseline.releases)
  assert.deepEqual(
    releases.find((row) => row.id === old.id),
    old,
    `Old Release changed: ${old.tag}`,
  );

async function currentReports(parent, filename, accepts) {
  const matches = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(parent, entry.name, filename);
    let data;
    try {
      data = await json(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (accepts(data))
      matches.push({ data, file: relative(resolve('.'), resolve(path)).replaceAll('\\', '/') });
  }
  return matches;
}
const inRegression = (startedAt) =>
  startedAt >= regression.startedAt && startedAt <= regression.finishedAt;
const portableAttempts = await currentReports(
  '.test-data/phase10-portable',
  'report.json',
  (row) => row.package === `ProductSpy-${version}-windows-x64` && inRegression(row.startedAt),
);
const latestPassed = (rows) =>
  rows
    .filter((row) => row.data.passed)
    .sort((a, b) => b.data.finishedAt.localeCompare(a.data.finishedAt))[0];
const portable = latestPassed(portableAttempts);
assert(portable, 'Missing completed Windows portable lifecycle run');
assert(portable.data.checks.length > 0 && portable.data.checks.every((row) => row.passed));
const upgradeAttempts = await currentReports(
  '.test-data/phase20-upgrade',
  'report.json',
  (row) => row.to === `ProductSpy-${version}-windows-x64` && inRegression(row.startedAt),
);
const upgrades = expectedSources.map((source) => {
  const accepted = latestPassed(
    upgradeAttempts.filter((row) => row.data.from === `ProductSpy-${source}-windows-x64`),
  );
  assert(accepted, `Missing successful same-artifact upgrade: ${source}`);
  assert(accepted.data.checks.length > 0 && accepted.data.checks.every((row) => row.passed));
  return accepted;
});
const zipAttempts = await currentReports(
  '.test-data/release-validation',
  'zip-validation.json',
  (row) => row.version === version && inRegression(row.checkedAt),
);
const zip = zipAttempts.filter((row) => row.data.passed).at(-1);
assert(zip, 'Missing completed release archive validation');
assert.equal(zip.data.portable.sha256, archive.portable.sha256);
assert.equal(zip.data.extension.sha256, archive.extension.sha256);
assert(zip.data.checks.length > 0 && zip.data.checks.every((row) => row.passed));

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(value.replace(/\r$/, ''));
      value = '';
      if (character === '\n') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
      }
    } else value += character;
  }
  assert(!quoted, 'Manual CSV has an unterminated quoted field');
  if (value || row.length) {
    row.push(value.replace(/\r$/, ''));
    rows.push(row);
  }
  const headers = rows.shift();
  assert(headers.includes('case_id') && headers.includes('status') && headers.includes('bug_id'));
  return rows.map((values) => {
    assert.equal(values.length, headers.length, 'Manual CSV field count changed');
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}
const manualPath = 'docs/phase21/manual-results.csv';
const manual = parseCsv(await readFile(manualPath, 'utf8'));
assert.equal(manual.length, 53);
assert.deepEqual(
  manual.filter((row) => row.status === 'pass').map((row) => row.case_id),
  ['C07'],
);
assert.equal(manual.filter((row) => row.status === 'pending').length, 52);
const confirmation = manual.find((row) => row.case_id === 'C07');
assert.equal(confirmation.bug_id, 'PAIRING-SMALL-WINDOW');
assert.equal(confirmation.candidate_version, '1.0.0-rc.2');
assert.equal(confirmation.performed_at, '2026-10-16');
assert(confirmation.actual_result && confirmation.tester_alias && confirmation.evidence_files);

const failedRuns = [];
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(?:build|regression)-/.test(entry.name)) continue;
  const path = `${output}/${entry.name}/checks.json`;
  const data = await json(path);
  assert.equal(data.version, version);
  if (!data.passed)
    failedRuns.push({
      ...(await evidence(path)),
      checks: data.checks,
      activeCommand: data.activeCommand ?? null,
    });
}
const attempts = async (rows) =>
  Promise.all(
    rows.map(async ({ data, file }) => ({
      from: data.from,
      to: data.to,
      package: data.package,
      checks: data.checks?.length ?? 0,
      passed: data.passed === true,
      error: data.error ?? null,
      ...(await evidence(file)),
    })),
  );
const report = {
  format: 'productspy-stable-release-validation',
  schemaVersion: 1,
  version,
  clientDate: '2026-10-16',
  generatedAt: new Date().toISOString(),
  passed: true,
  meaningOfPassed:
    'All engineering checks passed for the newly built stable archives. Only C07 has maintainer manual confirmation on rc.2; the 52 other manual cases remain pending. This is not blanket native Stable Chrome, Windows GUI, or paid-model quality acceptance.',
  source: {
    baseline: baseline.sourceAtStart,
    files: await Promise.all(
      [
        'package.json',
        'apps/extension/manifest.json',
        'apps/extension/src/popup/styles.css',
        'apps/extension/src/popup/App.tsx',
        'apps/extension/src/popup/capture-consent.ts',
        'packages/shared/src/version.ts',
        'scripts/packaging/release-version.mjs',
      ].map(evidence),
    ),
  },
  checks: { build, regression },
  unit: {
    files: unit.testResults.length,
    passed: unit.numPassedTests,
    failed: 0,
    pending: 0,
    ...(await evidence(`${output}/unit.json`)),
  },
  e2e: {
    ...e2e.stats,
    fixtureAndMock: true,
    browser: 'Chrome for Testing',
    actualActionPopupRegressionIncluded: true,
    ...(await evidence(`${output}/e2e-report.json`)),
  },
  workflow: {
    runtime: workflow.runtime,
    ai: workflow.ai,
    paidRequests: 0,
    sessions: workflow.sessions.length,
    ownedSessionsVerified: true,
    cleanup: workflow.cleanup,
    ...(await evidence(`${output}/workflow.json`)),
  },
  portable: {
    passed: true,
    checks: portable.data.checks.length,
    nativeGuiAcceptance: false,
    ...(await evidence(portable.file)),
  },
  upgrades: await Promise.all(
    upgrades.map(async ({ data, file }) => ({
      from: data.from,
      to: data.to,
      checks: data.checks.length,
      passed: true,
      fixtureOnly: data.fixtureOnly,
      ...(await evidence(file)),
    })),
  ),
  zip: { ...zip.data, inventory: undefined, ...(await evidence(zip.file)) },
  delivery: archive,
  preservation: {
    oldPackagesByteIdentical: baseline.packages,
    oldReleaseCount: baseline.releases.length,
    oldReleasesAndAssetsUnchanged: true,
    preservedCandidateTags: ['v1.0.0-rc.1', 'v1.0.0-rc.2'],
  },
  manual: {
    total: 53,
    passed: 1,
    pending: 52,
    confirmedCase: confirmation,
    scope:
      'Maintainer personally confirmed rc.2 toolbar Popup on the same formerly failing PC and official Google Chrome. No additional Chrome version, DPI, viewport dimensions, screenshot, or unmentioned scenario inferred.',
    ...(await evidence(manualPath)),
  },
  issue: {
    id: 'PAIRING-SMALL-WINDOW',
    priority: 'P1',
    status: 'fixed + manually verified',
    closed: true,
    verificationVersion: '1.0.0-rc.2',
    verificationSource: '2026-10-16 maintainer explicit statement in this conversation',
    automaticallyAppliedToOtherManualCases: false,
  },
  originalFailedRunsRetained: failedRuns,
  portableAttempts: await attempts(portableAttempts),
  upgradeAttempts: await attempts(upgradeAttempts),
  zipAttempts: await attempts(zipAttempts),
  realAi: {
    calls: 0,
    authorizedPaidTests: false,
    qualityVerified: false,
    providerModelRequestCountAndBudgetNotProvided: true,
  },
  remaining: [
    '52 unexecuted native/manual scenarios remain pending, including actual DPI scales and native Windows UI.',
    'Maintainer Popup confirmation is for rc.2; the new stable package is engineering-regression tested, not silently marked as a complete native manual acceptance.',
    'Real paid-model quality and actual costs remain unverified; no paid requests made.',
  ],
  release: { intendedDraftOnly: true, public: false, storeSubmitted: false },
};
const target = 'docs/stable-release-validation.json';
await writeFile(
  target,
  await format(JSON.stringify(report), { ...(await resolveConfig(target)), parser: 'json' }),
);
console.log(
  JSON.stringify(
    {
      output: target,
      unit: report.unit.passed,
      e2e: report.e2e.expected,
      portable: report.portable.checks,
      upgrades: report.upgrades.map(({ from, checks }) => ({ from, checks })),
      manual: { passed: 1, pending: 52 },
      oldReleases: baseline.releases.length,
      oldArchives: baseline.packages.length,
    },
    null,
    2,
  ),
);
