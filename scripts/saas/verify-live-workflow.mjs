import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import pg from '../../apps/web/node_modules/pg/lib/index.js';

// Opt-in manual verification: external Amazon availability must never become a fixture fallback.
// All account/product writes are confined to an explicitly empty local test PostgreSQL database.
const databaseURL = process.env.PRODUCTSPY_TEST_DATABASE_URL;
if (!databaseURL)
  throw new Error('Set PRODUCTSPY_TEST_DATABASE_URL to an empty local test database.');
let database;
try {
  database = new URL(databaseURL);
} catch {
  throw new Error('Invalid test database URL; credentials are omitted.');
}
if (
  !['postgres:', 'postgresql:'].includes(database.protocol) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname) ||
  !/^\/productspy_live_[a-z0-9_]+$/.test(database.pathname) ||
  database.search ||
  database.hash
)
  throw new Error('Use a dedicated loopback database named productspy_live_*.');
const base = 'http://127.0.0.1:3100';
const output = resolve('.test-data/saas/live-workflow', String(Date.now()));
const dist = resolve('apps/extension/dist-saas-e2e');
const directory = resolve('apps/web/.next/standalone/apps/web');
const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.host_permissions, [`${base}/*`]);
await mkdir(output, { recursive: true });
const pool = new pg.Pool({ connectionString: databaseURL });
const runId = randomUUID();
const email = `live-workflow-${runId}@example.invalid`;
const otherEmail = `live-stranger-${runId}@example.invalid`;
const password = `Synthetic-live-${randomUUID()}`;
const createdAccounts = new Set();
const report = {
  startedAt: new Date().toISOString(),
  outcome: 'RUNNING',
  stage: 'preflight',
  scope: {
    amazon: 'actual public Amazon page, no route fixtures or modified DOM',
    extension: 'actual MV3 with activeTab; popup UI in an extension tab, not native popup sizing',
    backend: 'local HTTP + actual PostgreSQL restricted application role',
    ai: 'Mock only; no external AI or payment request',
    persistence: 'restart actual standalone web process, retain the same PostgreSQL database',
    crossDevice: 'isolated browser contexts on one physical computer only',
    cloud: 'not deployed; no external TLS tested',
  },
  checks: [],
};
const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  PRODUCTSPY_MODE: 'saas',
  PRODUCTSPY_ENV: 'test',
  PRODUCTSPY_APP_URL: base,
  PRODUCTSPY_DB_DRIVER: 'pg',
  PRODUCTSPY_AUTO_MIGRATE: '0',
  PRODUCTSPY_JOB_RUNNER: 'external',
  PRODUCTSPY_ARCHIVE_SECRET: 'synthetic-live-workflow-archive-secret-not-for-production',
  DATABASE_URL: databaseURL,
  HOSTNAME: '127.0.0.1',
  PORT: '3100',
  AI_MODE: 'mock',
  STRIPE_SECRET_KEY: '',
  STRIPE_WEBHOOK_SECRET: '',
};
let server, context, browser;
async function stopServer() {
  const current = server;
  server = undefined;
  if (current && current.exitCode === null && current.signalCode === null) {
    const closed = once(current, 'close');
    current.kill('SIGTERM');
    await closed;
  }
}
async function startServer() {
  // Fail if another process owns the port; never reuse or stop a user's server.
  const probe = createServer();
  probe.listen(3100, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((complete) => probe.close(complete));
  server = spawn(process.execPath, [resolve(directory, 'server.js')], {
    cwd: directory,
    env: serverEnv,
    windowsHide: true,
    stdio: 'ignore',
  });
  let launchError;
  server.on('error', (error) => {
    launchError = error;
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (launchError || server.exitCode !== null)
      throw new Error('Standalone server failed to start.');
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Readiness may precede the listening socket/database. */
    }
    await new Promise((complete) => setTimeout(complete, 100));
  }
  throw new Error('Standalone readiness timed out.');
}
async function register(page, accountEmail) {
  await page.goto(`${base}/register`);
  await page.getByLabel('姓名', { exact: true }).fill('Synthetic Live Workflow');
  await page.getByLabel('邮箱', { exact: true }).fill(accountEmail);
  await page.getByLabel('密码', { exact: true }).fill(password);
  const registered = page.waitForResponse(
    (item) => item.url() === `${base}/api/auth/register` && item.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  const response = await registered;
  assert(response.ok(), 'Synthetic account registration failed.');
  const userId = (await response.json()).data?.user?.id;
  assert(
    typeof userId === 'string' && /^[a-f0-9-]{36}$/.test(userId),
    'Registration did not return an account id.',
  );
  createdAccounts.add(userId);
  await expect(page).toHaveURL(`${base}/`);
}
try {
  const role = (
    await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')
  ).rows[0];
  assert(role && !role.rolsuper && !role.rolbypassrls, 'Use a restricted application role.');
  const count = await pool.query('SELECT count(*)::int AS count FROM users');
  assert.equal(count.rows[0].count, 0, 'Use an empty dedicated test database.');
  await cp(resolve('apps/web/.next/static'), resolve(directory, '.next/static'), {
    recursive: true,
  });
  await startServer();
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 950 },
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
  });
  context.setDefaultTimeout(15000);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).hostname;
  const web = context.pages()[0];
  report.stage = 'registration';
  await register(web, email);
  report.checks.push('web-registration');

  report.stage = 'live-amazon';
  const amazon = await context.newPage();
  const response = await amazon.goto('https://www.amazon.com/dp/B09B8V1LZ3', {
    waitUntil: 'domcontentloaded',
    timeout: 45000,
  });
  report.amazonHTTP = response?.status();
  report.amazonURL = amazon.url();
  assert.equal(report.amazonHTTP, 200, 'Live Amazon did not return HTTP 200.');
  await amazon.locator('#productTitle').waitFor({ timeout: 15000 });
  const title = (await amazon.locator('#productTitle').innerText()).replace(/\s+/g, ' ').trim();
  assert(title.length > 0, 'Live product title is missing.');
  const html = await amazon.content();
  report.htmlSha256 = createHash('sha256').update(html).digest('hex');
  await writeFile(resolve(output, 'source.html'), html);
  const cdp = await context.browser().newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === amazon.url());
  assert(target, 'Actual Amazon tab was not found.');
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  await cdp.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await amazon.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
  await expect(popup.getByRole('heading', { name: title, exact: true })).toBeVisible();
  report.checks.push('live-amazon-mv3-capture');

  report.stage = 'extension-login-and-upload';
  await web.goto(`${base}/settings?extensionId=${extensionId}`);
  const dialog = web.getByRole('dialog');
  await dialog.getByRole('button', { name: '生成配对码', exact: true }).click();
  const code = await dialog.getByLabel('扩展配对码', { exact: true }).inputValue();
  assert(/^[a-f0-9]{32}$/.test(code), 'Authorization code was not issued.');
  await amazon.bringToFront();
  await popup.locator('.connection-panel > summary').click();
  await popup.getByLabel('一次性登录授权码', { exact: true }).fill(code);
  await popup.getByRole('button', { name: '登录插件', exact: true }).click();
  await expect(popup.getByText(`当前账号：${email}`, { exact: true })).toBeVisible();
  report.checks.push('extension-account-login');
  await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
  await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
  await popup.screenshot({ path: resolve(output, 'uploaded-extension.png') });
  const listed = await web.request.get(`${base}/api/products`);
  assert(listed.ok(), 'Product listing failed.');
  const products = (await listed.json()).data;
  assert.equal(products.length, 1, 'The extension upload must create exactly one product.');
  const product = products[0];
  assert.equal(product.sourceId, 'B09B8V1LZ3');
  assert.equal(product.title, title);
  report.product = {
    asin: product.sourceId,
    title,
    images: product.images.length,
    videos: product.videos.length,
    bulletPoints: product.bulletPoints.length,
    priceCaptured: product.price !== undefined,
  };
  report.checks.push('actual-extension-http-upload', 'postgres-product-library');

  report.stage = 'mock-analysis-independent-worker';
  const productURL = `${base}/products/${encodeURIComponent(product.id)}`;
  await web.goto(productURL);
  await web.getByRole('tab', { name: 'AI 分析', exact: true }).click();
  const queued = web.waitForResponse(
    (item) => item.url() === `${base}/api/jobs` && item.request().method() === 'POST',
  );
  await web.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  assert((await queued).ok(), 'Analysis was not persisted in the queue.');
  await promisify(execFile)(
    process.execPath,
    [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/saas/worker.ts'), '--once'],
    { cwd: process.cwd(), env: serverEnv, windowsHide: true, timeout: 30000 },
  );
  await expect(web.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
  await expect(web.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
  await web.screenshot({ path: resolve(output, 'saved-mock-analysis.png') });
  report.checks.push('durable-queue', 'independent-worker-mock-analysis', 'saved-analysis');

  report.stage = 'web-restart-and-independent-session';
  await stopServer();
  await startServer();
  browser = await chromium.launch({ headless: true });
  const second = await browser.newContext();
  const another = await second.newPage();
  await another.goto(`${base}/login`);
  await another.getByLabel('邮箱', { exact: true }).fill(email);
  await another.getByLabel('密码', { exact: true }).fill(password);
  await another.getByRole('button', { name: '登录', exact: true }).click();
  await expect(another).toHaveURL(`${base}/`);
  await another.goto(productURL);
  await another.getByRole('tab', { name: 'AI 分析', exact: true }).click();
  await expect(another.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
  await expect(another.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
  report.checks.push(
    'web-process-restart-persistence',
    'independent-browser-login-and-saved-analysis',
  );
  const strangerContext = await browser.newContext();
  const stranger = await strangerContext.newPage();
  await register(stranger, otherEmail);
  const denied = await stranger.request.get(
    `${base}/api/products/${encodeURIComponent(product.id)}`,
  );
  assert.equal(denied.status(), 404, 'A different account could access the product.');
  report.checks.push('other-account-404');
  report.stage = 'complete';
  report.outcome = 'PASS';
} catch (error) {
  report.outcome = 'BLOCKED_OR_FAILED';
  report.reason = error instanceof Error ? error.message.split('\n')[0] : 'Verification failed.';
  process.exitCode = 1;
} finally {
  await browser?.close();
  await context?.close();
  await stopServer();
  // Only the two random synthetic accounts owned by this run may be removed.
  try {
    if (createdAccounts.size)
      await pool.query('DELETE FROM users WHERE id=ANY($1::text[]) AND email=ANY($2::text[])', [
        [...createdAccounts],
        [email, otherEmail],
      ]);
    report.syntheticAccountsCleaned = true;
  } catch {
    report.syntheticAccountsCleaned = false;
    report.outcome = 'BLOCKED_OR_FAILED';
    report.reason ??=
      'Synthetic account cleanup failed; retain the isolated test database for inspection.';
    process.exitCode = 1;
  }
  await pool.end();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ...report, reportPath: resolve(output, 'report.json') }, null, 2));
