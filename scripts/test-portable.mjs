import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Portable lifecycle tests require Windows.');
const packageArgument = process.argv.indexOf('--package');
const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
if (packageArgument >= 0)
  assert(process.argv[packageArgument + 1], 'Use --package <portable directory>.');
const packageRoot = resolve(
  packageArgument >= 0
    ? process.argv[packageArgument + 1]
    : `artifacts/ProductSpy-${version}-windows-x64`,
);
const evidenceRoot = resolve(
  '.test-data/phase10-portable',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const dataRoot = join(evidenceRoot, 'persistent-user');
const runtimeRoot = join(evidenceRoot, 'control');
const movedPackage = join(evidenceRoot, 'ProductSpy 更新目录');
const report = { package: basename(packageRoot), checks: [], startedAt: new Date().toISOString() };
const activeLaunchers = new Set();
const baseUrl = 'http://127.0.0.1:3000';
await mkdir(evidenceRoot, { recursive: true });

async function delay(milliseconds) {
  await new Promise((complete) => setTimeout(complete, milliseconds));
}

async function eventually(check, message, timeout = 20_000, failFast = false) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      if (failFast) throw error;
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

function launcher(directory, action = 'Start') {
  const child = spawn(
    join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(directory, 'launcher/ProductSpy.ps1'),
      '-Headless',
      '-NoBrowser',
      '-Action',
      action,
      '-DataRoot',
      dataRoot,
      '-RuntimeRoot',
      runtimeRoot,
    ],
    {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // An ordinary user must not need Node.js or pnpm installed on PATH.
      env: { ...process.env, PATH: join(process.env.SystemRoot, 'System32') },
    },
  );
  let output = '';
  let errorOutput = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (errorOutput += chunk));
  const completion = once(child, 'exit').then(([code]) => ({ code, output, errorOutput }));
  // Subscribe before startup; a failed launch can exit before the caller awaits it.
  child.on('error', () => undefined);
  const events = () =>
    output
      .split(/\r?\n/)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
  return { child, completion, events };
}

async function start(directory = packageRoot) {
  const process = launcher(directory);
  activeLaunchers.add(process);
  await eventually(
    () => {
      const error = process.events().find((event) => event.event === 'error');
      if (error) throw new Error(error.message);
      if (process.child.exitCode !== null) {
        throw new Error(`Packaged launcher exited early with code ${process.child.exitCode}.`);
      }
      return process.events().some((event) => event.event === 'ready');
    },
    'Packaged workspace did not become ready',
    60_000,
    true,
  );
  return { process, state: process.events().find((event) => event.event === 'ready').state };
}

async function stop(directory = packageRoot) {
  const controller = launcher(directory, 'Stop');
  const result = await controller.completion;
  assert.equal(result.code, 0, result.errorOutput || result.output);
  await eventually(async () => !(await workspaceAvailable()), 'Owned service did not stop');
  for (const process of activeLaunchers) {
    if (process.child.exitCode !== null) activeLaunchers.delete(process);
  }
}

async function workspaceAvailable() {
  try {
    const response = await fetch(`${baseUrl}/api/status`, { signal: AbortSignal.timeout(1000) });
    const result = await response.json();
    return response.ok && result.ok;
  } catch {
    return false;
  }
}

async function apiSession() {
  const headers = {
    origin: baseUrl,
    'content-type': 'application/json',
    'x-productspy-client': 'web',
    'sec-fetch-site': 'same-origin',
  };
  const response = await fetch(`${baseUrl}/api/session`, { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200, 'Portable web session authentication failed.');
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie, 'Portable session must return an HttpOnly cookie.');
  return { ...headers, cookie };
}

async function readProducts() {
  const response = await fetch(`${baseUrl}/api/products`, { headers: await apiSession() });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  return result.data;
}

async function inspectPackage() {
  const inventory = JSON.parse(await readFile(join(packageRoot, 'bundle-manifest.json'), 'utf8'));
  assert.equal(inventory.kind, 'ProductSpy-portable');
  assert.equal(inventory.version, version);
  for (const file of inventory.files) {
    const path = resolve(packageRoot, file.path);
    assert(path.startsWith(`${packageRoot}\\`), 'Package inventory cannot escape its directory.');
    const contents = await readFile(path);
    assert.equal(contents.length, file.bytes, `Package inventory size mismatch: ${file.path}`);
    assert.equal(
      createHash('sha256').update(contents).digest('hex'),
      file.sha256,
      `Package inventory SHA-256 mismatch: ${file.path}`,
    );
  }
  for (const file of [
    'ProductSpy.cmd',
    'launcher/ProductSpy.ps1',
    'launcher/run-server.cjs',
    'runtime/node.exe',
    'runtime/LICENSE',
    'app/apps/web/server.js',
    'extension/manifest.json',
  ]) {
    assert((await stat(join(packageRoot, file))).isFile(), `Missing portable artifact: ${file}`);
  }
  const powershell = await readFile(join(packageRoot, 'launcher/ProductSpy.ps1'));
  assert.equal(
    powershell.subarray(0, 3).toString('hex'),
    'efbbbf',
    'PowerShell 5.1 needs UTF-8 BOM for Chinese.',
  );
  const manifest = JSON.parse(await readFile(join(packageRoot, 'extension/manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert(!manifest.host_permissions.some((host) => host.includes('<all_urls>')));
  assert((await stat(join(packageRoot, 'app/apps/web/.next/static'))).isDirectory());
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `Portable ZIP must not rely on symlinks: ${entry.name}`);
      assert(
        !/^(?:\.env(?:\..*)?|products\.json|\.bridge-credentials\.json|ai-settings\.protected\.json|\.data)$/i.test(
          entry.name,
        ),
        `Sensitive/runtime file in package: ${entry.name}`,
      );
      if (entry.isDirectory()) await inspect(join(directory, entry.name));
    }
  }
  await inspect(packageRoot);
  report.checks.push({
    name: 'package inventory SHA-256, bundled runtime, MV3 permissions, no user data or env',
    passed: true,
  });
}

async function createEncryptedSettings() {
  const settingsFile = join(dataRoot, 'settings/ai-settings.protected.json');
  const command = [
    'Add-Type -AssemblyName System.Security;',
    "$settings = @{AI_MODE='mock';AI_BASE_URL='https://api.openai.com/v1';AI_MODEL='gpt-4o-mini';AI_API_KEY='portable-test-placeholder-no-real-key'};",
    '$plain = [Text.Encoding]::UTF8.GetBytes(($settings | ConvertTo-Json -Compress));',
    '$encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser);',
    '$stored = @{version=1;protected=[Convert]::ToBase64String($encrypted)} | ConvertTo-Json;',
    '[IO.File]::WriteAllText($env:PRODUCTSPY_TEST_SETTINGS, $stored, (New-Object Text.UTF8Encoding($false)));',
    '$decoded = [Security.Cryptography.ProtectedData]::Unprotect($encrypted,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);',
    'if ([Text.Encoding]::UTF8.GetString($decoded) -ne [Text.Encoding]::UTF8.GetString($plain)) { exit 2 };',
  ].join(' ');
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
    windowsHide: true,
    env: { ...process.env, PRODUCTSPY_TEST_SETTINGS: settingsFile },
    stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, 'Windows DPAPI CurrentUser roundtrip must pass.');
  assert(!(await readFile(settingsFile, 'utf8')).includes('portable-test-placeholder'));
  report.checks.push({
    name: 'AI settings use Windows DPAPI CurrentUser, no plaintext test key on disk',
    passed: true,
  });
}

let conflictServer;
try {
  await inspectPackage();
  assert.equal(
    await workspaceAvailable(),
    false,
    'Stop the existing workspace before portable tests; tests never kill an unknown server.',
  );
  conflictServer = createServer();
  await new Promise((complete, reject) => {
    conflictServer.once('error', reject);
    conflictServer.listen(3000, '127.0.0.1', complete);
  });
  const conflicting = launcher(packageRoot);
  const conflictResult = await conflicting.completion;
  assert.equal(conflictResult.code, 4, conflictResult.output || conflictResult.errorOutput);
  assert(
    conflicting.events().some((event) => event.event === 'error' && event.message.includes('3000')),
  );
  assert.equal(conflictServer.listening, true, 'Launcher must not terminate another listener.');
  await new Promise((complete) => conflictServer.close(complete));
  conflictServer = undefined;
  report.checks.push({
    name: 'port conflict is explained, unknown listener preserved',
    passed: true,
  });

  const first = await start();
  const statusResponse = await fetch(`${baseUrl}/api/status`);
  const status = await statusResponse.json();
  assert.equal(status.data.mode, 'mock', 'No package key must default to Mock.');
  assert.equal(first.state.dataRoot, dataRoot);
  const anonymousProducts = await fetch(`${baseUrl}/api/products`, {
    headers: {
      origin: baseUrl,
      'x-productspy-client': 'web',
      'sec-fetch-site': 'same-origin',
    },
  });
  assert.equal(anonymousProducts.status, 401, 'Packaging must preserve API authentication.');
  report.checks.push({
    name: 'headless launcher with no installed Node.js/pnpm on PATH, localhost, Mock, authentication',
    passed: true,
  });

  const duplicate = launcher(packageRoot);
  const duplicateResult = await duplicate.completion;
  assert.equal(duplicateResult.code, 0, duplicateResult.output || duplicateResult.errorOutput);
  const reused = duplicate.events().find((event) => event.event === 'already-running');
  assert(reused, 'Duplicate launch must reuse the running workspace.');
  assert.equal(reused.state.nodePid, first.state.nodePid);
  assert.equal(reused.state.launchId, first.state.launchId);
  report.checks.push({ name: 'duplicate start creates no second service process', passed: true });

  const draft = {
    source: 'amazon',
    sourceId: 'B000TEST10',
    url: 'https://www.amazon.com/dp/B000TEST10',
    title: 'Portable lifecycle regression fixture, not a real Amazon acceptance sample',
    price: '$19.95',
    currency: 'USD',
    images: [],
    videos: [],
    bulletPoints: ['Local persistence test'],
  };
  const savedResponse = await fetch(`${baseUrl}/api/products`, {
    method: 'POST',
    headers: await apiSession(),
    body: JSON.stringify(draft),
  });
  assert.equal(savedResponse.status, 200);
  const saved = (await savedResponse.json()).data;
  const analysisResponse = await fetch(`${baseUrl}/api/analyze-product`, {
    method: 'POST',
    headers: await apiSession(),
    body: JSON.stringify(saved),
  });
  assert.equal(analysisResponse.status, 200, 'Packaged Mock analysis must complete.');
  const analysisResult = await analysisResponse.json();
  assert.equal(analysisResult.ok, true);
  const analysis = analysisResult.data;
  assert.equal(typeof analysis.summary, 'string');
  assert(analysis.summary.length > 0);
  for (const field of [
    'sellingPoints',
    'targetAudience',
    'purchaseMotivations',
    'painPoints',
    'strengths',
    'weaknesses',
    'marketingAngles',
    'hooks',
    'imagePrompts',
    'videoPrompts',
  ]) {
    assert(Array.isArray(analysis[field]) && analysis[field].length > 0, `Missing ${field}`);
    assert(analysis[field].every((item) => typeof item === 'string' && item.length > 0));
  }
  assert(analysis.hooks.length >= 5);
  for (const label of ['Hook', 'Problem', 'Solution', 'Demo', 'CTA']) {
    assert(new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'i').test(analysis.shortVideoScript));
  }
  const analyzed = (await readProducts()).find((product) => product.id === saved.id);
  assert(analyzed, 'Analyzed product must stay in the portable repository.');
  assert.equal(analyzed.createdAt, saved.createdAt);
  assert.deepEqual(analyzed.aiAnalysis, analysis, 'Complete Mock analysis must be persisted.');
  const databaseFile = join(dataRoot, 'data/products.json');
  const databaseBeforeStop = await readFile(databaseFile, 'utf8');
  assert.equal(JSON.parse(databaseBeforeStop)[0].id, saved.id);
  await stop();
  await first.process.completion;
  assert.equal(await readFile(databaseFile, 'utf8'), databaseBeforeStop);
  report.checks.push({
    name: 'complete Mock analysis persists; graceful stop releases port and retains user data',
    passed: true,
  });

  await createEncryptedSettings();

  const restarted = await start();
  const afterRestart = await readProducts();
  assert.equal(afterRestart.length, 1);
  assert.equal(afterRestart[0].id, saved.id);
  assert.equal(afterRestart[0].createdAt, saved.createdAt);
  assert.equal(afterRestart[0].updatedAt, analyzed.updatedAt);
  assert.deepEqual(afterRestart[0].aiAnalysis, analysis);
  await stop();
  await restarted.process.completion;
  report.checks.push({
    name: 'restart retains complete ProductAnalysis, product ID, creation and update times',
    passed: true,
  });

  await cp(packageRoot, movedPackage, { recursive: true, dereference: true });
  const upgraded = await start(movedPackage);
  const afterUpdate = await readProducts();
  assert.equal(afterUpdate.length, 1);
  assert.equal(afterUpdate[0].id, saved.id);
  assert.equal(afterUpdate[0].createdAt, saved.createdAt);
  assert.equal(afterUpdate[0].updatedAt, analyzed.updatedAt);
  assert.deepEqual(afterUpdate[0].aiAnalysis, analysis);
  const oldCopy = launcher(packageRoot);
  assert.equal((await oldCopy.completion).code, 0);
  assert.equal(
    oldCopy.events().find((event) => event.event === 'already-running').state.nodePid,
    upgraded.state.nodePid,
  );
  await stop(movedPackage);
  await upgraded.process.completion;
  assert.equal(await readFile(databaseFile, 'utf8'), databaseBeforeStop);
  report.checks.push({
    name: 'same-schema reinstall/moved package retains complete analysis and single instance',
    passed: true,
  });

  const orphan = await start();
  orphan.process.child.kill();
  await orphan.process.completion;
  activeLaunchers.delete(orphan.process);
  await eventually(
    async () => !(await workspaceAvailable()),
    'Supervisor failed to stop after launcher disappeared',
  );
  const recovered = await start();
  const afterRecovery = await readProducts();
  assert.equal(afterRecovery[0].id, saved.id);
  assert.deepEqual(afterRecovery[0].aiAnalysis, analysis);
  await stop();
  await recovered.process.completion;
  report.checks.push({
    name: 'launcher crash cleanup and abandoned mutex recovery preserve data',
    passed: true,
  });
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  throw error;
} finally {
  if (conflictServer?.listening) await new Promise((complete) => conflictServer.close(complete));
  if (activeLaunchers.size) {
    try {
      await stop();
    } catch {
      for (const process of activeLaunchers) process.child.kill();
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: evidenceRoot }, null, 2));
}
