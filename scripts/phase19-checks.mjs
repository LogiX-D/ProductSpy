import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const output = join(workspace, '.test-data/phase19');
await mkdir(output, { recursive: true });
const report = { version: '0.8.0', startedAt: new Date().toISOString(), passed: false, checks: [] };
const commands = [
  ['install', 'pnpm install --frozen-lockfile'],
  ['typecheck', 'pnpm typecheck'],
  ['lint', 'pnpm lint'],
  ['format-write', 'pnpm format'],
  ['format', 'pnpm format:check'],
  [
    'unit',
    'pnpm test --reporter=default --reporter=json --outputFile=.test-data/phase19/unit-report.json',
  ],
  ['build', 'pnpm build'],
  ['unit-repeat-1', 'pnpm test'],
  ['unit-repeat-2', 'pnpm test'],
  ['unit-repeat-3', 'pnpm test'],
  ['e2e', 'pnpm test:e2e'],
];
try {
  for (const [name, command] of commands) {
    const startedAt = new Date().toISOString();
    console.log(`Running ${command}`);
    let log = '';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      cwd: workspace,
      env: { ...process.env, CI: '1', NEXT_TELEMETRY_DISABLED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (bytes) => {
      log += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      log += bytes.toString();
    });
    const exitCode = await new Promise((complete, reject) => {
      child.on('error', reject);
      child.on('close', complete);
    });
    await writeFile(join(output, `${name}.log`), log);
    report.checks.push({
      name,
      command,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      passed: exitCode === 0,
      evidence: `.test-data/phase19/${name}.log`,
    });
    console.log(`${name}: ${exitCode === 0 ? 'passed' : 'FAILED'}`);
    if (exitCode !== 0) {
      console.log(log.slice(-6000));
      throw new Error(`${command} failed; see ${name}.log`);
    }
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'checks.json'), `${JSON.stringify(report, null, 2)}\n`);
}
