import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

assert.equal(process.platform, 'win32', 'Run the actual Windows portable package.');
const workspace = resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')).version;
const output = resolve(process.env.PRODUCTSPY_RELEASE_EVIDENCE_DIR ?? '.test-data/rc2-hotfix');
assert(
  relative(resolve('.test-data'), output) &&
    !relative(resolve('.test-data'), output).startsWith('..'),
  'Evidence must remain within .test-data.',
);
const root = join(output, 'workflow', new Date().toISOString().replace(/[:.]/g, '-'));
const dataRoot = join(root, 'user');
const runtimeRoot = join(root, 'runtime');
const packageRoot = resolve(`artifacts/ProductSpy-${version}-windows-x64`);
const launcherPath = join(packageRoot, 'launcher/ProductSpy.ps1');
const report = {
  purpose: 'Full release portable regression, including rc2 popup protection',
  startedAt: new Date().toISOString(),
  passed: false,
  version,
  runtime: 'frozen portable package; isolated data; headless launcher; not native GUI acceptance',
  ai: 'mock',
  paidRequests: 0,
  sessions: [],
  extensionFiles: [],
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
await mkdir(root, { recursive: true });
// Do not inherit a user's configured AI endpoint, model or Key into this test.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AI_')),
);
Object.assign(env, { AI_MODE: 'mock', CI: '1', NEXT_TELEMETRY_DISABLED: '1' });
async function portFree() {
  const probe = createServer();
  await new Promise((complete, reject) => {
    probe.once('error', reject);
    probe.listen(3000, '127.0.0.1', complete);
  });
  await new Promise((complete, reject) =>
    probe.close((error) => (error ? reject(error) : complete())),
  );
}
async function verifyExtension(directory = '') {
  const frozen = join(packageRoot, 'extension', directory);
  for (const entry of await readdir(frozen, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await verifyExtension(file);
      continue;
    }
    const a = await readFile(join(frozen, entry.name));
    const b = await readFile(resolve('apps/extension/dist', file));
    assert.deepEqual(
      b,
      a,
      `Built extension differs from packaged ${version}: ${file}; do not mix versions.`,
    );
    report.extensionFiles.push({ file: file.replaceAll('\\', '/'), sha256: sha(a) });
  }
}
function launch(action, userRoot) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launcherPath,
      '-Headless',
      '-NoBrowser',
      '-Action',
      action,
      '-DataRoot',
      userRoot,
      '-RuntimeRoot',
      runtimeRoot,
    ],
    {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => {
    stdout += bytes.toString();
  });
  child.stderr.on('data', (bytes) => {
    stderr += bytes.toString();
  });
  const done = new Promise((complete, reject) => {
    child.on('error', reject);
    child.on('close', (code) => complete({ code, stdout, stderr }));
  });
  return { child, done };
}
async function runE2E(extraEnv = {}) {
  const escapedOutput = join(output, 'e2e').replaceAll("'", "''");
  const command = `pnpm test:e2e --output='${escapedOutput}' '--reporter=list,json'`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    cwd: workspace,
    env: { ...env, ...extraEnv },
    windowsHide: true,
    stdio: 'inherit',
  });
  const code = await new Promise((complete, reject) => {
    child.on('error', reject);
    child.on('close', complete);
  });
  assert.equal(code, 0, `Command failed: ${command}`);
}
async function session(userRoot, action) {
  await portFree();
  const owned = launch('Start', userRoot);
  let state;
  let primaryFailure;
  try {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      try {
        state = JSON.parse(await readFile(join(runtimeRoot, 'launcher-state.json'), 'utf8'));
        const response = await fetch('http://127.0.0.1:3000/api/status', {
          signal: AbortSignal.timeout(2000),
        });
        const status = await response.json();
        if (
          state.launcherPid === owned.child.pid &&
          status.data?.version === report.version &&
          status.data.mode === 'mock'
        )
          break;
        state = undefined;
      } catch {
        state = undefined;
      }
      await new Promise((complete) => setTimeout(complete, 250));
    }
    assert(state, 'Owned Mock portable service did not become ready.');
    assert(Number.isSafeInteger(state.nodePid) && state.nodePid > 0);
    assert.equal(resolve(state.dataRoot), userRoot);
    assert.equal(resolve(state.packageRoot), packageRoot);
    report.sessions.push({
      dataRoot: relative(workspace, userRoot).replaceAll('\\', '/'),
      launcherPid: owned.child.pid,
      serverPid: state.nodePid,
      version: report.version,
      verifiedOwned: true,
    });
    await action();
  } catch (error) {
    primaryFailure = error;
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    // Stop only the launch whose state matches our process; never stop another listener.
    let current;
    try {
      current = JSON.parse(await readFile(join(runtimeRoot, 'launcher-state.json'), 'utf8'));
    } catch {
      /* Startup may not have produced a state. */
    }
    if (current?.launcherPid === owned.child.pid) {
      const stop = await launch('Stop', userRoot).done;
      assert.equal(stop.code, 0, stop.stderr);
    } else if (owned.child.exitCode === null) {
      owned.child.kill();
    }
    const result = await owned.done;
    await writeFile(join(root, 'e2e-launcher.log'), result.stdout + result.stderr);
    report.cleanup = { launcherExitCode: result.code, originalFailurePreserved: !!primaryFailure };
    if (!primaryFailure) assert.equal(result.code, 0, result.stderr);
    await portFree();
  }
}
try {
  await verifyExtension();
  await session(dataRoot, () =>
    runE2E({
      PRODUCTSPY_E2E_EXTERNAL_SERVER: '1',
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, 'e2e-report.json'),
    }),
  );
  report.passed = true;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, 'workflow.json'), JSON.stringify(report, null, 2) + '\n');
}
