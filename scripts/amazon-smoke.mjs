import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/* global chrome */

const url =
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
  'https://www.amazon.com/dp/B09B8V1LZ3';
const saveToTestWorkspace = process.argv.includes('--save');
const dist = resolve('apps/extension/dist');
const output = resolve('test-results/live-amazon');
await mkdir(output, { recursive: true });
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});
let report;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const amazon = context.pages()[0];
  await amazon.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const session = await context.browser().newBrowserCDPSession();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === amazon.url());
  if (!target) throw new Error('Amazon tab target not found');
  const id = new URL(worker.url()).hostname;
  await session.send('Extensions.triggerAction', { id, targetId: target.targetId });
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await amazon.bringToFront();
  const result = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
  );
  report =
    result.status === 'captured'
      ? {
          verified: true,
          pageUrl: amazon.url(),
          title: result.draft.title,
          mainImage: result.draft.mainImage,
          asin: result.draft.sourceId,
          price: result.draft.price,
          images: result.draft.images.length,
          videos: result.draft.videos.length,
          bulletPoints: result.draft.bulletPoints.length,
          rating: result.draft.rating,
          reviewCount: result.draft.reviewCount,
        }
      : {
          verified: false,
          pageUrl: amazon.url(),
          message: result.error ?? '页面不受支持',
          pageTitle: await amazon.title(),
        };
  await amazon.screenshot({ path: resolve(output, 'page.png') });
  if (result.status === 'captured' && result.draft.mainImage) {
    try {
      const media = await context.request.get(result.draft.mainImage, { timeout: 15000 });
      report.mainImageStatus = media.status();
      report.mainImageContentType = media.headers()['content-type'];
    } catch (error) {
      report.mainImageCheck = String(error);
    }
  }
  if (saveToTestWorkspace && result.status === 'captured') {
    const workspace = await context.newPage();
    await workspace.goto('http://127.0.0.1:3000');
    const mode = await workspace.evaluate(
      async () => (await (await fetch('/api/status')).json()).data.mode,
    );
    if (mode !== 'mock')
      throw new Error('Live smoke save only runs in Mock mode to avoid paid generation');
    const saved = await popup.evaluate(
      (draft) => chrome.runtime.sendMessage({ type: 'PRODUCTSPY_SAVE', draft }),
      result.draft,
    );
    if (saved.status !== 'saved') throw new Error(saved.error ?? 'Bridge save failed');
    await workspace.goto(
      `http://127.0.0.1:3000/products/${encodeURIComponent(saved.product.id)}?tab=analysis`,
    );
    await workspace.getByRole('heading', { name: saved.product.title, exact: true }).waitFor();
    await workspace.getByRole('button', { name: /^(开始|重新) AI 分析$/ }).click();
    await workspace.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
    await workspace.reload();
    await workspace.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
    await workspace.screenshot({ path: resolve(output, 'workspace.png'), fullPage: true });
    report.workflow = {
      saved: true,
      detailOpened: true,
      mockAnalysis: true,
      persistedAfterReload: true,
    };
  }
} catch (error) {
  report = { verified: false, pageUrl: url, message: String(error) };
} finally {
  await context.close();
}
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.verified) process.exitCode = 1;
