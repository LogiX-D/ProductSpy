import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { validateExtensionRelease } from './packaging/release-version.mjs';

// Verification only: never build, upload, alter a Release, or touch user data.
const workspace = resolve(import.meta.dirname, '..');
const evidence = join(workspace, '.test-data/phase21');
const publicDirectory = join(workspace, 'docs/phase21');
const version = '1.0.0-rc.1';
const repository = 'LogiX-D/ProductSpy';
const candidateCommit = 'bcf049d45e65ea6da798b53aa6b57b20508927f9';
const expectedNames = [
  `ProductSpy-${version}-windows-x64.zip`,
  `ProductSpy-${version}-extension.zip`,
  `ProductSpy-${version}-screenshots.zip`,
  `ProductSpy-${version}-release-manifest.json`,
  `ProductSpy-${version}-validation.md`,
  `ProductSpy-${version}-validation.json`,
  `ProductSpy-${version}-security.md`,
  `ProductSpy-${version}-user-guide.md`,
  `ProductSpy-${version}-workflow-guide.md`,
  'SHA256SUMS.txt',
].sort();
const arguments_ = process.argv.slice(2);
const allowedArguments = new Set(['--verify-again', '--no-public-save']);
assert(
  arguments_.every((argument) => allowedArguments.has(argument)),
  'Unknown freeze argument',
);
assert.equal(new Set(arguments_).size, arguments_.length, 'Duplicate freeze argument');
const verifyAgain = arguments_.includes('--verify-again');
const noPublicSave = arguments_.includes('--no-public-save');
assert(!noPublicSave || verifyAgain, '--no-public-save requires --verify-again');
const run = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const fromWeb = createRequire(join(workspace, 'apps/web/package.json'));
const JSZip = fromWeb('jszip');
const report = {
  phase: 21,
  version,
  checkedAt: new Date().toISOString(),
  mode: verifyAgain ? 'verify-again' : 'initial-freeze',
  passed: false,
  readOnlyRemote: true,
  repackagePerformed: false,
  realAiCalls: 0,
  publicReportWritten: !noPublicSave,
};

async function gh(endpoint) {
  const { stdout } = await run('gh', ['api', endpoint], {
    cwd: workspace,
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function assetState(asset) {
  return {
    id: asset.id,
    name: asset.name,
    label: asset.label,
    state: asset.state,
    bytes: asset.size,
    digest: asset.digest,
    contentType: asset.content_type,
    createdAt: asset.created_at,
    updatedAt: asset.updated_at,
  };
}

function releaseState(release) {
  return {
    id: release.id,
    tag: release.tag_name,
    target: release.target_commitish,
    title: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    immutable: release.immutable,
    createdAt: release.created_at,
    updatedAt: release.updated_at,
    publishedAt: release.published_at,
    releaseUrl: release.html_url,
    bodySha256: sha(release.body ?? ''),
    assets: release.assets.map(assetState).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const states = (releases) => releases.map(releaseState).sort((a, b) => a.id - b.id);

async function verifyLocalAsset(asset) {
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(asset.name), 'Unsafe asset name');
  assert(/^sha256:[a-f0-9]{64}$/.test(asset.digest), `${asset.name}: remote digest missing`);
  const bytes = await readFile(join(workspace, 'artifacts', asset.name));
  assert.equal(bytes.length, asset.size, `${asset.name}: remote size differs`);
  const hash = sha(bytes);
  assert.equal(`sha256:${hash}`, asset.digest, `${asset.name}: remote hash differs`);
  return { name: asset.name, bytes: bytes.length, sha256: hash, remoteAssetId: asset.id };
}

await mkdir(evidence, { recursive: true });
if (!noPublicSave) await mkdir(publicDirectory, { recursive: true });
const stamp = report.checkedAt.replaceAll(':', '-').replaceAll('.', '-');
try {
  const originalSnapshot = await readFile(join(evidence, 'releases-before.json'));
  const before = JSON.parse(originalSnapshot.toString('utf8'));
  assert(Array.isArray(before) && before.length > 0, 'Missing initial remote Release inventory');
  const current = await gh(`repos/${repository}/releases?per_page=100`);
  assert(Array.isArray(current) && current.length < 100, 'Release inventory needs pagination');
  const main = await gh(`repos/${repository}/commits/main`);
  const candidate = current.find((release) => release.tag_name === `v${version}`);
  assert(candidate, 'Candidate draft is missing');
  assert.equal(candidate.draft, true, 'Candidate must remain draft');
  assert.equal(candidate.prerelease, true, 'Candidate must remain prerelease');
  assert.equal(candidate.published_at, null, 'Candidate must not be publicly published');
  assert.equal(candidate.target_commitish, candidateCommit, 'Candidate source target changed');
  assert.deepEqual(states(current), states(before), 'A Release or its attachment tuple changed');
  assert.deepEqual(candidate.assets.map((asset) => asset.name).sort(), expectedNames);
  await writeFile(
    join(evidence, `freeze-remote-${stamp}.json`),
    JSON.stringify({ checkedAt: report.checkedAt, main: main.sha, releases: current }, null, 2) +
      '\n',
  );

  report.source = {
    candidateCommit,
    mainAtCheck: main.sha,
    localHead: (await run('git', ['rev-parse', 'HEAD'], { cwd: workspace })).stdout.trim(),
    beforeInventorySha256: sha(originalSnapshot),
  };
  if (!verifyAgain) {
    assert.equal(main.sha, candidateCommit, 'Initial main must match the frozen candidate source');
  }
  await run('git', ['merge-base', '--is-ancestor', candidateCommit, main.sha], {
    cwd: workspace,
  });
  const changedSinceCandidate = (
    await run('git', ['diff', '--name-only', candidateCommit, main.sha], { cwd: workspace })
  ).stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const isQaOrDocumentation = (path) =>
    /^(?:docs|e2e)\//.test(path) ||
    /^(?:README|CHANGELOG)\.md$/.test(path) ||
    /^(?:playwright|vitest)\.config\.ts$/.test(path) ||
    /^scripts\/(?:phase21-[\w-]+|test-[\w-]+|validate-release)\.(?:mjs|ps1)$/.test(path) ||
    [
      'scripts/phase16-amazon-capture.mjs',
      'scripts/phase16-amazon-audit.mjs',
      'scripts/phase20-screenshots.mjs',
    ].includes(path) ||
    /(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(path);
  assert(
    changedSinceCandidate.every(isQaOrDocumentation),
    'main changed production source since rc.1; a new candidate version and acceptance are required',
  );
  report.source.mainIsCandidateOrQaOnlyDescendant = true;
  report.source.changedSinceCandidate = changedSinceCandidate;
  report.releases = states(current);
  report.allReleasesUnchanged = true;
  report.olderReleasesUnchanged = current.length - 1;
  report.releaseUrl = candidate.html_url;
  report.assets = [];
  for (const asset of candidate.assets) report.assets.push(await verifyLocalAsset(asset));
  report.assets.sort((a, b) => a.name.localeCompare(b.name));

  report.olderPackages = [];
  for (const release of current.filter((item) => item.id !== candidate.id)) {
    for (const asset of release.assets) {
      if (/^ProductSpy-[\d.]+-(?:windows-x64|extension)\.zip$/.test(asset.name)) {
        report.olderPackages.push(await verifyLocalAsset(asset));
      }
    }
  }
  report.olderPackages.sort((a, b) => a.name.localeCompare(b.name));

  const checksumText = await readFile(join(workspace, 'artifacts/SHA256SUMS.txt'), 'utf8');
  const checksumRows = checksumText
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/.exec(line);
      assert(match, 'Invalid checksum line');
      return { sha256: match[1], name: match[2] };
    });
  assert.equal(checksumRows.length, expectedNames.length - 1);
  assert.equal(new Set(checksumRows.map((item) => item.name)).size, checksumRows.length);
  for (const row of checksumRows) {
    const asset = report.assets.find((item) => item.name === row.name);
    assert(asset && asset.sha256 === row.sha256, 'Checksum file does not match frozen attachment');
  }

  report.sourceVersions = {};
  for (const path of [
    'package.json',
    'apps/web/package.json',
    'apps/extension/package.json',
    'packages/shared/package.json',
  ]) {
    const packageJson = await json(join(workspace, path));
    assert.equal(packageJson.version, version, `${path}: source version differs`);
    report.sourceVersions[path] = packageJson.version;
  }
  assert.match(
    await readFile(join(workspace, 'packages/shared/src/version.ts'), 'utf8'),
    /PRODUCTSPY_VERSION = '1\.0\.0-rc\.1'/,
  );
  const phase20 = await json(join(workspace, 'docs/phase20-results.json'));
  const manifest = await json(
    join(workspace, `artifacts/ProductSpy-${version}-release-manifest.json`),
  );
  assert(phase20.passed && phase20.version === version);
  assert.deepEqual(phase20.release.portable, manifest.portable);
  assert.deepEqual(phase20.release.extension, manifest.extension);
  for (const entry of [manifest.portable, manifest.extension]) {
    const asset = report.assets.find((item) => item.name === entry.file);
    assert(asset && asset.sha256 === entry.sha256 && asset.bytes === entry.bytes);
  }
  const extensionZip = await JSZip.loadAsync(
    await readFile(join(workspace, 'artifacts', manifest.extension.file)),
  );
  const extension = JSON.parse(await extensionZip.file('manifest.json').async('string'));
  const sourceExtension = await json(join(workspace, 'apps/extension/manifest.json'));
  assert.deepEqual(extension, sourceExtension, 'Source and frozen extension manifests differ');
  validateExtensionRelease(extension, version);
  assert.deepEqual(extension.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(extension.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*']);
  assert.deepEqual(extension.content_security_policy, {
    extension_pages: "script-src 'self'; object-src 'self';",
  });
  assert.equal(extension.background.service_worker, 'background.js');
  assert.equal(extension.background.type, 'module');
  assert.equal(extension.web_accessible_resources, undefined);
  report.extension = {
    manifestVersion: extension.manifest_version,
    version: extension.version,
    versionName: extension.version_name,
    minimumChromeVersion: extension.minimum_chrome_version,
    permissions: extension.permissions,
    hostPermissions: extension.host_permissions,
    csp: extension.content_security_policy,
    sourceMatchesFrozenManifest: true,
  };
  report.phase20 = {
    reportSha256: sha(await readFile(join(workspace, 'docs/phase20-results.json'))),
    reportPassed: true,
    packageManifestMatches: true,
    unit: phase20.unit,
    e2e: phase20.e2e,
    portableChecks: phase20.portable.checks,
    upgradePaths: phase20.upgrades.map(({ from, to, checks, passed }) => ({
      from,
      to,
      checks,
      passed,
    })),
    evidenceScope: 'Historical Phase 20 results; Phase 21 reruns are reported separately',
  };
  if (verifyAgain) {
    const initial = await json(join(evidence, 'freeze-initial.json'));
    assert(initial.passed && initial.mode === 'initial-freeze');
    assert.equal(initial.source.mainAtCheck, candidateCommit);
    assert.deepEqual(report.assets, initial.assets, 'Candidate attachment tuples changed');
    assert.deepEqual(
      report.olderPackages,
      initial.olderPackages,
      'Older local package hashes changed',
    );
    assert.deepEqual(
      report.releases,
      initial.releases,
      'Remote Releases changed since initial freeze',
    );
    assert.deepEqual(
      report.extension,
      initial.extension,
      'Candidate extension permissions changed',
    );
    assert.deepEqual(report.phase20, initial.phase20, 'Phase 20 evidence changed');
    assert.equal(report.source.beforeInventorySha256, initial.source.beforeInventorySha256);
    report.initialCheckAt = initial.checkedAt;
    report.reverifiedUnchanged = true;
  }
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const output = JSON.stringify(report, null, 2) + '\n';
  await writeFile(join(evidence, `freeze-${stamp}.json`), output);
  if (report.passed && !verifyAgain) {
    await writeFile(join(evidence, 'freeze-initial.json'), output, { flag: 'wx' });
  }
  if (!noPublicSave) {
    const publicPath = join(publicDirectory, 'freeze-results.json');
    await writeFile(
      publicPath,
      await format(output, { ...(await resolveConfig(publicPath)), parser: 'json' }),
    );
  }
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        mode: report.mode,
        checkedAt: report.checkedAt,
        source: report.source,
        candidateAssets: report.assets?.length,
        olderPackages: report.olderPackages?.length,
        releasesUnchanged: report.allReleasesUnchanged,
        publicReportWritten: !noPublicSave,
        evidence: `.test-data/phase21/freeze-${stamp}.json`,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
