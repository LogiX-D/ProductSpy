import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// A separate evidence directory keeps the frozen Phase20 reports and ZIPs intact.
const workspace = resolve(import.meta.dirname, '..');
const output = join(workspace, '.test-data/phase21');
await mkdir(output, { recursive: true });
const report = {
  phase: 21,
  version: '1.0.0-rc.1',
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
};
const commands = [
  ['install', 'pnpm install --frozen-lockfile'],
  ['typecheck', 'pnpm typecheck'],
  ['lint', 'pnpm lint'],
  ['format', 'pnpm format:check'],
  [
    'unit',
    'pnpm test --reporter=default --reporter=json --outputFile=.test-data/phase21/unit-report.json',
  ],
  ['build', 'pnpm build'],
  ['e2e-and-screenshots', 'node scripts/phase21-portable-workflow.mjs'],
  [
    'portable',
    'node scripts/test-portable.mjs --package artifacts/ProductSpy-1.0.0-rc.1-windows-x64',
  ],
  ...['0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0'].map((version) => [
    `upgrade-${version}`,
    `node scripts/test-upgrade.mjs --from artifacts/ProductSpy-${version}-windows-x64 --to artifacts/ProductSpy-1.0.0-rc.1-windows-x64`,
  ]),
  ['zip-validation', 'node scripts/validate-release.mjs'],
];
const save = () => writeFile(join(output, 'checks.json'), JSON.stringify(report, null, 2) + '\n');
try {
  for (const [name, command] of commands) {
    const startedAt = new Date().toISOString();
    report.activeCommand = command;
    await save();
    const path = join(output, `${name}.log`);
    await writeFile(path, '');
    console.log(`Running ${command}`);
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout.on('data', (bytes) => appendFileSync(path, bytes));
    child.stderr.on('data', (bytes) => appendFileSync(path, bytes));
    const exitCode = await new Promise((complete, reject) => {
      child.on('error', reject);
      child.on('close', complete);
    });
    const bytes = await readFile(path);
    report.checks.push({
      name,
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      passed: exitCode === 0,
      evidence: `.test-data/phase21/${name}.log`,
      logSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    delete report.activeCommand;
    await save();
    console.log(`${name}: ${exitCode === 0 ? 'passed' : 'FAILED'}`);
    if (exitCode !== 0) console.log(bytes.toString('utf8').slice(-6000));
    assert.equal(exitCode, 0, `${command} failed; original evidence is retained.`);
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await save();
}
