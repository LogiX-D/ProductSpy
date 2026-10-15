import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { format, resolveConfig } from 'prettier';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const evidence = async (path) => ({ path, sha256: sha(await readFile(path)) });
const output = '.test-data/rc2-hotfix';
const baseline = await json(`${output}/baseline.json`);
const build = await json(`${output}/build-latest.json`);
const regression = await json(`${output}/regression-latest.json`);
assert(build.passed && regression.passed, 'All required checks must actually pass');
const unit = await json(`${output}/unit.json`);
const e2e = await json(`${output}/e2e-report.json`);
assert(unit.success && unit.numFailedTests === 0 && unit.numPendingTests === 0);
assert(e2e.stats.unexpected === 0 && e2e.stats.flaky === 0 && e2e.stats.skipped === 0);
const diagnostics = await json('docs/rc2-popup-diagnostics.json');
assert(
  diagnostics.finalArtifact.assertions.total === 41 &&
    diagnostics.finalArtifact.assertions.passed === 41 &&
    diagnostics.finalArtifact.assertions.failed.length === 0 &&
    diagnostics.finalArtifact.equalsFourDprInput,
  'Final packaged extension must pass actual action QA and match the DPR inputs',
);
const archive = await json('artifacts/release-manifest.json');
assert.equal(archive.version, '1.0.0-rc.2');
for (const row of [archive.portable, archive.extension]) {
  assert.equal(sha(await readFile(`artifacts/${row.file}`)), row.sha256);
}
const preserved = [];
for (const row of baseline.packages) {
  const bytes = await readFile(`artifacts/${row.name}`);
  assert.equal(bytes.length, row.bytes);
  assert.equal(sha(bytes), row.sha256);
  preserved.push(row);
}
const releases = JSON.parse(
  execFileSync('gh', ['api', 'repos/LogiX-D/ProductSpy/releases'], {
    encoding: 'utf8',
    maxBuffer: 5 * 1024 * 1024,
  }),
).map((r) => ({
  id: r.id,
  tag: r.tag_name,
  target: r.target_commitish,
  draft: r.draft,
  prerelease: r.prerelease,
  publishedAt: r.published_at,
  assets: r.assets
    .map((a) => ({
      id: a.id,
      name: a.name,
      size: a.size,
      digest: a.digest,
      updatedAt: a.updated_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
}));
for (const old of baseline.releases)
  assert.deepEqual(
    releases.find((r) => r.id === old.id),
    old,
    `Old Release changed: ${old.tag}`,
  );

async function currentReports(parent, accepts) {
  const matches = [];
  for (const directory of await readdir(parent, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const file = join(
      parent,
      directory.name,
      parent.includes('release-validation') ? 'zip-validation.json' : 'report.json',
    );
    let data;
    try {
      data = await json(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (accepts(data))
      matches.push({ data, file: relative(resolve('.'), resolve(file)).replaceAll('\\', '/') });
  }
  return matches;
}
const portable = await currentReports(
  '.test-data/phase10-portable',
  (r) => r.package === 'ProductSpy-1.0.0-rc.2-windows-x64' && r.startedAt >= regression.startedAt,
);
assert.equal(portable.length, 1);
assert(portable[0].data.passed);
const upgradeAttempts = await currentReports(
  '.test-data/phase20-upgrade',
  (r) => r.to === 'ProductSpy-1.0.0-rc.2-windows-x64' && r.startedAt >= regression.startedAt,
);
const expectedSources = [
  '1.0.0-rc.1',
  '0.8.0',
  '0.7.0',
  '0.6.0',
  '0.5.2',
  '0.5.1',
  '0.5.0',
  '0.4.0',
];
const upgrades = expectedSources.map((version) => {
  const accepted = upgradeAttempts
    .filter((r) => r.data.from === `ProductSpy-${version}-windows-x64` && r.data.passed)
    .sort((a, b) => b.data.finishedAt.localeCompare(a.data.finishedAt))[0];
  assert(accepted, `Missing successful same-artifact upgrade: ${version}`);
  return accepted;
});
const validation = await currentReports(
  '.test-data/release-validation',
  (r) =>
    r.passed &&
    r.extension?.extensionVersionName === '1.0.0-rc.2' &&
    r.checkedAt >= regression.startedAt,
);
assert.equal(validation.length, 1);
const failedAttempts = [];
for (const entry of await readdir(output, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(?:build|regression)-/.test(entry.name)) continue;
  const file = `${output}/${entry.name}/checks.json`;
  const report = await json(file);
  if (!report.passed) failedAttempts.push({ ...(await evidence(file)), checks: report.checks });
}
const sourceFiles = [
  'apps/extension/src/popup/styles.css',
  'apps/extension/src/popup/App.tsx',
  'apps/extension/src/popup/capture-consent.ts',
  'apps/extension/src/popup/copy.ts',
  'apps/extension/manifest.json',
  'packages/shared/src/version.ts',
];
const report = {
  format: 'productspy-rc2-popup-hotfix-validation',
  schemaVersion: 1,
  clientDate: '2026-10-15',
  generatedAt: new Date().toISOString(),
  version: '1.0.0-rc.2',
  passed: true,
  meaningOfPassed:
    'Engineering hotfix regression and frozen-package checks; not Stable Chrome or Windows DPI manual verification.',
  source: {
    beforeHotfix: baseline.sourceAtStart,
    workingTreeProductionFiles: await Promise.all(sourceFiles.map(evidence)),
  },
  issue: {
    id: 'PAIRING-SMALL-WINDOW',
    priority: 'P1',
    reproducedInStableChrome: 'maintainer report',
    independentlyReproducedInCftActualActionPopup: true,
    status: 'fixed, pending native Chrome verification',
    closed: false,
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
    ...(await evidence(`${output}/e2e-report.json`)),
    fixtureAndMock: true,
    browser: 'Chrome for Testing',
    actualActionPopupRegressionIncluded: true,
  },
  portable: {
    passed: true,
    checks: portable[0].data.checks.length,
    ...(await evidence(portable[0].file)),
    nativeGuiAcceptance: false,
  },
  upgrades: await Promise.all(
    upgrades.map(async ({ data, file }) => ({
      from: data.from,
      to: data.to,
      checks: data.checks.length,
      passed: data.passed,
      fixtureOnly: data.fixtureOnly,
      ...(await evidence(file)),
    })),
  ),
  zip: { ...validation[0].data, inventory: undefined, ...(await evidence(validation[0].file)) },
  delivery: archive,
  preservation: {
    oldPackagesByteIdentical: preserved,
    oldReleaseCount: baseline.releases.length,
    oldReleasesAndAssetsUnchanged: true,
    rc1OriginalReleaseId: 412410841,
  },
  diagnostics: await evidence('docs/rc2-popup-diagnostics.json'),
  originalFailedRunsRetained: failedAttempts,
  upgradeAttempts: await Promise.all(
    upgradeAttempts.map(async ({ data, file }) => ({
      from: data.from,
      to: data.to,
      checks: data.checks.length,
      passed: data.passed,
      error: data.error ?? null,
      ...(await evidence(file)),
    })),
  ),
  failuresExplanation: [
    'Original rc.1 action collapsed while the ordinary tab did not; controlled width/height fixes isolate the viewport-root feedback.',
    '600/480/440 CSS-pixel height candidates exposed actual host clipping; final production 420 and stricter footer-visible assertions pass. Failed measurements retained.',
    'Initial CSS guard counter counted grouped declarations once instead of per root node; corrected coverage counting without lowering assertions.',
    'First workflow attempt was blocked by a still-open rc.1 launcher mutex after CLI service stop; no user process was killed, maintainer then closed it.',
    'Second workflow attempt passed the PowerShell reporter comma unquoted, producing list json; quoted the argument, retaining failed logs. No business assertion removed.',
    'One 0.4.0 upgrade attempt reached 11 passing data-preservation checks then timed out waiting 8000ms for its Stop controller; cleanup released the port. Exact cause of the controller delay is unconfirmed. Same frozen packages and original deadline were rerun serially, with previous successful cases retained by hash-verified resume and this failed report preserved.',
  ],
  nativeChrome: {
    toolStopped: true,
    reason:
      'Computer Use could not determine current browser URL with enough confidence to enforce policy; no toolbar action performed and no bypass attempted.',
    fixedToolbarManuallyVerified: false,
    fullChromeVersion: null,
    windowsDisplayScalingPassed: false,
  },
  realAi: {
    calls: 0,
    authorizedPaidTests: false,
    qualityVerified: false,
    providerAndBudgetNotProvided: true,
  },
  remaining: [
    'Maintainer Stable Chrome toolbar first/reopened/Amazon/unsupported/online/offline/restart validation and original screenshots.',
    'Actual Windows display scales 100/125/150/200 percent; simulated CFT DPR is not an OS setting test.',
    'Real AI quality remains unverified and no paid requests authorized.',
    'Future stable Chrome numeric version must be greater than rc.2 1.0.0.2; releaseVersion stable mapping must be reviewed before formal packaging.',
  ],
  release: { intendedDraftOnly: true, public: false, storeSubmitted: false },
};
const path = 'docs/rc2-hotfix-results.json';
await writeFile(
  path,
  await format(JSON.stringify(report), { ...(await resolveConfig(path)), parser: 'json' }),
);
console.log(
  JSON.stringify(
    {
      output: path,
      unit: report.unit.passed,
      e2e: report.e2e.expected,
      portable: report.portable.checks,
      upgrades: report.upgrades.map((u) => ({ from: u.from, checks: u.checks })),
      oldPackages: preserved.length,
    },
    null,
    2,
  ),
);
