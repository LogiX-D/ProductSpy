import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.test-data/stable-release');
const version = '1.0.0';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(output, { recursive: true });
const stage = process.argv[2];
if (stage === 'freeze') {
  const releases = JSON.parse(
    execFileSync('gh', ['api', 'repos/LogiX-D/ProductSpy/releases', '--paginate', '--slurp'], {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
    }),
  ).flat();
  assert(
    !releases.some((r) => r.tag_name === 'v1.0.0'),
    'A stable Release already exists; inspect it before proceeding.',
  );
  const packages = [];
  for (const name of await readdir(join(root, 'artifacts'))) {
    if (!/^ProductSpy-.*-(?:windows-x64|extension)\.zip$/.test(name)) continue;
    const bytes = await readFile(join(root, 'artifacts', name));
    packages.push({ name, bytes: bytes.length, sha256: sha(bytes) });
  }
  assert(packages.some((p) => p.name === 'ProductSpy-1.0.0-rc.2-extension.zip'));
  const baseline = {
    clientDate: '2026-10-16',
    observedAt: new Date().toISOString(),
    sourceAtStart: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    releases: releases.map((r) => ({
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
    })),
    packages,
  };
  await writeFile(join(output, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n', {
    flag: 'wx',
  });
  console.log(
    JSON.stringify({
      releases: releases.length,
      packages: packages.length,
      source: baseline.sourceAtStart,
    }),
  );
} else {
  const stages = {
    build: [
      ['install', 'pnpm install --frozen-lockfile'],
      ['typecheck', 'pnpm typecheck'],
      ['lint', 'pnpm lint'],
      ['format', 'pnpm format:check'],
      [
        'unit',
        'pnpm test --reporter=default --reporter=json --outputFile=.test-data/stable-release/unit.json',
      ],
      ['build', 'pnpm build'],
      ['package', 'node scripts/package-windows.mjs'],
    ],
    regression: [
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
      ].map((from) => [
        `upgrade-${from}`,
        `pnpm test:upgrade --from artifacts/ProductSpy-${from}-windows-x64 --to artifacts/ProductSpy-${version}-windows-x64`,
      ]),
      ['zip-validation', 'node scripts/validate-release.mjs'],
    ],
  };
  assert(Object.hasOwn(stages, stage), 'Use stable-release-checks.mjs freeze|build|regression');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version, version);
  await readFile(join(output, 'baseline.json'));
  const directory = join(output, `${stage}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(directory, { recursive: true });
  const report = {
    version,
    stage,
    startedAt: new Date().toISOString(),
    paidAiCalls: 0,
    passed: false,
    checks: [],
  };
  const save = () =>
    writeFile(join(directory, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')),
  );
  Object.assign(env, {
    AI_MODE: 'mock',
    CI: '1',
    NEXT_TELEMETRY_DISABLED: '1',
    PRODUCTSPY_RELEASE_EVIDENCE_DIR: output,
  });
  try {
    for (const [name, command] of stages[stage]) {
      report.activeCommand = command;
      await save();
      const log = join(directory, `${name}.log`);
      await writeFile(log, '', { flag: 'wx' });
      const startedAt = new Date().toISOString();
      console.log(`Running ${command}`);
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (bytes) => appendFileSync(log, bytes));
      child.stderr.on('data', (bytes) => appendFileSync(log, bytes));
      const exitCode = await new Promise((complete, reject) => {
        child.once('error', reject);
        child.once('close', complete);
      });
      const bytes = await readFile(log);
      report.checks.push({
        name,
        command,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
        passed: exitCode === 0,
        log: relative(root, log).replaceAll('\\', '/'),
        sha256: sha(bytes),
      });
      delete report.activeCommand;
      await save();
      console.log(`${name}: ${exitCode === 0 ? 'passed' : 'FAILED'}`);
      if (exitCode !== 0) console.log(bytes.toString('utf8').slice(-8000));
      assert.equal(exitCode, 0, `${command} failed; original evidence retained`);
    }
    report.passed = true;
  } finally {
    report.finishedAt = new Date().toISOString();
    await save();
    await writeFile(join(output, `${stage}-latest.json`), JSON.stringify(report, null, 2) + '\n');
  }
}
