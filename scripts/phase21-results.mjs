import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

// Read-only evidence collection: never rebuild frozen rc.1, start a service or call an AI.
const workspace = resolve(import.meta.dirname, '..');
const version = '1.0.0-rc.1';
const candidateCommit = 'bcf049d45e65ea6da798b53aa6b57b20508927f9';
const upgradeVersions = ['0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0'];
const local = (path) => {
  const absolute = resolve(workspace, path);
  const child = relative(workspace, absolute);
  assert(child && !child.startsWith('..') && !isAbsolute(child), 'Evidence must be in workspace');
  return absolute;
};
const json = async (path) => JSON.parse(await readFile(local(path), 'utf8'));
const sha = async (path) =>
  createHash('sha256')
    .update(await readFile(local(path)))
    .digest('hex');
const date = (value) => {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  assert(Number.isFinite(parsed), 'Missing or invalid evidence timestamp');
  return parsed;
};

function bounded(value, stage, label) {
  const at = date(value);
  assert(
    at >= date(stage.startedAt) && at <= date(stage.finishedAt),
    `${label}: evidence must come from this Phase 21 command, not an earlier run`,
  );
}

async function proof(path) {
  return { evidence: path.replaceAll('\\', '/'), sha256: await sha(path) };
}

async function currentReport(directory, filename, stage, predicate) {
  const matches = [];
  for (const entry of await readdir(local(directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, filename);
    let value;
    try {
      value = await json(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const time = date(value.startedAt ?? value.checkedAt);
    if (time < date(stage.startedAt) || time > date(stage.finishedAt) || !predicate(value))
      continue;
    if (value.finishedAt) bounded(value.finishedAt, stage, `${path}: finishedAt`);
    bounded((await stat(local(path))).mtimeMs, stage, `${path}: file write`);
    matches.push({ value, ...(await proof(path)) });
  }
  assert.equal(matches.length, 1, `${stage.name}: need exactly one report from its command`);
  return matches[0];
}

function csv(text) {
  const rows = [];
  let row = [],
    cell = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (character === ',' || character === '\n')) {
      row.push(cell.replace(/\r$/, ''));
      cell = '';
      if (character === '\n') {
        rows.push(row);
        row = [];
      }
    } else cell += character;
  }
  assert.equal(quoted, false, 'Unclosed CSV field');
  if (cell || row.length) rows.push([...row, cell.replace(/\r$/, '')]);
  const [header, ...values] = rows;
  assert(header && new Set(header).size === header.length, 'Invalid CSV header');
  return values.map((value) => {
    assert.equal(value.length, header.length, 'Invalid CSV row');
    return Object.fromEntries(header.map((key, index) => [key, value[index]]));
  });
}

const initialFreeze = await json('.test-data/phase21/freeze-initial.json');
const frozen = await json('docs/phase21/freeze-results.json');
for (const value of [initialFreeze, frozen]) {
  assert(value.passed && value.phase === 21 && value.version === version);
  assert.equal(value.source.candidateCommit, candidateCommit);
  assert(value.allReleasesUnchanged && value.readOnlyRemote && !value.repackagePerformed);
}
assert.equal(initialFreeze.mode, 'initial-freeze');
assert.equal(initialFreeze.source.mainAtCheck, candidateCommit);
assert.deepEqual(frozen.assets, initialFreeze.assets, 'Frozen attachment tuple changed');
assert.deepEqual(frozen.olderPackages, initialFreeze.olderPackages, 'Older ZIP tuple changed');
for (const item of [...frozen.assets, ...frozen.olderPackages]) {
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(item.name), 'Unsafe frozen asset name');
  assert.equal(await sha(`artifacts/${item.name}`), item.sha256, `${item.name}: hash changed`);
  assert.equal((await stat(local(`artifacts/${item.name}`))).size, item.bytes);
}
const phase20 = await json('docs/phase20-results.json');
assert.equal(await sha('docs/phase20-results.json'), initialFreeze.phase20.reportSha256);
const release = await json(`artifacts/ProductSpy-${version}-release-manifest.json`);
assert.equal(release.version, version);
assert.deepEqual(release.portable, phase20.release.portable);
assert.deepEqual(release.extension, phase20.release.extension);
const packageRoot = `artifacts/ProductSpy-${version}-windows-x64`;
const bundleManifestSha256 = await sha(`${packageRoot}/bundle-manifest.json`);
const checks = await json('.test-data/phase21/checks.json');
assert(checks.passed && checks.phase === 21 && checks.version === version);
assert(!checks.activeCommand && checks.finishedAt, 'The Phase 21 pipeline is not complete');
assert(date(checks.startedAt) >= date(initialFreeze.checkedAt));
assert.deepEqual(
  checks.checks.map((item) => item.name),
  [
    'install',
    'typecheck',
    'lint',
    'format',
    'unit',
    'build',
    'e2e-and-screenshots',
    'portable',
    ...upgradeVersions.map((item) => `upgrade-${item}`),
    'zip-validation',
  ],
);
let previousEnd = date(checks.startedAt);
for (const item of checks.checks) {
  assert(item.passed && item.exitCode === 0, `${item.name}: command failed`);
  assert(date(item.startedAt) >= previousEnd, 'Commands must have recorded sequential boundaries');
  assert(date(item.finishedAt) >= date(item.startedAt));
  bounded(item.startedAt, checks, item.name);
  bounded(item.finishedAt, checks, item.name);
  assert.equal(await sha(item.evidence), item.logSha256, `${item.name}: log hash mismatch`);
  bounded((await stat(local(item.evidence))).mtimeMs, item, `${item.name}: log write`);
  previousEnd = date(item.finishedAt);
}
const stage = (name) => {
  const value = checks.checks.find((item) => item.name === name);
  assert(value, `Missing command: ${name}`);
  return value;
};

const unitPath = '.test-data/phase21/unit-report.json';
const unit = await json(unitPath);
bounded(unit.startTime, stage('unit'), 'Vitest start');
bounded((await stat(local(unitPath))).mtimeMs, stage('unit'), 'Vitest report write');
assert(unit.success && unit.numFailedTests === 0 && unit.numPendingTests === 0);
assert.equal(unit.numTodoTests, 0);
assert.equal(unit.testResults.length, phase20.unit.files);
assert.equal(unit.numPassedTests, phase20.unit.passed);
for (const file of unit.testResults) {
  assert.equal(file.status, 'passed');
  bounded(file.startTime, stage('unit'), 'Vitest file start');
  bounded(file.endTime, stage('unit'), 'Vitest file end');
  assert(file.assertionResults.every((item) => item.status === 'passed'));
}
const workflowStage = stage('e2e-and-screenshots');
const workflowPath = '.test-data/phase21/workflow.json';
const workflow = await json(workflowPath);
assert(workflow.passed && workflow.phase === 21 && workflow.version === version);
assert.equal(workflow.ai, 'mock');
assert.equal(workflow.paidRequests, 0);
bounded(workflow.startedAt, workflowStage, 'Frozen portable workflow start');
bounded(workflow.finishedAt, workflowStage, 'Frozen portable workflow end');
bounded((await stat(local(workflowPath))).mtimeMs, workflowStage, 'Workflow report write');
assert.equal(workflow.sessions.length, 2);
for (const session of workflow.sessions) {
  assert(session.verifiedOwned && session.version === version);
  assert(Number.isInteger(session.launcherPid) && session.launcherPid > 0);
  assert(session.dataRoot.startsWith('.test-data/phase21/workflow/'));
}
assert.equal(workflow.extensionFiles.length, 11);
assert.equal(new Set(workflow.extensionFiles.map((item) => item.file)).size, 11);
for (const item of workflow.extensionFiles) {
  assert(!item.file.startsWith('/') && !item.file.split(/[\\/]/).includes('..'));
  assert.equal(await sha(`${packageRoot}/extension/${item.file}`), item.sha256);
  assert.equal(await sha(`apps/extension/dist/${item.file}`), item.sha256);
}

const e2ePath = '.test-data/phase21/e2e-report.json';
const e2e = await json(e2ePath);
bounded(e2e.stats.startTime, workflowStage, 'E2E start');
bounded(date(e2e.stats.startTime) + e2e.stats.duration, workflowStage, 'E2E end');
bounded((await stat(local(e2ePath))).mtimeMs, workflowStage, 'E2E report write');
assert.equal(e2e.stats.expected, phase20.e2e.expected);
assert(e2e.stats.unexpected === 0 && e2e.stats.skipped === 0 && e2e.stats.flaky === 0);
assert.equal(e2e.errors?.length ?? 0, 0);
const portable = await currentReport(
  '.test-data/phase10-portable',
  'report.json',
  stage('portable'),
  (value) => value.package === `ProductSpy-${version}-windows-x64`,
);
assert(portable.value.passed && portable.value.checks.every((item) => item.passed));
assert.equal(portable.value.checks.length, phase20.portable.checks);
const upgrades = [];
for (const from of upgradeVersions) {
  const upgrade = await currentReport(
    '.test-data/phase20-upgrade',
    'report.json',
    stage(`upgrade-${from}`),
    (value) => value.fromVersion === from && value.toVersion === version,
  );
  assert(upgrade.value.fixtureOnly && upgrade.value.passed);
  assert(upgrade.value.checks.every((item) => item.passed));
  assert.equal(
    upgrade.value.checks.length,
    phase20.upgrades.find((item) => item.from === from).checks,
  );
  upgrades.push({
    from,
    to: version,
    checks: upgrade.value.checks.length,
    passed: true,
    fixtureOnly: true,
    evidence: upgrade.evidence,
    sha256: upgrade.sha256,
  });
}
const zip = await currentReport(
  '.test-data/release-validation',
  'zip-validation.json',
  stage('zip-validation'),
  (value) => value.version === version && value.portable?.file === release.portable.file,
);
assert(zip.value.passed && zip.value.failures.length === 0);
assert.equal(zip.value.checks.length, 4);
assert(zip.value.checks.every((item) => item.passed));
for (const key of ['portable', 'extension']) {
  assert.equal(zip.value[key].sha256, release[key].sha256);
  assert.equal(zip.value[key].bytes, release[key].bytes);
}

const screenshotPath = 'docs/screenshots/phase21/provenance.json';
const screenshots = await json(screenshotPath);
assert(screenshots.phase === 21 && screenshots.version === version);
assert(screenshots.verified && screenshots.production && screenshots.ai === 'mock');
assert.equal(screenshots.realAiCalls, 0);
assert.equal(screenshots.stableChromeManualAcceptance, false);
assert.equal(screenshots.interceptedResponses, false);
assert.equal(screenshots.portablePackage.bundleManifestSha256, bundleManifestSha256);
bounded(screenshots.capturedAt, workflowStage, 'Screenshot capture');
assert.equal(screenshots.screenshots.length, 57);
assert.equal(screenshots.pageErrors.length, 0);
for (const item of screenshots.screenshots) {
  assert(item.path.startsWith('docs/screenshots/phase21/'));
  assert(item.realRenderedInterface);
  assert.equal(await sha(item.path), item.sha256);
  bounded((await stat(local(item.path))).mtimeMs, workflowStage, 'Screenshot file write');
}
const manualPath = 'docs/phase21/manual-results.csv';
const manual = csv(await readFile(local(manualPath), 'utf8'));
assert.equal(manual.length, 53);
assert(manual.every((item) => item.status === 'pending' && item.candidate_version === version));
const scorecardPath = 'docs/phase21/ai-scorecard.csv';
const scorecard = csv(await readFile(local(scorecardPath), 'utf8'));
assert.equal(scorecard.length, 18);
assert(
  scorecard.every(
    (item) => item.status === 'not_executed_missing_authorization' && item.result === 'pending',
  ),
);
assert(
  scorecard.every(
    (item) => !item.request_id && !item.actual_billed_cost && !item.fact_accuracy_1_5,
  ),
);
const aiSamples = await json('docs/phase21/ai-samples.json');
assert.equal(aiSamples.authorization.approved, false);
assert.equal(aiSamples.execution.externalPaidRequests, 0);
assert.equal(aiSamples.execution.realModelQualityVerified, false);
assert.equal(aiSamples.samples.length, 6);

const amazonPath = 'docs/phase21/amazon-results.json';
const amazon = await json(amazonPath);
assert(amazon.phase === 21 && amazon.realPages && !amazon.mock);
assert.equal(amazon.denominator.initialPrimaryPages, 10);
assert.equal(amazon.denominator.captured, 8);
assert.equal(amazon.batches.length, 1);
for (const batch of amazon.batches) {
  assert.equal(await sha(`${batch.evidenceDirectory}/report.json`), batch.reportSha256);
  assert.equal(await sha(`${batch.evidenceDirectory}/audit.json`), batch.auditSha256);
  assert.equal(batch.releaseVersion, version);
  assert.equal(batch.browser.stableChromeManualAcceptance, false);
}
const videoProbePath = 'docs/phase21/video-timing-probe.json';
const videoProbe = await json(videoProbePath);
assert.equal(videoProbe.livePageRevisited, false);
assert.equal(
  videoProbe.frozenContentScriptSha256,
  await sha(`${packageRoot}/extension/content.js`),
);
for (const row of videoProbe.rows.slice(0, 2)) {
  assert.equal(row.liveCapturedVideoCount, 0);
  assert.equal(row.frozenRetainedHtmlStatus, 'captured');
  assert.equal(row.frozenRetainedHtmlVideos.length, 1);
  assert.equal(row.currentRetainedHtmlVideoCount, 1);
}

const mediaPath = 'docs/phase21/media-preview-check.json';
const media = await json(mediaPath);
assert(media.phase === 21 && media.version === version);
assert(media.realAiCalls === 0 && media.stableChromeManual === false);
assert.equal(media.frozenBundleManifestSha256, bundleManifestSha256);
assert.equal(media.pageErrors.length, 0);
assert.equal(media.observations.length, 2);
for (const observation of media.observations) {
  const visible = observation.images.filter((image) => image.visibleInViewport);
  assert.equal(observation.readiness, 'ready');
  assert(
    visible.length > 0 &&
      visible.every((image) => image.complete && image.width > 0 && image.height > 0),
  );
}
for (const file of media.screenshots) assert.equal(await sha(file.path), file.sha256);

const attemptPath = '.test-data/phase21/attempt-1/checks.json';
const firstAttempt = await json(attemptPath);
assert.equal(firstAttempt.passed, false);
const failedLint = firstAttempt.checks.find((item) => item.name === 'lint');
assert(failedLint && !failedLint.passed && failedLint.exitCode !== 0);
assert.equal(await sha('.test-data/phase21/attempt-1/lint.log'), failedLint.logSha256);
const initialFailures = [];
for (const entry of await readdir(local('.test-data/phase21'), { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^attempt-\d+$/.test(entry.name)) continue;
  const directory = `.test-data/phase21/${entry.name}`;
  const attempt = await json(`${directory}/checks.json`);
  assert(!attempt.passed && attempt.finishedAt, 'Original failed attempt must remain recorded');
  for (const failed of attempt.checks.filter((item) => item.exitCode !== 0)) {
    assert.equal(failed.passed, false);
    const logPath = `${directory}/${basename(failed.evidence)}`;
    assert.equal(await sha(logPath), failed.logSha256, 'Original failure log must be retained');
    const rerun = stage(failed.name);
    assert.equal(rerun.command, failed.command, 'Rerun must retain the failed command');
    initialFailures.push({
      stage: failed.name,
      command: failed.command,
      exitCode: failed.exitCode,
      startedAt: failed.startedAt,
      finishedAt: failed.finishedAt,
      originalAttempt: await proof(`${directory}/checks.json`),
      log: await proof(logPath),
      classification:
        'Actual failed command retained; failure cause and any product impact must be assessed from evidence, not inferred as a user defect.',
      rerunEvidence: rerun.evidence,
      rerunLogSha256: rerun.logSha256,
      rerunPassed: rerun.passed,
    });
  }
}
assert(initialFailures.some((item) => item.stage === 'lint'));
const finalSourceChecks = await json('.test-data/phase21/final-checks.json');
assert(finalSourceChecks.passed && finalSourceChecks.checks.length === 3);
assert(date(finalSourceChecks.startedAt) >= date(checks.finishedAt));
for (const item of finalSourceChecks.checks) {
  assert(item.passed && item.exitCode === 0);
  assert.equal(await sha(item.evidence), item.logSha256);
}
const result = {
  phase: 21,
  version,
  generatedAt: new Date().toISOString(),
  passed: true,
  meaningOfPassed:
    'Frozen candidate integrity and this engineering rerun only; manual and real AI quality remain pending.',
  environment: await json('.test-data/phase21/environment.json'),
  desktop: {
    ...(await json('docs/phase21/desktop-evidence.json')),
    ...(await proof('docs/phase21/desktop-evidence.json')),
  },
  baseline: {
    candidateCommit,
    candidateVersion: version,
    initialFreezeAt: initialFreeze.checkedAt,
    frozenCandidateUnchanged: true,
    remoteReleaseStillDraft: true,
    rebuiltOrRepackaged: false,
    evidence: 'docs/phase21/freeze-results.json',
    sha256: await sha('docs/phase21/freeze-results.json'),
    initialEvidence: '.test-data/phase21/freeze-initial.json',
    initialSha256: await sha('.test-data/phase21/freeze-initial.json'),
  },
  checks: {
    ...(await proof('.test-data/phase21/checks.json')),
    startedAt: checks.startedAt,
    finishedAt: checks.finishedAt,
    commands: checks.checks,
  },
  unit: {
    files: unit.testResults.length,
    passed: unit.numPassedTests,
    failed: unit.numFailedTests,
    pending: unit.numPendingTests,
    ...(await proof(unitPath)),
  },
  e2e: {
    ...e2e.stats,
    ...(await proof(e2ePath)),
    browserScope:
      'Chrome for Testing; actual frozen portable service; fixtures and Mock; not stable Chrome manual acceptance',
  },
  frozenPortableWorkflow: {
    passed: true,
    aiMode: 'mock',
    paidRequests: 0,
    sessions: workflow.sessions,
    extensionFileCount: workflow.extensionFiles.length,
    builtExtensionBytesMatchFrozen: true,
    extensionFiles: workflow.extensionFiles,
    ...(await proof(workflowPath)),
  },
  portable: {
    passed: true,
    checks: portable.value.checks.length,
    startedAt: portable.value.startedAt,
    finishedAt: portable.value.finishedAt,
    evidence: portable.evidence,
    sha256: portable.sha256,
    nativeGuiAcceptance: false,
  },
  upgrades,
  zip: {
    passed: true,
    checks: zip.value.checks,
    failures: zip.value.failures,
    checkedAt: zip.value.checkedAt,
    portable: Object.fromEntries(
      Object.entries(zip.value.portable).filter(([key]) => key !== 'files'),
    ),
    extension: Object.fromEntries(
      Object.entries(zip.value.extension).filter(([key]) => key !== 'files'),
    ),
    evidence: zip.evidence,
    sha256: zip.sha256,
    inventoryScope:
      'Detailed CRC/path/private-file inventory remains in the hashed validation report; not duplicated here.',
  },
  release,
  frozenAttachments: frozen.assets,
  olderArchiveCountUnchanged: frozen.olderPackages.length,
  screenshots: {
    count: screenshots.screenshots.length,
    ...(await proof(screenshotPath)),
    capturedAt: screenshots.capturedAt,
    production: true,
    bundleManifestSha256,
    browser: screenshots.browser,
    aiMode: 'mock',
    stableChromeManualAcceptance: false,
    productSource: screenshots.productSource,
    sourceEvidence: screenshots.sourceEvidence,
    newAmazonAccuracyAcceptance: false,
    pairingSmallWindowRootCauseResolved: false,
    files: screenshots.screenshots,
  },
  manual: {
    total: manual.length,
    pending: manual.length,
    passed: 0,
    ...(await proof(manualPath)),
    formalWindowsGuiPassed: false,
    stableChromePassed: false,
    evidenceRequirements: 'docs/phase21/evidence-requirements.md',
    pendingSteps: 'docs/phase21/manual-acceptance.md',
  },
  realAi: {
    authorized: false,
    paidRequests: 0,
    realModelQualityVerified: false,
    preparedCategories: aiSamples.samples.length,
    plannedFunctionEvaluations: scorecard.length,
    executedEvaluations: 0,
    pendingEvaluations: scorecard.length,
    scores: null,
    actualCost: null,
    scorecard: await proof(scorecardPath),
    preparation: 'docs/phase21/ai-preparation.md',
  },
  realAmazon: {
    ...(await proof(amazonPath)),
    denominator: amazon.denominator,
    batches: amazon.batches,
    stableChromeManualAcceptance: false,
    videoPlaybackVerified: false,
    unresolvedVideoSnapshotDifferences: 2,
    videoProbe: await proof(videoProbePath),
    interpretation:
      'Two live captures lacked videos present in later HTML. Frozen and current extractors both parse the retained HTML correctly. Capture-time state was not frozen; asynchronous timing remains unconfirmed, not a proven parser fix.',
  },
  supplementalMediaPreview: {
    ...(await proof(mediaPath)),
    version,
    browser: media.browser,
    startedAt: media.startedAt,
    finishedAt: media.finishedAt,
    screenshots: media.screenshots,
    visibleImageDecodeVerified: true,
    stableChromeManualAcceptance: false,
    originalBlankPreviewScreenshotsRetained: true,
  },
  initialFailures,
  finalSourceChecks,
  acceptance: {
    featureDevelopmentComplete: true,
    engineeringAutomationPassed: true,
    fullRealEnvironmentAcceptancePassed: false,
    realModelQualityVerified: false,
    publicRelease: false,
    recommendV100PublicRelease: false,
    releaseBlockedByMissingEvidence: true,
  },
  limits: [
    'Stable Chrome toolbar/manual installation, original small pairing window and Windows native GUI remain pending; CFT and headless portable do not replace them.',
    'Phase 21 real Amazon evidence uses CFT; two primary navigation timeouts and two video snapshot differences remain recorded. Video playback is unverified. UI screenshot products are explicitly historical public captures.',
    '125/150/200 percent Windows display scaling, SmartScreen, native directory selection and controlled permission denial still need actual desktop evidence.',
    'Physical power loss and disk failure were not performed; actual-file fault injection and upgrade tests have a narrower scope.',
    'Real AI requires explicit model, Key, request limit and budget authorization; no paid calls or model quality scores were produced.',
  ],
};
const destination = local('docs/phase21-results.json');
await writeFile(
  destination,
  await format(JSON.stringify(result), { ...(await resolveConfig(destination)), parser: 'json' }),
);
console.log(
  JSON.stringify({
    phase: result.phase,
    version,
    engineeringPassed: true,
    unit: result.unit.passed,
    e2e: result.e2e.expected,
    portable: result.portable.checks,
    upgrades: result.upgrades.length,
    screenshots: result.screenshots.count,
    manualPending: result.manual.pending,
    realAiPending: result.realAi.pendingEvaluations,
    publicRelease: false,
  }),
);
