import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const root = resolve('.test-data/phase10-store');
const latest = (await readdir(root, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);
assert(latest, 'Run capture-store.mjs first');
const evidence = resolve(root, latest);
const original = JSON.parse(await readFile(resolve(evidence, 'report.json'), 'utf8'));
assert.equal(original.verified, true);
const database = resolve('.test-data/phase10-store-live/user/data/products.json');
const before = JSON.parse(await readFile(database, 'utf8'));
assert.equal(before.length, 1);
assert(
  before[0].aiAnalysis?.hooks.length >= 5,
  'Previously analyzed real product must survive service restart',
);
const dist = resolve(`artifacts/ProductSpy-${version}-windows-x64/extension`);
const context = await chromium.launchPersistentContext(resolve(evidence, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});
const report = {
  browser: 'Chrome for Testing',
  browserVersion: context.browser().version(),
  fixture: false,
  verified: false,
  productId: before[0].id,
};
try {
  const page = await context.newPage();
  await page.goto(
    `http://127.0.0.1:3000/products/${encodeURIComponent(before[0].id)}?tab=analysis`,
  );
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  assert.equal(
    await page
      .locator('.analysis-summary')
      .textContent()
      .then((text) => text.includes(before[0].aiAnalysis.summary)),
    true,
  );
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const amazon = await context.newPage();
  await amazon.goto(original.pageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await amazon.locator('#productTitle:visible').first().waitFor();
  await amazon.bringToFront();
  const session = await context.browser().newBrowserCDPSession();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === amazon.url());
  assert(target);
  const id = new URL(worker.url()).hostname;
  await session.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await session.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await amazon.bringToFront();
  await popup.reload();
  await popup.getByText('商品已采集', { exact: true }).waitFor();
  await popup.getByText('工作台已连接', { exact: true }).waitFor();
  await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
  await popup.getByRole('status').filter({ hasText: '已保存到素材库' }).waitFor();
  const after = JSON.parse(await readFile(database, 'utf8'));
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].createdAt, before[0].createdAt);
  assert(after[0].updatedAt > before[0].updatedAt);
  Object.assign(report, {
    verified: true,
    analysisSurvivedRestart: true,
    existingConsentRestored: true,
    pairingRestoredWithoutNewCode: true,
    savedAfterRestart: true,
    noDuplicate: true,
    createdAtUnchanged: true,
  });
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await writeFile(resolve(evidence, 'restart-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
