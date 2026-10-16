/* global chrome */
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

const output = resolve(process.argv[2] ?? '');
assert(output.startsWith(resolve('.test-data/final-quality') + sep));
await mkdir(output, { recursive: true });
const extension = resolve('artifacts/ProductSpy-1.0.0-windows-x64/extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const report = {
  startedAt: new Date().toISOString(),
  version: manifest.version_name,
  checks: [],
  environment:
    'isolated Chrome for Testing; automated extension page and actual MV3 worker reload; not stable Chrome UI acceptance',
  nativeManualPasses: [],
  realAiRequests: 0,
  networkRequestsAllowed: 0,
};
let context;
const check = (name, details = {}) => report.checks.push({ name, status: 'PASS', ...details });
async function open() {
  context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  // No bridge writes, media, Amazon or paid endpoints can leave this probe.
  await context.route(/^https?:/, (route) => route.abort('blockedbyclient'));
  report.browserVersion = context.browser().version();
  // An unpacked extension must use the same Developer Mode prerequisite as the
  // documented manual installation. CFT initially honors --load-extension even
  // with that mode off, but a real reload then disables it (Chromium reason 1<<24).
  // Change only the dedicated QA profile through Chrome's actual settings UI.
  const settings = await context.newPage();
  await settings.goto('chrome://extensions/');
  const developerMode = settings.locator('extensions-toolbar #devMode');
  await developerMode.waitFor({ state: 'visible' });
  const developerModeBefore = await developerMode.evaluate((element) => element.checked);
  if (!developerModeBefore) await developerMode.click();
  await expect(developerMode).toHaveJSProperty('checked', true);
  report.developerModeSetup ??= [];
  report.developerModeSetup.push({
    original: developerModeBefore,
    final: true,
    method: 'normal chrome://extensions Developer Mode toggle in isolated QA profile',
  });
  await settings.close();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  return { worker, page, id };
}
async function message(page, request) {
  return page.evaluate((input) => chrome.runtime.sendMessage(input), request);
}
async function state(page) {
  return page.evaluate(() =>
    chrome.storage.local.get([
      'productspy.local.v1',
      'productspy.capture-consent.v1',
      'productspy.bridge-token.v1',
    ]),
  );
}
try {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://localhost/*', 'http://127.0.0.1/*']);
  check('MV3 and least-privilege manifest');
  let { page, worker, id } = await open();
  assert(worker.url().endsWith('/background.js'));
  check('actual bundled MV3 service worker started');
  assert.equal((await message(page, { type: 'PRODUCTSPY_CAPTURE' })).status, 'unsupported');
  check('unsupported extension page returns understandable unsupported result');
  const draft = {
    source: 'amazon',
    sourceId: 'B0QAFINAL1',
    url: 'https://www.amazon.com/dp/B0QAFINAL1',
    title: 'Synthetic isolated reload fixture, not a real Amazon capture',
    price: '$12.00',
    currency: 'USD',
    images: [],
    videos: [],
    bulletPoints: ['Synthetic fixture only'],
  };
  const saved = await message(page, { type: 'PRODUCTSPY_SAVE', draft });
  assert.equal(saved.status, 'pending');
  assert(saved.product.id);
  check('unpaired save uses actual background offline queue without network');
  const repeated = await message(page, {
    type: 'PRODUCTSPY_SAVE',
    draft: { ...draft, price: '$13.00' },
  });
  assert.equal(repeated.status, 'pending');
  assert.equal(repeated.product.id, saved.product.id);
  assert.equal((await message(page, { type: 'PRODUCTSPY_PENDING_COUNT' })).count, 1);
  check('duplicate offline save updates same ID and keeps one ASIN queue entry');
  await page.evaluate(() =>
    chrome.storage.local.set({
      'productspy.capture-consent.v1': { version: 1, acceptedAt: '2026-10-17T00:00:00.000Z' },
      'productspy.bridge-token.v1': 'f'.repeat(64),
    }),
  );
  // An artificial token tests retention only; it is never sent or called a successful pairing.
  const before = await state(page);
  check('synthetic consent and token retention fixture set; no real pairing claim');
  const oldWorkerClosed = new Promise((complete, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Old MV3 worker did not close on reload')),
      20000,
    );
    worker.once('close', () => {
      clearTimeout(timeout);
      complete();
    });
  });
  void oldWorkerClosed.catch(() => undefined);
  await page.evaluate(() => {
    setTimeout(() => chrome.runtime.reload(), 50);
  });
  await oldWorkerClosed;
  // MV3 starts lazily: opening the reloaded popup sends the first background request.
  // Waiting for a new worker before opening a client would deadlock the QA harness.
  const nextWorker = context.waitForEvent('serviceworker', { timeout: 20000 });
  void nextWorker.catch(() => undefined);
  page = await context.newPage();
  const reloadDeadline = Date.now() + 12000;
  for (;;) {
    try {
      await page.goto(`chrome-extension://${id}/popup.html`, { timeout: 3000 });
      break;
    } catch (error) {
      if (Date.now() >= reloadDeadline) throw error;
      await new Promise((complete) => setTimeout(complete, 250));
    }
  }
  worker = await nextWorker;
  assert(worker.url().includes(id));
  assert.deepEqual(await state(page), before);
  check(
    'chrome.runtime.reload replaces actual worker and preserves full cache/queue/consent/synthetic-token bytes',
  );
  assert.equal((await message(page, { type: 'PRODUCTSPY_PENDING_COUNT' })).count, 1);
  assert.equal((await message(page, { type: 'PRODUCTSPY_BRIDGE_STATE' })).paired, true);
  check('reloaded worker reads queue and stored-token state');
  await context.close();
  context = undefined;
  ({ page } = await open());
  assert.deepEqual(await state(page), before);
  check('full isolated browser close/relaunch retains same extension data');
  assert.equal((await message(page, { type: 'PRODUCTSPY_PENDING_COUNT' })).count, 1);
  check('pending draft remains readable after browser restart');
  const invalid = await message(page, {
    type: 'PRODUCTSPY_SAVE',
    draft: { ...draft, url: 'http://127.0.0.1/private' },
  });
  assert.equal(invalid.status, 'error');
  assert.deepEqual(await state(page), before);
  check('invalid source URL is rejected without mutating preserved data');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  throw error;
} finally {
  if (context) await context.close();
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output }));
}
