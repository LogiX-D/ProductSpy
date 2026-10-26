/* global chrome */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Read-only real Amazon capture with an isolated browser profile. No SaaS or AI writes.
const output = resolve('.test-data/saas/live-amazon', String(Date.now()));
await mkdir(output, { recursive: true });
const dist = resolve('apps/extension/dist-saas-e2e');
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});
const report = {
  capturedAt: new Date().toISOString(),
  scope:
    'Read-only actual MV3 capture from live Amazon. No SaaS upload, AI or payment; not full cloud acceptance.',
  requestedUrl: 'https://www.amazon.com/dp/B09B8V1LZ3',
};
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 30000 }));
  const page = context.pages()[0];
  const response = await page.goto(report.requestedUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page
    .locator('#productTitle')
    .waitFor({ timeout: 8000 })
    .catch(() => undefined);
  report.httpStatus = response?.status();
  report.finalUrl = page.url();
  const id = new URL(worker.url()).hostname;
  const cdp = await context.browser().newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === page.url());
  if (!target) throw new Error('Amazon tab target was not found');
  await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await cdp.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await page.bringToFront();
  const result = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
  );
  report.outcome = result.status;
  if (result.status === 'captured')
    report.product = {
      asin: result.draft.sourceId,
      title: result.draft.title,
      images: result.draft.images.length,
      videos: result.draft.videos.length,
      bulletPoints: result.draft.bulletPoints.length,
    };
  else report.reason = result.message ?? result.error ?? 'No product was returned';
  const html = await page.content();
  report.htmlSha256 = createHash('sha256').update(html).digest('hex');
  await writeFile(resolve(output, 'source.html'), html);
  await page.screenshot({ path: resolve(output, 'live-amazon.png') });
} catch (error) {
  report.outcome = 'blocked';
  report.reason = error instanceof Error ? error.message : String(error);
} finally {
  await context.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ ...report, reportPath: resolve(output, 'report.json') }, null, 2));
