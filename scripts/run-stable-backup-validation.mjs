import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: { stage: { type: 'string', default: 'regression' }, output: { type: 'string' } },
});
assert.equal(process.platform, 'win32');
assert(['regression', 'workflow'].includes(values.stage));
assert(
  values.output,
  'Use --stage regression|workflow --output .test-data/v100-backup-restore/<new-run>',
);
const workspace = resolve(import.meta.dirname, '..');
const parent = resolve(workspace, '.test-data/v100-backup-restore');
const output = resolve(values.output);
assert(output.startsWith(parent + sep), 'Use a dedicated new test directory.');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const attempt = join(output, `${values.stage}-${stamp}`);
await mkdir(attempt, { recursive: true });
const packageRoot = resolve(workspace, 'artifacts/ProductSpy-1.0.0-windows-x64');
const launcher = join(packageRoot, 'launcher/ProductSpy.ps1');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const files = [
  'products.json',
  'comparisons.json',
  'templates.json',
  'content-plans.json',
  'analysis-usage.json',
];
const report = {
  version: '1.0.0',
  purpose: 'Frozen portable full backup and restore validation',
  stage: values.stage,
  startedAt: new Date().toISOString(),
  passed: false,
  fixtureOnly: true,
  realAiRequests: 0,
  nativeManualAcceptance: 'PENDING',
  checks: [],
  commands: [],
  sessions: [],
};
const rel = (path) => relative(workspace, path).replaceAll('\\', '/');
report.scripts = await Promise.all(
  ['scripts/run-stable-backup-validation.mjs', 'scripts/validate-stable-backup.mjs'].map(
    async (file) => ({ file, sha256: sha(await readFile(join(workspace, file))) }),
  ),
);
const check = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')),
);
Object.assign(env, { AI_MODE: 'mock', CI: '1', NEXT_TELEMETRY_DISABLED: '1' });
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function verifyFrozen() {
  const manifest = await json(join(workspace, 'artifacts/ProductSpy-1.0.0-upload-manifest.json'));
  for (const item of manifest.assets) {
    const bytes = await readFile(join(workspace, 'artifacts', item.name));
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha(bytes), item.sha256);
  }
  report.artifacts = manifest.assets;
  check('all seven frozen release asset hashes unchanged', { assets: manifest.assets.length });
  const bundle = await json(join(packageRoot, 'bundle-manifest.json'));
  assert.equal(bundle.version, '1.0.0');
  for (const item of bundle.files) {
    const target = resolve(packageRoot, item.path);
    assert(target.startsWith(packageRoot + sep));
    const bytes = await readFile(target);
    assert.equal(bytes.length, item.bytes);
    assert.equal(sha(bytes), item.sha256, `Frozen bundle changed: ${item.path}`);
  }
  check('actual installed portable tree matches frozen bundle manifest', {
    files: bundle.files.length,
    runtime: bundle.runtime.version,
  });
}
async function portFree() {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once('error', reject);
    probe.listen(3000, '127.0.0.1', done);
  });
  await new Promise((done, reject) => probe.close((error) => (error ? reject(error) : done())));
}
async function command(name, text, extraEnv = {}) {
  const log = join(attempt, `${name}.log`);
  await writeFile(log, '', { flag: 'wx' });
  const startedAt = new Date().toISOString();
  console.log(`Running ${name}`);
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', text], {
    cwd: workspace,
    env: { ...env, ...extraEnv },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (bytes) => appendFileSync(log, bytes));
  child.stderr.on('data', (bytes) => appendFileSync(log, bytes));
  const exitCode = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  report.commands.push({
    name,
    command: text,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    log: rel(log),
    sha256: sha(await readFile(log)),
    passed: exitCode === 0,
  });
  if (exitCode !== 0) console.log((await readFile(log, 'utf8')).slice(-6000));
  assert.equal(exitCode, 0, `${name} failed; evidence retained`);
}
function launch(action, dataRoot, runtimeRoot) {
  assert(dataRoot.startsWith(attempt + sep) && runtimeRoot.startsWith(attempt + sep));
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launcher,
      '-Headless',
      '-NoBrowser',
      '-Action',
      action,
      '-DataRoot',
      dataRoot,
      '-RuntimeRoot',
      runtimeRoot,
    ],
    { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (b) => {
    stdout += b.toString();
  });
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const done = new Promise((complete, reject) => {
    child.once('error', reject);
    child.once('close', (code) => complete({ code, stdout, stderr }));
  });
  return { child, done };
}
async function session(label, dataRoot, action) {
  const runtimeRoot = join(attempt, `${label}-runtime`);
  await portFree();
  const owned = launch('Start', dataRoot, runtimeRoot);
  let failure;
  let cleanupError;
  try {
    let state;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        const candidate = await json(join(runtimeRoot, 'launcher-state.json'));
        const response = await fetch('http://127.0.0.1:3000/api/status', {
          signal: AbortSignal.timeout(2000),
        });
        const status = await response.json();
        if (
          candidate.launcherPid === owned.child.pid &&
          status.data?.version === '1.0.0' &&
          status.data?.mode === 'mock'
        ) {
          state = candidate;
          break;
        }
      } catch {
        /* The owned launcher is still starting. */
      }
      await pause(250);
    }
    assert(state, 'Owned frozen Mock service did not become ready.');
    assert.equal(resolve(state.dataRoot), dataRoot);
    assert.equal(resolve(state.packageRoot), packageRoot);
    report.sessions.push({
      label,
      dataRoot: rel(dataRoot),
      runtimeRoot: rel(runtimeRoot),
      launcherPid: owned.child.pid,
      servicePid: state.nodePid,
      version: '1.0.0',
      mode: 'mock',
      isolated: true,
    });
    await action();
  } catch (error) {
    failure = error;
  } finally {
    try {
      let state;
      try {
        state = await json(join(runtimeRoot, 'launcher-state.json'));
      } catch {
        /* Startup may fail before writing state. */
      }
      if (state?.launcherPid === owned.child.pid) {
        const stop = await launch('Stop', dataRoot, runtimeRoot).done;
        assert.equal(stop.code, 0, stop.stderr);
      } else if (owned.child.exitCode === null) owned.child.kill();
      const stopped = await owned.done;
      const log = join(attempt, `${label}-launcher.log`);
      await writeFile(log, stopped.stdout + stopped.stderr);
      if (!failure) assert.equal(stopped.code, 0, stopped.stderr);
      await portFree();
      check(`${label}: owned service stopped and port released`);
    } catch (error) {
      cleanupError = error;
      report.cleanupError = error.message;
    }
  }
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
}
const q = (text) => `'${text.replaceAll("'", "''")}'`;
async function phase(name, dataRoot) {
  await command(
    name,
    `node scripts/validate-stable-backup.mjs --phase ${name} --data-root ${q(dataRoot)} --output ${q(attempt)}`,
  );
}
async function hashes(directory) {
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [file, sha(await readFile(join(directory, file)))]),
    ),
  );
}
try {
  await verifyFrozen();
  if (values.stage === 'regression') {
    const unitFile = join(attempt, 'unit.json');
    await command(
      'unit',
      `pnpm test packages/shared/src/business-backup.test.ts apps/web/src/lib/server/business-backup.test.ts apps/web/src/lib/server/history-backup-review.test.ts apps/web/src/lib/workspace-backup-api.test.ts --reporter=default --reporter=json --outputFile=${q(unitFile)}`,
    );
    await session('e2e', join(attempt, 'e2e-user'), () =>
      command(
        'e2e',
        `pnpm test:e2e e2e/workspace-backup.spec.ts e2e/phase20.spec.ts --output=${q(join(attempt, 'e2e-results'))} '--reporter=list,json'`,
        {
          PRODUCTSPY_E2E_EXTERNAL_SERVER: '1',
          PLAYWRIGHT_JSON_OUTPUT_FILE: join(attempt, 'e2e.json'),
        },
      ),
    );
    await command('release', 'node scripts/validate-release.mjs');
  } else {
    const source = join(attempt, 'source-user');
    const target = join(attempt, 'target-user');
    const settingsFile = join(source, 'settings/ai-settings.protected.json');
    await mkdir(join(source, 'settings'), { recursive: true });
    await command(
      'synthetic-private-settings',
      [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Security',
        "$settings = @{ AI_MODE = 'mock'; AI_API_KEY = 'productspy-backup-placeholder-not-a-real-api-key'; AI_BASE_URL = 'https://example.invalid/v1'; AI_MODEL = 'backup-fixture-mock' }",
        '$plain = [Text.Encoding]::UTF8.GetBytes(($settings | ConvertTo-Json -Compress))',
        '$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
        '$stored = @{ version = 2; protected = [Convert]::ToBase64String($protected) } | ConvertTo-Json -Compress',
        `[IO.File]::WriteAllText(${q(settingsFile)}, $stored, (New-Object Text.UTF8Encoding($false)))`,
      ].join('; '),
    );
    check('synthetic encrypted Key exists only in isolated source settings; AI mode remains Mock');
    await session('source', source, () => phase('seed', source));
    const backupBytes = await readFile(join(attempt, 'backup.json'));
    report.backupFile = {
      file: rel(join(attempt, 'backup.json')),
      bytes: backupBytes.length,
      sha256: sha(backupBytes),
    };
    try {
      await access(target);
      assert.fail('Target must be a new empty directory.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await session('target', target, async () => {
      await phase('restore', target);
      await phase('failure', target);
    });
    const directory = join(target, 'data');
    const beforeCrash = await hashes(directory);
    const stage = join(directory, '.workspace-restore');
    await mkdir(stage);
    const entries = [];
    for (const file of files) {
      const old = await readFile(join(directory, file));
      let next = old;
      if (file === 'products.json') {
        const value = JSON.parse(old.toString());
        value.products[0].title = 'SYNTHETIC PREPARED CRASH PARTIAL - MUST ROLL BACK';
        next = Buffer.from(JSON.stringify(value));
      }
      await writeFile(join(stage, `old-${file}`), old);
      await writeFile(join(stage, `new-${file}`), next);
      entries.push({ name: file, oldHash: sha(old), newHash: sha(next) });
      if (file === 'products.json') await writeFile(join(directory, file), next);
    }
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'prepared', entries }),
    );
    check('synthetic offline prepared-crash state created only in stopped test target', {
      actualProcessKill: false,
      changedFiles: ['products.json'],
    });
    await session('restart', target, () => phase('verify', target));
    assert.deepEqual(await hashes(directory), beforeCrash);
    try {
      await access(stage);
      assert.fail('Recovered stage must be removed.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    check(
      'frozen restart and ordinary read recover prepared-crash state without exposing partial data',
      { allFiveBusinessFilesByteIdentical: true },
    );
    assert.equal(sha(await readFile(join(attempt, 'backup.json'))), report.backupFile.sha256);
    check('source backup file remains immutable through restore, failure, retry and restart');
  }
  for (const script of report.scripts)
    assert.equal(
      sha(await readFile(join(workspace, script.file))),
      script.sha256,
      'Do not change a test script while validation is running.',
    );
  check('validation scripts remained byte-identical throughout this attempt');
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(attempt, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(
    join(output, `${values.stage}-latest.json`),
    JSON.stringify({ attempt: rel(attempt), ...report }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      stage: values.stage,
      passed: report.passed,
      attempt: rel(attempt),
      checks: report.checks.length,
    }),
  );
}
