import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const workspace = resolve(import.meta.dirname, '..');
const output = resolve(workspace, '.test-data/phase20');
await mkdir(output, { recursive: true });
const commands = [
  ['portable', ['scripts/test-portable.mjs']],
  ...['0.8.0', '0.7.0', '0.6.0', '0.5.2', '0.5.1', '0.5.0', '0.4.0'].map((version) => [
    `upgrade-${version}`,
    [
      'scripts/test-upgrade.mjs',
      '--from',
      `artifacts/ProductSpy-${version}-windows-x64`,
      '--to',
      'artifacts/ProductSpy-1.0.0-rc.1-windows-x64',
    ],
  ]),
  ['zip', ['scripts/validate-release.mjs']],
];
const report = {
  version: '1.0.0-rc.1',
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
};
try {
  for (const [name, args] of commands) {
    const startedAt = new Date().toISOString();
    console.log(`Running ${name}`);
    let log = '';
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: { ...process.env, CI: '1', AI_MODE: 'mock' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (bytes) => {
      log += bytes.toString();
    });
    child.stderr.on('data', (bytes) => {
      log += bytes.toString();
    });
    const exitCode = await new Promise((done, reject) => {
      child.on('error', reject);
      child.on('close', done);
    });
    await writeFile(join(output, `${name}.log`), log);
    report.checks.push({
      name,
      command: `node ${args.join(' ')}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
      passed: exitCode === 0,
      evidence: `.test-data/phase20/${name}.log`,
    });
    console.log(`${name}: ${exitCode === 0 ? 'passed' : 'FAILED'}`);
    if (exitCode !== 0) {
      console.log(log.slice(-2000));
      throw new Error(`See ${name}.log`);
    }
  }
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'portable-checks.json'), JSON.stringify(report, null, 2) + '\n');
}
