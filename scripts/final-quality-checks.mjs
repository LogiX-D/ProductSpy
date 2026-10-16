import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { version as osVersion, release, arch } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

// QA only: never packages, changes a Release, or uses the daily user directory.
const { values } = parseArgs({
  options: { stage: { type: 'string' }, output: { type: 'string' } },
});
const workspace = resolve(import.meta.dirname, '..');
const parent = join(workspace, '.test-data/final-quality');
const output = resolve(values.output ?? '');
assert(output.startsWith(parent + sep), 'Use a new .test-data/final-quality/<run> directory.');
assert(['freeze', 'foundation', 'regression', 'final', 'verify'].includes(values.stage));
await mkdir(output, { recursive: true });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const rel = (file) => relative(workspace, file).replaceAll('\\', '/');
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
async function inventory() {
  const names = (await readdir(join(workspace, 'artifacts')))
    .filter((name) => /^ProductSpy-.*-(windows-x64|extension)\.zip$/.test(name))
    .sort();
  const receipt = await json(join(workspace, 'artifacts/ProductSpy-1.0.0-upload-manifest.json'));
  const paths = new Set([
    ...names.map((name) => `artifacts/${name}`),
    ...receipt.assets.map((asset) => `artifacts/${asset.name}`),
    'artifacts/release-manifest.json',
    'artifacts/ProductSpy-1.0.0-upload-manifest.json',
    'docs/stable-release.json',
    'docs/stable-release-validation.json',
    'docs/phase21/manual-results.csv',
  ]);
  return Promise.all(
    [...paths].sort().map(async (path) => {
      const bytes = await readFile(join(workspace, path));
      return { path, bytes: bytes.length, sha256: sha(bytes) };
    }),
  );
}
function normalizeReleases(rows) {
  return rows
    .flat()
    .map((row) => ({
      id: row.id,
      tag: row.tag_name,
      name: row.name,
      body: row.body,
      target: row.target_commitish,
      draft: row.draft,
      prerelease: row.prerelease,
      publishedAt: row.published_at,
      updatedAt: row.updated_at,
      assets: row.assets
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          size: asset.size,
          digest: asset.digest,
          updatedAt: asset.updated_at,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.id - b.id);
}
if (values.stage === 'freeze') {
  const releases = normalizeReleases(await json(join(parent, 'releases-before.json')));
  const stable = releases.find((row) => row.tag === 'v1.0.0');
  assert(stable?.draft && stable.publishedAt === null && stable.assets.length === 7);
  const baseline = {
    startedAt: new Date().toISOString(),
    clientDate: '2026-10-17',
    source: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    environment: {
      os: osVersion(),
      release: release(),
      arch: arch(),
      node: process.version,
      pnpm: execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'pnpm --version'],
        { encoding: 'utf8', windowsHide: true },
      ).trim(),
    },
    files: await inventory(),
    releases,
  };
  await writeFile(join(output, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      source: baseline.source,
      frozenFiles: baseline.files.length,
      releases: releases.length,
    }),
  );
} else if (values.stage === 'verify') {
  const baseline = await json(join(output, 'baseline.json'));
  assert.deepEqual(
    await inventory(),
    baseline.files,
    'Frozen artifacts, receipts or manual CSV changed.',
  );
  const after = normalizeReleases(await json(join(parent, 'releases-after.json')));
  assert.deepEqual(after, baseline.releases, 'Release or asset metadata changed.');
  const checks = [
    {
      name: 'all frozen ZIPs, seven stable assets, receipts and manual CSV unchanged',
      status: 'PASS',
      files: baseline.files.length,
    },
    {
      name: 'all GitHub Releases and attachment identities/digests unchanged',
      status: 'PASS',
      releases: after.length,
    },
    {
      name: 'production source unchanged',
      status:
        git(
          'diff',
          baseline.source,
          '--',
          'apps',
          'packages',
          'launcher',
          'pnpm-lock.yaml',
          'package.json',
        ) === ''
          ? 'PASS'
          : 'FAIL',
    },
  ];
  assert(checks.every((row) => row.status === 'PASS'));
  await writeFile(
    join(output, 'preservation.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2) + '\n',
  );
  console.log(JSON.stringify(checks));
} else {
  await readFile(join(output, 'baseline.json'));
  const unit = (index) => [
    'unit-' + index,
    `pnpm test --reporter=default --reporter=json --outputFile='${rel(join(output, `unit-${index}.json`))}'`,
  ];
  const commands =
    values.stage === 'foundation'
      ? [
          ['install', 'pnpm install --frozen-lockfile'],
          ['typecheck', 'pnpm typecheck'],
          ['format-write', 'pnpm format'],
          ['lint', 'pnpm lint'],
          ['format-check', 'pnpm format:check'],
          unit(1),
          ['build', 'pnpm build'],
          unit(2),
          unit(3),
        ]
      : values.stage === 'final'
        ? [
            ['final-lint', 'pnpm lint'],
            ['final-format-check', 'pnpm format:check'],
            [
              'unit-final',
              `pnpm test --reporter=default --reporter=json --outputFile='${rel(join(output, 'unit-final.json'))}'`,
            ],
          ]
        : [
            ['e2e', 'node scripts/rc2-portable-workflow.mjs'],
            ['portable', 'pnpm test:portable'],
            ...[
              '1.0.0-rc.2',
              '1.0.0-rc.1',
              '0.8.0',
              '0.7.0',
              '0.6.0',
              '0.5.2',
              '0.5.1',
              '0.5.0',
              '0.4.0',
            ].map((version) => [
              `upgrade-${version}`,
              `pnpm test:upgrade --from artifacts/ProductSpy-${version}-windows-x64 --to artifacts/ProductSpy-1.0.0-windows-x64`,
            ]),
            [
              'backup-regression',
              `node scripts/run-stable-backup-validation.mjs --stage regression --output '${rel(join(workspace, '.test-data/v100-backup-restore', 'final-quality-' + output.split(sep).at(-1)))}'`,
            ],
            [
              'backup-workflow',
              `node scripts/run-stable-backup-validation.mjs --stage workflow --output '${rel(join(workspace, '.test-data/v100-backup-restore', 'final-quality-' + output.split(sep).at(-1)))}'`,
            ],
            ['zip-validation', 'node scripts/validate-release.mjs'],
          ];
  const report = {
    stage: values.stage,
    startedAt: new Date().toISOString(),
    checks: [],
    paidAiCalls: 0,
  };
  const reportFile = join(
    output,
    (values.stage === 'final' ? 'final-gates' : values.stage) + '.json',
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')),
  );
  Object.assign(env, {
    AI_MODE: 'mock',
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    PRODUCTSPY_RELEASE_EVIDENCE_DIR: output,
  });
  for (const [name, command] of commands) {
    const log = join(output, name + '.log');
    await writeFile(log, '', { flag: 'wx' });
    const startedAt = new Date().toISOString();
    console.log(`Running ${name}: ${command}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes) => appendFileSync(log, bytes));
    child.stderr.on('data', (bytes) => appendFileSync(log, bytes));
    const exitCode = await new Promise((complete, reject) => {
      child.once('error', reject);
      child.once('close', complete);
    });
    const bytes = await readFile(log);
    const finishedAt = new Date().toISOString();
    report.checks.push({
      name,
      command,
      status: exitCode === 0 ? 'PASS' : 'FAIL',
      exitCode,
      startedAt,
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
      log: rel(log),
      bytes: (await stat(log)).size,
      sha256: sha(bytes),
    });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
    console.log(`${name}: ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
    if (exitCode !== 0) console.log(bytes.toString('utf8').slice(-5000));
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every((check) => check.status === 'PASS');
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
  process.exitCode = report.passed ? 0 : 1;
}
