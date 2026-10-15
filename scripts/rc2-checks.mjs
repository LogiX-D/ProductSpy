import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.test-data/rc2-hotfix');
await mkdir(output, { recursive: true });
const stages = {
  build: [
    ['install', 'pnpm install --frozen-lockfile'],
    ['typecheck', 'pnpm typecheck'],
    ['lint', 'pnpm lint'],
    ['format', 'pnpm format:check'],
    [
      'unit',
      'pnpm test --reporter=default --reporter=json --outputFile=.test-data/rc2-hotfix/unit.json',
    ],
    ['build', 'pnpm build'],
    ['package', 'node scripts/package-windows.mjs'],
  ],
  regression: [
    ['e2e', 'node scripts/rc2-portable-workflow.mjs'],
    ['portable', 'pnpm test:portable'],
    ...['1.0.0-rc.1', '0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0'].map(
      (version) => [
        `upgrade-${version}`,
        `pnpm test:upgrade --from artifacts/ProductSpy-${version}-windows-x64 --to artifacts/ProductSpy-1.0.0-rc.2-windows-x64`,
      ],
    ),
    ['zip-validation', 'node scripts/validate-release.mjs'],
  ],
};
const stage = process.argv[2];
assert(Object.hasOwn(stages, stage), 'Use rc2-checks.mjs build|regression');
const resumeArgument = process.argv.indexOf('--resume');
let previous;
let resumePath;
let frozenArtifacts;
if (resumeArgument !== -1) {
  assert.equal(stage, 'regression', 'Only regression may resume against frozen package hashes');
  resumePath = process.argv[resumeArgument + 1];
  assert(resumePath, 'Use --resume <retained checks.json>');
  previous = JSON.parse(await readFile(resumePath, 'utf8'));
  assert(previous.version === '1.0.0-rc.2' && previous.stage === stage && !previous.passed);
  const diagnostics = JSON.parse(
    await readFile(join(root, 'docs/rc2-popup-diagnostics.json'), 'utf8'),
  );
  frozenArtifacts = diagnostics.artifacts.filter((row) => row.file.includes('1.0.0-rc.2-'));
  assert.equal(frozenArtifacts.length, 2);
  for (const artifact of frozenArtifacts) {
    const bytes = await readFile(join(root, 'artifacts', artifact.file));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  for (const row of previous.checks)
    assert(stages[stage].some(([name, command]) => row.name === name && row.command === command));
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = join(output, `${stage}-${stamp}`);
await mkdir(directory, { recursive: true });
const report = {
  version: '1.0.0-rc.2',
  stage,
  startedAt: previous?.startedAt ?? new Date().toISOString(),
  ...(previous
    ? {
        resumedAt: new Date().toISOString(),
        resumedFrom: resumePath,
        resumedFromSha256: createHash('sha256')
          .update(await readFile(resumePath))
          .digest('hex'),
        frozenArtifactsVerified: frozenArtifacts,
      }
    : {}),
  paidAiCalls: 0,
  passed: false,
  checks: [],
};
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')),
);
Object.assign(env, { AI_MODE: 'mock', CI: '1', NEXT_TELEMETRY_DISABLED: '1' });
const save = () =>
  writeFile(join(directory, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const [name, command] of stages[stage]) {
    const accepted = previous?.checks.find((row) => row.name === name && row.passed);
    if (accepted) {
      const original = await readFile(join(root, accepted.log));
      assert.equal(createHash('sha256').update(original).digest('hex'), accepted.sha256);
      report.checks.push({ ...accepted, reusedFrom: resumePath });
      console.log(`${name}: previous pass retained against identical frozen ZIPs`);
      await save();
      continue;
    }
    const startedAt = new Date().toISOString();
    report.activeCommand = command;
    await save();
    const log = join(directory, `${name}.log`);
    await access(log).then(
      () => {
        throw new Error('Never overwrite an earlier check log');
      },
      (error) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    await writeFile(log, '');
    console.log(`Running ${command}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: root,
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      log: log.replaceAll('\\', '/').replace(root.replaceAll('\\', '/') + '/', ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
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
