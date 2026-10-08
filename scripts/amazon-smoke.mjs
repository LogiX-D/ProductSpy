import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/* global chrome */

const url =
  process.argv.slice(2).find((argument) => !argument.startsWith('--')) ??
  'https://www.amazon.com/dp/B09B8V1LZ3';
const saveToTestWorkspace = process.argv.includes('--save');
const dist = resolve('apps/extension/dist');
const output = resolve('.test-data/phase9-evidence/live-workflow');
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
  await amazon
    .locator('#productTitle')
    .waitFor({ timeout: 8000 })
    .catch(() => {});
  await amazon.bringToFront();
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
          currency: result.draft.currency,
          brand: result.draft.brand,
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
  await amazon.screenshot({ path: resolve(output, 'page.png'), timeout: 10000 }).catch(() => {});
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
    const connection = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_BRIDGE_STATE' }),
    );
    if (!connection.paired) {
      await workspace.getByRole('button', { name: '查看扩展安装说明' }).click();
      await workspace.getByRole('button', { name: '生成配对码' }).click();
      await workspace.getByLabel('扩展配对码').waitFor();
      const code = await workspace.getByLabel('扩展配对码').inputValue();
      await popup.getByLabel('工作台配对码').fill(code);
      await popup.getByRole('button', { name: '连接工作台', exact: true }).click();
      await popup.getByText('工作台已连接', { exact: true }).waitFor();
    }
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
    const mainImageRendered = await workspace
      .waitForFunction(
        () => {
          const image = document.querySelector('.gallery-main img');
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        },
        undefined,
        { timeout: 20000 },
      )
      .then(() => true)
      .catch(() => false);
    await workspace.screenshot({ path: resolve(output, 'workspace.png'), fullPage: true });
    report.workflow = {
      saved: true,
      bridgePaired: true,
      reusedExistingPairing: connection.paired,
      productId: saved.product.id,
      createdAt: saved.product.createdAt,
      updatedAt: saved.product.updatedAt,
      detailOpened: true,
      mockAnalysis: true,
      persistedAfterReload: true,
      mainImageRendered,
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
