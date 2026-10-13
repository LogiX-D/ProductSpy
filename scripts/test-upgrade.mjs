import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { openUpgradePreferenceProbe } from './phase16-browser-preferences.mjs';
import { openContentUpgradePreferenceProbe } from './phase19-browser-preferences.mjs';

const { values } = parseArgs({
  options: { from: { type: 'string' }, to: { type: 'string' }, help: { type: 'boolean' } },
});
const fixture = {
  source: 'amazon',
  sourceId: 'B0UPGRADE1',
  url: 'https://www.amazon.com/dp/B0UPGRADE1',
  title: 'Phase 12 → 13 upgrade fixture / 升级兼容回归，非真实 Amazon 商品',
  price: '$19.95',
  currency: 'USD',
  brand: 'UpgradeFixture',
  rating: 4.4,
  reviewCount: 1234,
  mainImage: 'https://example.com/upgrade/main.jpg',
  images: ['https://example.com/upgrade/main.jpg', 'https://example.com/upgrade/detail.jpg'],
  videos: [
    {
      url: 'https://example.com/upgrade/demo.mp4',
      thumbnail: 'https://example.com/upgrade/video.jpg',
    },
  ],
  bulletPoints: [
    '完整商品字段兼容',
    '本机演示分析持久化',
    'No real credentials or remote media requests',
  ],
  description: 'Synthetic upgrade regression fixture.\n中文描述与换行必须保持。',
};
const draftFields = Object.keys(fixture);
const baseUrl = 'http://127.0.0.1:3000';
let sessionCookie;
const run = promisify(execFile);
const settingsFixture = {
  AI_MODE: 'mock',
  AI_BASE_URL: 'https://example.invalid/v1',
  AI_MODEL: 'phase16-upgrade-fixture',
  AI_RESPONSE_FORMAT: 'text',
  AI_TOKEN_PARAMETER: 'max_completion_tokens',
  AI_TIMEOUT_MS: '45000',
  AI_MAX_OUTPUT_TOKENS: '3072',
  AI_TEMPERATURE: '0.3',
};
const placeholderKey = 'phase16-upgrade-placeholder-no-real-key';

if (values.help) {
  console.log(
    'node scripts/test-upgrade.mjs --from artifacts/ProductSpy-0.7.0-windows-x64 --to artifacts/ProductSpy-0.8.0-windows-x64\n' +
      'Requires Windows and a free port 3000. Accepts frozen 0.4.0, 0.5.0, 0.5.1, 0.5.2, 0.6.0 or 0.7.0 source packages. Uses only fresh .test-data upgrade fixtures and isolated browser preferences. Existing services are never stopped.',
  );
} else {
  await main();
}

async function main() {
  assert.equal(process.platform, 'win32', 'Portable upgrade regression requires Windows.');
  const { version } = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const oldPackage = resolve(values.from ?? 'artifacts/ProductSpy-0.7.0-windows-x64');
  const newPackage = resolve(values.to ?? `artifacts/ProductSpy-${version}-windows-x64`);
  assert.notEqual(
    oldPackage.toLowerCase(),
    newPackage.toLowerCase(),
    'Upgrade requires two distinct package directories.',
  );
  const evidenceParent = resolve('.test-data/phase19-upgrade');
  await mkdir(evidenceParent, { recursive: true });
  const evidenceRoot = await mkdtemp(
    join(evidenceParent, `${new Date().toISOString().replace(/[:.]/g, '-')}-`),
  );
  const dataRoot = join(evidenceRoot, 'isolated-user');
  const runtimeRoot = join(evidenceRoot, 'control');
  const databaseFile = join(dataRoot, 'data/products.json');
  const settingsFile = join(dataRoot, 'settings/ai-settings.protected.json');
  const credentialFile = join(dataRoot, 'data/.bridge-credentials.json');
  const usageFile = join(dataRoot, 'data/analysis-usage.json');
  const stateFile = join(runtimeRoot, 'launcher-state.json');
  const activeLaunchers = new Set();
  const report = {
    from: basename(oldPackage),
    to: basename(newPackage),
    baseUrl,
    dataRoot,
    runtimeRoot,
    fixtureOnly: true,
    startedAt: new Date().toISOString(),
    checks: [],
  };
  let failure;
  let preferenceProbe;
  let contentPreferenceProbe;

  async function readFixtureSettings(directory) {
    const command = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($env:PRODUCTSPY_TEST_LAUNCHER, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Test launcher parse failed' }
$reader = $ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-AiSettings'}, $true)
if (-not $reader) { throw 'Test launcher settings reader missing' }
Invoke-Expression $reader.Extent.Text
$settingsFile = $env:PRODUCTSPY_TEST_SETTINGS
$settings = Read-AiSettings
$matches = $settings.AI_API_KEY -eq $env:PRODUCTSPY_TEST_PLACEHOLDER
$settings.Remove('AI_API_KEY')
@{settings=$settings; placeholderMatches=$matches} | ConvertTo-Json -Depth 4 -Compress
`;
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        windowsHide: true,
        timeout: 15000,
        env: {
          ...process.env,
          PRODUCTSPY_TEST_LAUNCHER: join(directory, 'launcher/ProductSpy.ps1'),
          PRODUCTSPY_TEST_SETTINGS: settingsFile,
          PRODUCTSPY_TEST_PLACEHOLDER: placeholderKey,
        },
      },
    );
    const decoded = JSON.parse(stdout);
    assert.equal(
      decoded.placeholderMatches,
      true,
      'Synthetic placeholder Key must decrypt without logging its contents.',
    );
    assert.deepEqual(
      decoded.settings,
      settingsFixture,
      'Every explicit AI preference must survive.',
    );
    return decoded.settings;
  }

  async function createFixtureSettings() {
    await mkdir(join(dataRoot, 'settings'), { recursive: true });
    const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$settings = $env:PRODUCTSPY_TEST_FIELDS | ConvertFrom-Json
$settings | Add-Member -NotePropertyName AI_API_KEY -NotePropertyValue $env:PRODUCTSPY_TEST_PLACEHOLDER
$plain = [Text.Encoding]::UTF8.GetBytes(($settings | ConvertTo-Json -Compress))
$protected = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$stored = @{version=2;protected=[Convert]::ToBase64String($protected)} | ConvertTo-Json -Compress
[IO.File]::WriteAllText($env:PRODUCTSPY_TEST_SETTINGS, $stored, (New-Object Text.UTF8Encoding($false)))
`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        PRODUCTSPY_TEST_FIELDS: JSON.stringify(settingsFixture),
        PRODUCTSPY_TEST_SETTINGS: settingsFile,
        PRODUCTSPY_TEST_PLACEHOLDER: placeholderKey,
      },
    });
    const bytes = await readFile(settingsFile);
    assert(
      !bytes.includes(Buffer.from(placeholderKey)),
      'Settings file must not contain plaintext Key.',
    );
    return bytes;
  }

  async function snapshot(name, product) {
    await writeFile(join(evidenceRoot, `${name}.json`), JSON.stringify(product, null, 2));
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
        env: { ...process.env, PATH: join(process.env.SystemRoot, 'System32') },
      },
    );
    const record = {
      child,
      directory,
      events: [],
      output: '',
      errorOutput: '',
      done: false,
      state: undefined,
    };
    let incomplete = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      record.output += chunk;
      incomplete += chunk;
      const lines = incomplete.split(/\r?\n/);
      incomplete = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('{')) continue;
        try {
          record.events.push(JSON.parse(line));
        } catch {
          /* Non-JSON diagnostics do not establish ownership. */
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      record.errorOutput += chunk;
    });
    record.completion = new Promise((complete) => {
      child.once('error', (error) => {
        record.done = true;
        complete({ code: null, error: error.message });
      });
      child.once('exit', (code) => {
        record.done = true;
        complete({ code });
      });
    });
    return record;
  }

  function isOwnState(record, state) {
    return (
      state &&
      state.launcherPid === record.child.pid &&
      resolve(state.dataRoot).toLowerCase() === dataRoot.toLowerCase() &&
      resolve(state.packageRoot).toLowerCase() === record.directory.toLowerCase() &&
      typeof state.launchId === 'string' &&
      /^[a-f0-9]{32}$/i.test(state.launchId) &&
      Number.isInteger(state.nodePid) &&
      state.nodePid > 0
    );
  }

  async function readOwnState(record) {
    try {
      const state = JSON.parse((await readFile(stateFile, 'utf8')).replace(/^\uFEFF/, ''));
      if (isOwnState(record, state)) return state;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return undefined;
  }

  async function start(directory, expectedVersion) {
    await assertPortFree();
    sessionCookie = undefined;
    const record = launcher(directory);
    activeLaunchers.add(record);
    await eventually(
      () => {
        const error = record.events.find((event) => event.event === 'error');
        if (error) throw new Error(error.message);
        assert(
          !record.events.some((event) => event.event === 'already-running'),
          'Refusing to reuse an existing service; no unknown service will be stopped.',
        );
        assert(
          !record.done,
          `Launcher exited before readiness: ${record.errorOutput || record.output}`,
        );
        const ready = record.events.find((event) => event.event === 'ready');
        if (!ready) return false;
        assert(
          isOwnState(record, ready.state),
          'Ready event must identify this test launcher, package and isolated data directory.',
        );
        record.state = ready.state;
        return true;
      },
      'Portable package did not become ready',
      60_000,
      true,
    );
    const current = await readOwnState(record);
    assert.equal(
      current?.launchId,
      record.state.launchId,
      'Launcher ownership must be confirmed in the isolated runtime directory.',
    );
    const status = await request('/api/status');
    assert.equal(status.mode, 'mock', 'Fresh test data must default to local Mock analysis.');
    assert.equal(
      status.version,
      expectedVersion,
      'The running service must match its packaged version.',
    );
    report.checks.push({
      name: `owned launcher ${expectedVersion}: isolated user data, bundled runtime, Mock`,
      passed: true,
    });
    return record;
  }

  async function stop(record) {
    if (!record.done) {
      const current = await readOwnState(record);
      if (current) {
        if (record.state)
          assert.equal(
            current.launchId,
            record.state.launchId,
            'Runtime ownership changed; refusing a stop request.',
          );
        const controller = launcher(record.directory, 'Stop');
        let result;
        try {
          result = await bounded(controller.completion, 8000, 'Stop controller timed out');
        } finally {
          if (!controller.done) {
            controller.child.kill();
            await bounded(
              controller.completion,
              5000,
              'Test stop controller cleanup timed out',
            ).catch(() => undefined);
          }
        }
        assert.equal(result.code, 0, controller.errorOutput || controller.output || result.error);
        assert(
          controller.events.some(
            (event) => event.event === 'stop-requested' && event.requested === true,
          ),
          'Owned stop controller must acknowledge the request.',
        );
      } else {
        // Only the child object spawned here is killed. Its supervisor notices
        // the missing parent and cleans up its own server; no PID-wide kill.
        record.child.kill();
      }
      const result = await bounded(record.completion, 20_000, 'Owned launcher did not exit');
      if (current)
        assert.equal(result.code, 0, record.errorOutput || record.output || result.error);
    }
    activeLaunchers.delete(record);
    await eventually(async () => {
      try {
        await assertPortFree();
        return true;
      } catch {
        return false;
      }
    }, 'Port 3000 did not become free after the owned service stopped');
  }

  try {
    const oldInventory = await inspectPackage(oldPackage);
    const newInventory = await inspectPackage(newPackage);
    assert(
      ['0.4.0', '0.5.0', '0.5.1', '0.5.2', '0.6.0', '0.7.0'].includes(oldInventory.version),
      'Upgrade fixture must run an actual frozen 0.4.0–0.7.0 portable package.',
    );
    assert.equal(
      newInventory.version,
      version,
      'Target package must match the current repository release.',
    );
    assert.notEqual(
      newInventory.version,
      oldInventory.version,
      'A same-version moved package is not an upgrade regression.',
    );
    report.fromVersion = oldInventory.version;
    report.toVersion = newInventory.version;
    report.checks.push({
      name: 'distinct frozen source and closed-test target package versions and launcher/runtime hashes',
      passed: true,
    });

    const originalSettings = await createFixtureSettings();
    await readFixtureSettings(oldPackage);
    report.checks.push({
      name: 'old frozen package decrypts all explicit DPAPI fixture preferences; no real Key or model request',
      passed: true,
    });
    const oldLaunch = await start(oldPackage, oldInventory.version);
    assert.deepEqual(
      await products(),
      [],
      'The upgrade test must start with an empty, fresh repository.',
    );
    const saved = await request('/api/products', 'POST', fixture);
    assert.deepEqual(asDraft(saved), fixture, 'Old package must save every fixture field.');
    const oldGenerated = await request('/api/analyze-product', 'POST', saved);
    const oldGeneratedProduct = await onlyProduct(saved.id);
    const oldAnalysis = {
      ...oldGenerated,
      summary: `v${oldInventory.version} 原有人工摘要：升级不得覆盖。`,
    };
    await request(`/api/products/${encodeURIComponent(saved.id)}`, 'PATCH', {
      analysis: oldAnalysis,
      expectedUpdatedAt: oldGeneratedProduct.updatedAt,
    });
    assertCompleteAnalysis(oldAnalysis);
    const baselineLibrary = { groups: [], tags: [] };
    if (['0.5.0', '0.5.1', '0.5.2', '0.6.0', '0.7.0'].includes(oldInventory.version)) {
      const grouped = await request('/api/library', 'POST', {
        kind: 'group',
        action: 'create',
        name: '升级前分组',
        color: '#334155',
      });
      const tagged = await request('/api/library', 'POST', {
        kind: 'tag',
        action: 'create',
        name: '升级前标签',
        color: '#7c3aed',
      });
      baselineLibrary.groups = grouped.groups;
      baselineLibrary.tags = tagged.tags;
      const baselineGroupBatch = await request('/api/library/batch', 'POST', {
        ids: [saved.id],
        operation: 'add-groups',
        groupIds: baselineLibrary.groups.map((item) => item.id),
      });
      const baselineTagBatch = await request('/api/library/batch', 'POST', {
        ids: [saved.id],
        operation: 'add-tags',
        tagIds: baselineLibrary.tags.map((item) => item.id),
      });
      assert.deepEqual(baselineGroupBatch.succeededIds, [saved.id]);
      assert.deepEqual(baselineTagBatch.succeededIds, [saved.id]);
    }
    let oldComparison;
    let oldComparisonBytes;
    if (['0.6.0', '0.7.0'].includes(oldInventory.version)) {
      const peer = await request('/api/products', 'POST', {
        ...fixture,
        sourceId: 'B0OLDPEER1',
        url: 'https://www.amazon.com/dp/B0OLDPEER1',
        title: `v${oldInventory.version} 合成快照商品，非真实 Amazon 验收`,
        specifications: [{ name: 'Material', value: 'Merchant claim', source: 'page' }],
        mediaMetadata: [
          {
            url: fixture.mainImage,
            kind: 'image',
            productSourceId: 'B0OLDPEER1',
            sourceUrl: 'https://www.amazon.com/dp/B0OLDPEER1',
            extractedAt: new Date().toISOString(),
            width: 1200,
            height: 1200,
          },
        ],
      });
      oldComparison = await request('/api/comparisons', 'POST', {
        name: '升级前保存的对比',
        productIds: [saved.id, peer.id],
      });
      oldComparison = (
        await request('/api/analyze-comparison', 'POST', {
          comparisonId: oldComparison.id,
          expectedUpdatedAt: oldComparison.updatedAt,
          requestId: randomUUID(),
        })
      ).plan;
      oldComparison = await request(`/api/comparisons/${oldComparison.id}`, 'PATCH', {
        expectedUpdatedAt: oldComparison.updatedAt,
        analysis: { ...oldComparison.analysis, coreDifferences: ['旧版人工结论不得丢失'] },
      });
      await request(`/api/products/${peer.id}`, 'DELETE');
      oldComparisonBytes = await readFile(join(dataRoot, 'data/comparisons.json'));
    }
    let oldCreative;
    let oldBusinessBytes;
    if (oldInventory.version === '0.7.0') {
      oldCreative = await seedContentFixture(saved.id, oldComparison?.id, '旧 v0.7.0 保存');
      await snapshot('01-old-template-content', oldCreative);
      report.checks.push({
        name: 'actual frozen v0.7.0 saves custom template created/edited/restored history and Japanese 45-second Mock/manual/candidate/replayed/restored content with comparison snapshot before upgrade',
        passed: true,
      });
    }
    const oldProduct = await onlyProduct(saved.id);
    assert.equal(oldProduct.createdAt, saved.createdAt);
    assert.deepEqual(oldProduct.aiAnalysis, oldAnalysis);
    assert(oldProduct.analysisHistory.length >= 2, 'Baseline must contain old analysis history.');
    await snapshot('01-old-product', oldProduct);
    preferenceProbe = await openUpgradePreferenceProbe(baseUrl, saved.id, evidenceRoot);
    if (oldCreative) {
      contentPreferenceProbe = await openContentUpgradePreferenceProbe(
        baseUrl,
        saved.id,
        evidenceRoot,
      );
      report.checks.push({
        name: 'old v0.7.0 actual UI saves nondefault content parameters/pricing and built-in template favorite in an isolated browser',
        passed: true,
      });
    }
    report.checks.push({
      name: 'old frozen package saves nondefault browser analysis preferences through actual UI',
      passed: true,
    });
    const extensionOrigin = `chrome-extension://${'p'.repeat(32)}`;
    const pairCode = await request('/api/bridge/code', 'POST', {});
    const pairedResponse = await fetch(`${baseUrl}/api/bridge/pair`, {
      method: 'POST',
      headers: {
        origin: extensionOrigin,
        'content-type': 'application/json',
        'x-productspy-client': 'extension',
      },
      body: JSON.stringify({ code: pairCode.code }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      pairedResponse.status,
      200,
      'Owned synthetic extension must pair through authenticated code flow.',
    );
    const paired = await pairedResponse.json();
    const extensionToken = paired.data.token;
    assert.equal(typeof extensionToken, 'string');
    const originalCredentials = await readFile(credentialFile);
    const originalUsage = await readFile(usageFile);
    async function verifyPairedRead() {
      const response = await fetch(`${baseUrl}/api/products`, {
        headers: {
          origin: extensionOrigin,
          'x-productspy-client': 'extension',
          authorization: `Bearer ${extensionToken}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(
        response.status,
        200,
        'Original paired token must still authenticate after upgrade/restart.',
      );
      assert.equal((await response.json()).data[0].id, saved.id);
    }
    const oldDatabase = await readFile(databaseFile, 'utf8');
    if (oldCreative) oldBusinessBytes = await businessFileSnapshot(dataRoot);
    await stop(oldLaunch);
    assert.equal(
      await readFile(databaseFile, 'utf8'),
      oldDatabase,
      'Stopping the old package must not alter the saved database.',
    );
    report.checks.push({
      name: `${oldInventory.version} saves complete Product, edited analysis/history and supported group/tag metadata; stop leaves bytes unchanged`,
      passed: true,
    });

    const newLaunch = await start(newPackage, newInventory.version);
    if (oldCreative) {
      await assertBusinessFileSnapshot(dataRoot, oldBusinessBytes);
      assert.deepEqual(
        await request(`/api/templates/${oldCreative.template.id}`),
        oldCreative.template,
      );
      assert.deepEqual(
        await request(`/api/content-plans/${oldCreative.content.id}`),
        oldCreative.content,
      );
      const status = await request('/api/workspace-backup?status=1');
      assert.equal(status.counts.templates, 1);
      assert.equal(status.counts.contentPlans, 1);
      assert.equal(status.counts.comparisons, 1);
      await assertBusinessFileSnapshot(dataRoot, oldBusinessBytes);
      report.checks.push({
        name: 'actual v0.7.0 → target first launch preserves products/comparisons/templates/content-plans/analysis-usage exact bytes, custom IDs, all histories/current selections and snapshot references without a read migration rewrite',
        passed: true,
      });
    }
    if (oldComparison) {
      assert.deepEqual(await readFile(join(dataRoot, 'data/comparisons.json')), oldComparisonBytes);
      assert.deepEqual(await request(`/api/comparisons/${oldComparison.id}`), oldComparison);
      report.checks.push({
        name: `actual v${oldInventory.version} comparison snapshots, media metadata, merchant specifications and complete generated/manual history are byte-preserved on upgrade`,
        passed: true,
      });
    }
    assert.deepEqual(
      await readFile(settingsFile),
      originalSettings,
      'Upgrade must leave protected settings byte-identical.',
    );
    await readFixtureSettings(newPackage);
    assert.deepEqual(
      await readFile(credentialFile),
      originalCredentials,
      'Upgrade must preserve paired credential bytes.',
    );
    assert.deepEqual(
      await readFile(usageFile),
      originalUsage,
      'Upgrade must preserve old usage ledger bytes.',
    );
    await verifyPairedRead();
    report.checks.push({
      name: 'upgrade preserves protected settings, paired token and old usage ledger byte-for-byte; original token remains usable',
      passed: true,
    });
    await preferenceProbe.verifyAfterRestart('after-upgrade');
    if (contentPreferenceProbe) await contentPreferenceProbe.verifyAfterRestart('after-upgrade');
    report.checks.push({
      name: 'same isolated browser retains saved analysis preferences across actual old-to-new package upgrade',
      passed: true,
    });
    const upgraded = await onlyProduct(saved.id);
    assert.deepEqual(
      upgraded,
      oldProduct,
      'Upgrade must preserve the entire Product, ID, timestamps, media and complete analysis.',
    );
    assert.equal(
      await readFile(databaseFile, 'utf8'),
      oldDatabase,
      'Reading with the new package must not rewrite old data.',
    );
    const oldLibrary = await request('/api/library');
    assert.deepEqual(oldLibrary.groups, baselineLibrary.groups);
    assert.deepEqual(oldLibrary.tags, baselineLibrary.tags);
    assert.equal(
      await readFile(databaseFile, 'utf8'),
      oldDatabase,
      'Default library metadata must be read-only.',
    );
    await snapshot('02-after-upgrade', upgraded);
    report.checks.push({
      name: `${oldInventory.version} → current package preserves entire Product, ID, timestamps, group/tag definitions, analysis metadata and history`,
      passed: true,
    });

    const editedDraft = {
      ...fixture,
      title: `${fixture.title} · 新版本编辑`,
      price: '$24.95',
      bulletPoints: [...fixture.bulletPoints, 'Edit made through the new package API'],
    };
    const edited = await request('/api/products', 'POST', editedDraft);
    assert.deepEqual(
      asDraft(edited),
      editedDraft,
      'Edited product must retain all fields after saving.',
    );
    assert.equal(edited.id, oldProduct.id, 'Editing must update the existing product ID.');
    assert.equal(
      edited.createdAt,
      oldProduct.createdAt,
      'Editing must retain its original creation time.',
    );
    assert(
      Date.parse(edited.updatedAt) > Date.parse(oldProduct.updatedAt),
      'Editing must advance updatedAt.',
    );
    assert.equal(
      edited.aiAnalysis,
      undefined,
      'Content changes intentionally invalidate the previous analysis.',
    );
    const editedAnalysis = await request('/api/analyze-product', 'POST', edited);
    assertCompleteAnalysis(editedAnalysis);
    const generated = await onlyProduct(saved.id);
    assert(
      generated.analysisHistory?.some(
        (entry) => JSON.stringify(entry.analysis) === JSON.stringify(oldAnalysis),
      ),
      'Recapture must retain the v0.4.0 edited analysis history before invalidating it.',
    );
    const manualAnalysis = {
      ...generated.aiAnalysis,
      summary: '人工修改：升级后必须保留这个摘要。',
    };
    const manual = await request(`/api/products/${encodeURIComponent(saved.id)}`, 'PATCH', {
      analysis: manualAnalysis,
      expectedUpdatedAt: generated.updatedAt,
    });
    const manualVersion = manual.analysisHistory.find(
      (entry) => entry.kind === 'edited' && entry.analysis.summary === manualAnalysis.summary,
    );
    assert(manualVersion, 'Manual edits must be versioned.');
    const options = {
      market: 'JP',
      language: 'ja',
      platform: 'Shorts',
      style: 'professional',
      duration: 15,
      goal: 'consideration',
      customInstructions: 'Show a tabletop demonstration.',
    };
    const partialRequest = {
      product: {
        ...asDraft(manual),
        id: manual.id,
        createdAt: manual.createdAt,
        updatedAt: manual.updatedAt,
      },
      options,
      fields: ['hooks'],
      requestId: randomUUID(),
    };
    const partial = await request('/api/analyze-product', 'POST', partialRequest);
    assert.equal(
      partial.product.aiAnalysis.summary,
      manualAnalysis.summary,
      'Regenerating hooks must not overwrite a manual summary.',
    );
    assert.equal(partial.metadata.options.language, 'ja');
    assert(
      partial.product.aiAnalysis.hooks.some((hook) => /[\u3040-\u30ff]/.test(hook)),
      'The regenerated hooks must use selected Japanese.',
    );
    const replay = await request('/api/analyze-product', 'POST', partialRequest);
    assert.equal(
      replay.replayed,
      true,
      'Repeating a completed request ID must replay without another generation.',
    );
    assert.deepEqual(replay.product, partial.product);
    const usage = await request('/api/analysis-usage');
    assert(
      usage.records.some(
        (entry) => entry.requestId === partialRequest.requestId && entry.status === 'succeeded',
      ),
    );
    assert.equal(usage.totals.realRequests, 0, 'Upgrade tests must never call real AI.');
    report.checks.push({
      name: 'legacy archive, manual version, Japanese partial generation, request replay and local usage ledger',
      passed: true,
    });
    const restored = await request(
      `/api/products/${encodeURIComponent(saved.id)}/analysis-history`,
      'POST',
      { versionId: manualVersion.id, expectedUpdatedAt: partial.product.updatedAt },
    );
    assert.deepEqual(
      restored.aiAnalysis,
      manualAnalysis,
      'Restoring a version must preserve the complete manual analysis.',
    );
    assert.equal(restored.analysisHistory.at(-1).kind, 'restored');
    const groupLibrary = await request('/api/library', 'POST', {
      kind: 'group',
      action: 'create',
      name: '升级后分组',
      color: '#0f766e',
    });
    const group = groupLibrary.groups.find((entry) => entry.name === '升级后分组');
    const tagLibrary = await request('/api/library', 'POST', {
      kind: 'tag',
      action: 'create',
      name: '升级后标签',
      color: '#b45309',
    });
    const tag = tagLibrary.tags.find((entry) => entry.name === '升级后标签');
    assert(group && tag, 'New package must persist definitions.');
    const groupBatch = await request('/api/library/batch', 'POST', {
      ids: [saved.id, 'missing-product'],
      operation: 'add-groups',
      groupIds: [group.id],
    });
    assert.deepEqual(groupBatch.succeededIds, [saved.id]);
    assert.equal(groupBatch.failures.length, 1);
    await request('/api/library/batch', 'POST', {
      ids: [saved.id],
      operation: 'add-tags',
      tagIds: [tag.id],
    });
    const organized = await onlyProduct(saved.id);
    assert.deepEqual(organized.aiAnalysis, restored.aiAnalysis);
    assert.deepEqual(organized.analysisHistory, restored.analysisHistory);
    assert.deepEqual(organized.analysisMetadata, restored.analysisMetadata);
    assert.deepEqual(organized.groupIds, [
      ...baselineLibrary.groups.map((item) => item.id),
      group.id,
    ]);
    assert.deepEqual(organized.tagIds, [...baselineLibrary.tags.map((item) => item.id), tag.id]);
    report.checks.push({
      name: 'new groups/tags and partial batch failure preserve all upgraded AI versions and metadata',
      passed: true,
    });
    const beforeRestart = await onlyProduct(saved.id);
    assert.deepEqual(asDraft(beforeRestart), editedDraft);
    assert.deepEqual(beforeRestart.aiAnalysis, manualAnalysis);
    await snapshot('03-edited-before-restart', beforeRestart);
    const editedDatabase = await readFile(databaseFile, 'utf8');
    await stop(newLaunch);
    assert.equal(await readFile(databaseFile, 'utf8'), editedDatabase);
    report.checks.push({
      name: 'new package updates existing ID, keeps createdAt, archives stale analysis and restores version without losing newer history',
      passed: true,
    });

    const restarted = await start(newPackage, newInventory.version);
    assert.deepEqual(await readFile(settingsFile), originalSettings);
    await readFixtureSettings(newPackage);
    assert.deepEqual(await readFile(credentialFile), originalCredentials);
    await verifyPairedRead();
    await preferenceProbe.verifyAfterRestart('after-restart');
    if (contentPreferenceProbe) await contentPreferenceProbe.verifyAfterRestart('after-restart');
    if (oldCreative) {
      assert.deepEqual(
        await request(`/api/templates/${oldCreative.template.id}`),
        oldCreative.template,
      );
      assert.deepEqual(
        await request(`/api/content-plans/${oldCreative.content.id}`),
        oldCreative.content,
      );
      assert.deepEqual(
        await readFile(join(dataRoot, 'data/templates.json')),
        oldBusinessBytes.get('templates.json'),
      );
      assert.deepEqual(
        await readFile(join(dataRoot, 'data/content-plans.json')),
        oldBusinessBytes.get('content-plans.json'),
      );
      assert.deepEqual(
        await readFile(join(dataRoot, 'data/comparisons.json')),
        oldBusinessBytes.get('comparisons.json'),
      );
      report.checks.push({
        name: 'old v0.7.0 saved content/template/comparison snapshots and complete history remain byte-identical after source product recapture, new analysis/group/tag mutations and real new-package restart',
        passed: true,
      });
    }
    report.checks.push({
      name: 'new package restart retains DPAPI settings, original pairing and same-browser saved preferences',
      passed: true,
    });
    const afterRestart = await onlyProduct(saved.id);
    assert.deepEqual(
      afterRestart,
      beforeRestart,
      'Restart must preserve every edited field and complete refreshed analysis.',
    );
    const restartedLibrary = await request('/api/library');
    assert(restartedLibrary.groups.some((entry) => entry.id === group.id));
    assert(restartedLibrary.tags.some((entry) => entry.id === tag.id));
    for (const definition of baselineLibrary.groups)
      assert(restartedLibrary.groups.some((entry) => entry.id === definition.id));
    for (const definition of baselineLibrary.tags)
      assert(restartedLibrary.tags.some((entry) => entry.id === definition.id));
    await snapshot('04-edited-after-restart', afterRestart);
    await stop(restarted);
    assert.equal(await readFile(databaseFile, 'utf8'), editedDatabase);
    report.checks.push({
      name: 'new package restart preserves complete edited Product and analysis, then releases owned processes',
      passed: true,
    });
    if (['0.6.0', '0.7.0', '0.8.0'].includes(newInventory.version)) {
      const comparisonLaunch = await start(newPackage, newInventory.version);
      const beforeComparison = await request(`/api/products/${encodeURIComponent(saved.id)}`);
      const extra = await request('/api/products', 'POST', {
        ...fixture,
        sourceId: 'B0COMPARE2',
        url: 'https://www.amazon.com/dp/B0COMPARE2',
        title: 'Phase 17 合成竞品（升级测试）',
        currency: 'GBP',
        price: '£18',
        specifications: [{ name: 'Material', value: 'Merchant-declared steel', source: 'page' }],
        mediaMetadata: [
          {
            url: fixture.mainImage,
            kind: 'image',
            productSourceId: 'B0COMPARE2',
            sourceUrl: 'https://www.amazon.com/dp/B0COMPARE2',
            extractedAt: new Date().toISOString(),
            width: 1800,
            height: 1800,
          },
        ],
      });
      let plan = await request('/api/comparisons', 'POST', {
        name: 'Upgrade snapshot fixture',
        productIds: [saved.id, extra.id],
      });
      const generated = await request('/api/analyze-comparison', 'POST', {
        comparisonId: plan.id,
        expectedUpdatedAt: plan.updatedAt,
        requestId: randomUUID(),
        options: { language: 'ja', market: 'JP', platform: 'Shorts' },
      });
      plan = generated.plan;
      assert.equal(plan.analysisMetadata.mode, 'mock');
      assert.equal(plan.analysisMetadata.evidence.reviewTextAnalyzed, false);
      const firstVersion = plan.analysisHistory[0];
      plan = await request(`/api/comparisons/${plan.id}`, 'PATCH', {
        expectedUpdatedAt: plan.updatedAt,
        analysis: { ...plan.analysis, coreDifferences: ['人工对比结论，升级与恢复必须保留。'] },
      });
      assert.equal(plan.analysisHistory.length, 2);
      const backup = await request('/api/comparisons/backup');
      const preview = await request('/api/comparisons/backup', 'POST', { backup });
      assert(preview.conflicts.some((conflict) => conflict.id === plan.id));
      const restoredBackup = await request('/api/comparisons/backup', 'POST', {
        backup,
        commit: true,
        expectedRevision: preview.revision,
        policy: 'preserve',
      });
      assert.equal(restoredBackup.skipped, preview.conflicts.length);
      assert.deepEqual(await request(`/api/comparisons/${plan.id}`), plan);
      await request(`/api/products/${encodeURIComponent(extra.id)}`, 'DELETE');
      assert.deepEqual(
        await request(`/api/comparisons/${plan.id}`),
        plan,
        'Deleting source product cannot delete independent snapshots/history.',
      );
      assert.deepEqual(
        await request(`/api/products/${encodeURIComponent(saved.id)}`),
        beforeComparison,
        'Comparison operations cannot alter original upgraded product or AI versions.',
      );
      const comparisonBytes = await readFile(join(dataRoot, 'data/comparisons.json'));
      await stop(comparisonLaunch);
      const comparisonRestart = await start(newPackage, newInventory.version);
      assert.deepEqual(await readFile(join(dataRoot, 'data/comparisons.json')), comparisonBytes);
      assert.deepEqual(await request(`/api/comparisons/${plan.id}`), plan);
      const restored = await request(`/api/comparisons/${plan.id}`, 'PATCH', {
        expectedUpdatedAt: plan.updatedAt,
        restoreVersionId: firstVersion.id,
      });
      assert.equal(restored.analysisHistory.length, 3);
      assert.deepEqual(restored.analysis, firstVersion.analysis);
      assert.deepEqual(
        await request(`/api/products/${encodeURIComponent(saved.id)}`),
        beforeComparison,
      );
      await stop(comparisonRestart);
      report.checks.push({
        name: '0.6.0 independent comparison snapshots, Mock/edited/restored versions, safe backup conflicts, deleted source survival and restart preserve original upgraded Product/history',
        passed: true,
      });
    }
    if (['0.7.0', '0.8.0'].includes(newInventory.version)) {
      const contentLaunch = await start(newPackage, newInventory.version);
      const protectedProduct = await request(`/api/products/${saved.id}`);
      const { template, content } = await seedContentFixture(
        saved.id,
        oldComparison?.id,
        '新包写入验证',
      );
      for (const endpoint of ['/api/templates/backup', '/api/content-plans/backup']) {
        const backup = await request(endpoint);
        const preview = await request(endpoint, 'POST', { backup });
        assert(preview.conflicts.length >= 1);
        const restored = await request(endpoint, 'POST', {
          backup,
          commit: true,
          expectedRevision: preview.revision,
          policy: 'skip',
        });
        assert(restored.skipped >= 1);
      }
      assert.deepEqual(await request(`/api/products/${saved.id}`), protectedProduct);
      if (oldComparison)
        assert.deepEqual(await request(`/api/comparisons/${oldComparison.id}`), oldComparison);
      const persistedFiles = await Promise.all(
        ['products.json', 'comparisons.json', 'templates.json', 'content-plans.json'].map(
          async (file) => [file, await readFile(join(dataRoot, 'data', file))],
        ),
      );
      await stop(contentLaunch);
      const contentRestart = await start(newPackage, newInventory.version);
      for (const [file, bytes] of persistedFiles)
        assert.deepEqual(await readFile(join(dataRoot, 'data', file)), bytes);
      assert.deepEqual(await request(`/api/content-plans/${content.id}`), content);
      assert.deepEqual(await request(`/api/templates/${template.id}`), template);
      assert.deepEqual(await readFile(settingsFile), originalSettings);
      await verifyPairedRead();
      await stop(contentRestart);
      report.checks.push({
        name: '0.7.0 templates/restored history, custom 45-second Mock content, protected manual current/candidate/replay/history, safe backups and true service restart retain old product/comparison/settings/pairing',
        passed: true,
      });
    }
    report.passed = true;
  } catch (error) {
    failure = error;
    report.passed = false;
    report.error = error.message;
  } finally {
    if (contentPreferenceProbe) {
      try {
        await contentPreferenceProbe.close();
      } catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push(error.message);
        report.passed = false;
        failure ??= error;
      }
    }
    if (preferenceProbe) {
      try {
        await preferenceProbe.close();
      } catch (error) {
        report.cleanupErrors ??= [];
        report.cleanupErrors.push(error.message);
        report.passed = false;
        failure ??= error;
      }
    }
    for (const record of activeLaunchers) {
      try {
        await stop(record);
      } catch (error) {
        if (!record.done) {
          record.child.kill();
          await bounded(record.completion, 15_000, 'Test launcher cleanup timed out').catch(
            () => undefined,
          );
        }
        report.cleanupErrors ??= [];
        report.cleanupErrors.push(error.message);
        report.passed = false;
        failure ??= error;
      }
    }
    report.finishedAt = new Date().toISOString();
    await writeFile(join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence: evidenceRoot }, null, 2));
    if (failure) process.exitCode = 1;
  }
}

function asDraft(product) {
  return Object.fromEntries(draftFields.map((field) => [field, product[field]]));
}

async function businessFileSnapshot(dataRoot) {
  return new Map(
    await Promise.all(
      [
        'products.json',
        'comparisons.json',
        'templates.json',
        'content-plans.json',
        'analysis-usage.json',
      ].map(async (name) => [name, await readFile(join(dataRoot, 'data', name))]),
    ),
  );
}

async function assertBusinessFileSnapshot(dataRoot, expected) {
  for (const [name, bytes] of expected)
    assert.deepEqual(
      await readFile(join(dataRoot, 'data', name)),
      bytes,
      `Read-only upgrade must preserve every original byte in ${name}.`,
    );
}

/** Exercise the running frozen/new package APIs rather than writing a current-schema fixture. */
async function seedContentFixture(productId, comparisonId, label) {
  const { templates } = await request('/api/templates');
  const builtin = templates.find((template) => template.origin === 'builtin');
  assert(builtin, 'Running package must supply built-in templates.');
  const definition = Object.fromEntries(
    [
      'name',
      'description',
      'scenario',
      'category',
      'tags',
      'favorite',
      'prompt',
      'outputFields',
      'outputRequirements',
    ].map((key) => [key, builtin[key]]),
  );
  let template = await request('/api/templates', 'POST', {
    ...definition,
    name: `${label} 自定义模板`,
    tags: ['升级回归'],
    favorite: true,
    prompt: '仅使用 {{product_title}} 的页面资料，保留人工内容。',
  });
  const originalVersion = template.versions[0];
  template = await request(`/api/templates/${template.id}`, 'PATCH', {
    expectedUpdatedAt: template.updatedAt,
    definition: {
      ...definition,
      name: `${label} 人工模板`,
      tags: ['人工修改'],
      favorite: true,
      prompt: '按 {{duration}} 秒设计 {{product_title}} 的脚本。',
    },
  });
  template = await request(`/api/templates/${template.id}`, 'PATCH', {
    expectedUpdatedAt: template.updatedAt,
    restoreVersionId: originalVersion.id,
  });
  assert.equal(template.versions.length, 3);
  assert.equal(template.versions.at(-1).restoredFrom, originalVersion.id);
  let content = await request('/api/content-plans', 'POST', {
    name: `${label} 合成内容回归`,
    productId,
    templateId: template.id,
    options: {
      language: 'ja',
      market: 'JP',
      platform: 'Reels',
      style: 'casual',
      goal: 'consideration',
      duration: 45,
      creativeDirection: '日常可拍摄场景',
      customInstructions: '不要虚构评论或规格，只安排桌面演示。',
      customPrompt: '输出具体可拍摄镜头，并注明待验证内容。',
    },
    ...(comparisonId ? { comparisonId } : {}),
  });
  const first = await request('/api/generate-content', 'POST', {
    planId: content.id,
    expectedUpdatedAt: content.updatedAt,
    options: content.options,
    requestId: randomUUID(),
  });
  content = first.plan;
  assert.equal(first.version.metadata.mode, 'mock');
  assert.equal(first.version.metadata.options.duration, 45);
  assert.equal(first.version.metadata.evidence.reviewTextAnalyzed, false);
  const editedOutput = {
    ...first.version.output,
    sellingCopy: [`${label} 人工创作，不得被重新生成覆盖`],
  };
  content = await request(`/api/content-plans/${content.id}`, 'PATCH', {
    expectedUpdatedAt: content.updatedAt,
    output: editedOutput,
  });
  const manualVersionId = content.currentVersionId;
  const regeneration = {
    planId: content.id,
    expectedUpdatedAt: content.updatedAt,
    options: content.options,
    selectedFields: ['hooks'],
    requestId: randomUUID(),
  };
  const candidate = await request('/api/generate-content', 'POST', regeneration);
  content = candidate.plan;
  assert.equal(content.currentVersionId, manualVersionId);
  assert.deepEqual(candidate.version.output.sellingCopy, editedOutput.sellingCopy);
  assert.deepEqual(candidate.version.metadata.selectedFields, ['hooks']);
  const replay = await request('/api/generate-content', 'POST', regeneration);
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.versions.length, 3);
  content = await request(`/api/content-plans/${content.id}`, 'PATCH', {
    expectedUpdatedAt: content.updatedAt,
    restoreVersionId: first.version.id,
  });
  content = await request(`/api/content-plans/${content.id}`, 'PATCH', {
    expectedUpdatedAt: content.updatedAt,
    favorite: true,
    status: 'needs-edit',
  });
  assert.equal(content.versions.length, 4);
  assert.equal(content.versions.at(-1).restoredFrom, first.version.id);
  assert.equal(content.productId, productId);
  assert.equal(content.templateSnapshot.id, template.id);
  if (comparisonId) assert.equal(content.comparisonSource.id, comparisonId);
  return { template, content };
}

async function request(path, method = 'GET', body) {
  const headers = {
    origin: baseUrl,
    'content-type': 'application/json',
    'x-productspy-client': 'web',
    'sec-fetch-site': 'same-origin',
  };
  if (path !== '/api/status' && !sessionCookie) {
    const session = await fetch(`${baseUrl}/api/session`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(session.status, 200, 'Packaged web session authentication must succeed.');
    const cookie = session.headers.get('set-cookie')?.split(';')[0];
    assert(cookie, 'Session must issue an HttpOnly cookie.');
    sessionCookie = cookie;
  }
  if (path !== '/api/status') headers.cookie = sessionCookie;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  assert.equal(
    response.status,
    200,
    `${method} ${path} failed: ${result.error ?? response.status}`,
  );
  assert.equal(result.ok, true, `${method} ${path} returned an API failure.`);
  return result.data;
}

async function products() {
  const all = await request('/api/products');
  assert(Array.isArray(all), 'Product list must be an array.');
  return all;
}

async function onlyProduct(id) {
  const all = await products();
  assert.equal(all.length, 1, 'Saving the same ASIN must keep exactly one product.');
  assert.equal(all[0].id, id);
  const detail = await request(`/api/products/${encodeURIComponent(id)}`);
  assert.deepEqual(detail, all[0], 'List and detail API must expose the same complete product.');
  return detail;
}

function assertCompleteAnalysis(analysis) {
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
    assert(
      Array.isArray(analysis[field]) && analysis[field].length > 0,
      `Missing analysis field ${field}`,
    );
    assert(analysis[field].every((item) => typeof item === 'string' && item.length > 0));
  }
  assert(analysis.hooks.length >= 5);
  for (const label of ['Hook', 'Problem', 'Solution', 'Demo', 'CTA']) {
    assert(
      new RegExp(`(?:^|\\n)${label}\\s*[:：]`, 'i').test(analysis.shortVideoScript),
      `Missing script section ${label}`,
    );
  }
}

async function inspectPackage(directory) {
  const inventory = JSON.parse(await readFile(join(directory, 'bundle-manifest.json'), 'utf8'));
  assert.equal(inventory.kind, 'ProductSpy-portable');
  assert.equal(inventory.architecture, 'windows-x64');
  for (const file of [
    'launcher/ProductSpy.ps1',
    'launcher/run-server.cjs',
    'runtime/node.exe',
    'app/apps/web/server.js',
  ]) {
    const path = resolve(directory, file);
    const local = relative(directory, path);
    assert(local && !local.startsWith('..'), 'Package file cannot escape its directory.');
    assert((await stat(path)).isFile(), `Missing portable file ${file}`);
    const listed = inventory.files.find((entry) => entry.path.replaceAll('\\', '/') === file);
    assert(listed, `Bundle manifest is missing ${file}`);
    const bytes = await readFile(path);
    assert.equal(bytes.length, listed.bytes, `Bundle file size mismatch: ${file}`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      listed.sha256,
      `Bundle SHA-256 mismatch: ${file}`,
    );
  }
  return inventory;
}

async function assertPortFree() {
  const probe = createServer();
  try {
    await new Promise((complete, reject) => {
      probe.once('error', reject);
      probe.listen({ port: 3000, host: '::', ipv6Only: false }, complete);
    });
  } catch (error) {
    throw new Error(
      `Port 3000 is unavailable (${error.code}). Exit the existing service before upgrade tests; no unknown listener will be stopped.`,
    );
  } finally {
    if (probe.listening)
      await new Promise((complete, reject) =>
        probe.close((error) => (error ? reject(error) : complete())),
      );
  }
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
    await new Promise((complete) => setTimeout(complete, 200));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
