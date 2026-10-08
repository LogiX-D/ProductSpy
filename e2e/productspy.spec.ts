import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Product } from '../packages/shared/src/types';
import type { ExtensionResponse } from '../apps/extension/src/background/messages';

const BASE = 'http://127.0.0.1:3000';
const ASIN = 'B012345678';
const ID = `amazon:${ASIN}`;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5v8AAAAASUVORK5CYII=',
  'base64',
);

async function openPopup(context: BrowserContext, worker: Worker, amazon: Page): Promise<Page> {
  const id = new URL(worker.url()).hostname;
  await amazon.bringToFront();
  const session = await context.browser()!.newBrowserCDPSession();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find(
    (item: { url: string; targetId: string }) => item.url === amazon.url(),
  );
  if (!target) throw new Error('Amazon test tab not found');
  // This triggers the actual extension action and grants activeTab, without broadening its manifest.
  await session.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await session.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await amazon.bringToFront();
  await popup.reload();
  await popup.setViewportSize({ width: 400, height: 780 });
  return popup;
}

test('production extension → capture → save → workspace → Mock AI → persistence and downloads', async ({
  request,
}, testInfo) => {
  const cleanupHeaders = {
    Origin: BASE,
    'Content-Type': 'application/json',
    'X-ProductSpy-Client': 'web',
  };
  await request.delete(`${BASE}/api/products/${encodeURIComponent(ID)}`, {
    headers: cleanupHeaders,
  });
  const dist = resolve('apps/extension/dist');
  const context = await chromium.launchPersistentContext(testInfo.outputPath('chrome-profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
    viewport: { width: 1360, height: 950 },
  });
  const pageErrors: string[] = [];
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const html = await readFile(
      resolve('apps/extension/tests/fixtures/jsonld-product.html'),
      'utf8',
    );
    await context.route('https://www.amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }),
    );
    await context.route('https://m.media-amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await context.route('https://media.example.com/**', (route) => route.abort());
    const amazon = context.pages()[0];
    await amazon.goto(`https://www.amazon.com/dp/${ASIN}`);
    const popup = await openPopup(context, worker, amazon);
    await expect(popup.getByText('Amazon Product Captured')).toBeVisible();
    await expect(popup.getByRole('heading', { name: 'Portable Coffee Grinder' })).toBeVisible();
    await expect(popup.getByText(ASIN, { exact: true })).toBeVisible();
    await popup.screenshot({ path: testInfo.outputPath('popup.png'), fullPage: true });
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
    const firstBody = (await (
      await request.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(firstBody.data.images).toHaveLength(2);
    expect(firstBody.data.videos).toHaveLength(1);
    expect(firstBody.data.rating).toBe(4.5);
    expect(firstBody.data.reviewCount).toBe(526);

    await amazon.evaluate(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      if (script?.textContent) script.textContent = script.textContent.replace('29.99', '24.99');
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('24.99 USD', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
    const listBody = (await (await request.get(`${BASE}/api/products`)).json()) as {
      data: Product[];
    };
    const saved = listBody.data.filter((product) => product.id === ID);
    expect(saved).toHaveLength(1);
    expect(saved[0].price).toBe('24.99');
    expect(saved[0].createdAt).toBe(firstBody.data.createdAt);
    expect(saved[0].updatedAt > firstBody.data.updatedAt).toBe(true);

    const workspace = await context.newPage();
    await workspace.goto(`${BASE}/products`);
    await expect(
      workspace.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('textbox', { name: '搜索商品' }).fill('no match in fixture');
    await expect(workspace.getByRole('heading', { name: '没有找到匹配商品' })).toBeVisible();
    await workspace.getByRole('button', { name: '清除筛选' }).click();
    await workspace.getByRole('button', { name: '列表视图' }).click();
    await expect(workspace.getByRole('button', { name: '列表视图' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await workspace.getByRole('combobox', { name: '筛选来源' }).selectOption('amazon');
    await workspace.screenshot({ path: testInfo.outputPath('products.png'), fullPage: true });
    await workspace
      .getByRole('link', { name: '打开商品 Portable Coffee Grinder', exact: true })
      .click();
    await expect(
      workspace.getByRole('heading', { name: 'Portable Coffee Grinder', exact: true }),
    ).toBeVisible();
    await workspace.getByRole('tab', { name: /^Media/ }).click();
    await expect(
      workspace.getByRole('button', { name: 'Download Image', exact: true }),
    ).toHaveCount(2);
    // Browser download handling is tested with deterministic image bytes; CDN policy is unit-tested separately.
    await context.route(`${BASE}/api/media?**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    const singleDownload = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: 'Download Image', exact: true }).first().click();
    const image = await singleDownload;
    expect(image.suggestedFilename()).toBe(`${ASIN}-01.png`);
    await image.saveAs(testInfo.outputPath(image.suggestedFilename()));
    const zipDownload = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: 'Download All Images' }).click();
    const archive = await zipDownload;
    expect(archive.suggestedFilename()).toBe(`${ASIN}-images.zip`);
    const zipPath = testInfo.outputPath(archive.suggestedFilename());
    await archive.saveAs(zipPath);
    expect((await readFile(zipPath)).subarray(0, 2).toString()).toBe('PK');

    await workspace.getByRole('tab', { name: 'AI Analysis', exact: true }).click();
    await expect(workspace.getByText('Mock 演示模式', { exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(workspace.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    for (const heading of [
      '核心卖点',
      '用户痛点',
      '目标用户',
      '商品优势',
      '商品弱点 / 待验证',
      'Marketing Angles',
      'TikTok / Reels / Shorts Hooks',
      'Short Video Script',
      'AI Image Prompts',
      'AI Video Prompts',
    ]) {
      await expect(workspace.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    expect(await workspace.locator('.hook-row').count()).toBeGreaterThanOrEqual(5);
    expect(await workspace.locator('.script-label').allTextContents()).toEqual([
      'Hook',
      'Problem',
      'Solution',
      'Demo',
      'CTA',
    ]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await workspace.locator('.hook-row').first().getByRole('button').click();
    await expect(workspace.locator('.hook-row').first().getByRole('button')).toHaveText('已复制');
    await workspace.reload();
    await expect(workspace.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    const analyzedBody = (await (
      await request.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(analyzedBody.data.aiAnalysis?.hooks.length).toBeGreaterThanOrEqual(5);
    await workspace.screenshot({ path: testInfo.outputPath('analysis.png'), fullPage: true });

    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('Amazon Product Captured')).toBeVisible();
    await worker.evaluate(() => {
      const scoped = globalThis as typeof globalThis & { __originalFetch?: typeof fetch };
      scoped.__originalFetch = scoped.fetch;
      scoped.fetch = async () => {
        throw new TypeError('simulated local bridge offline');
      };
    });
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '尚未同步到工作台' })).toBeVisible();
    await worker.evaluate(() => {
      const scoped = globalThis as typeof globalThis & { __originalFetch?: typeof fetch };
      if (scoped.__originalFetch) scoped.fetch = scoped.__originalFetch;
      delete scoped.__originalFetch;
    });
    const synchronized = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_SYNC_PENDING' }),
    );
    expect(synchronized.status).toBe('synced');

    await amazon.goto('https://www.amazon.com/s?k=coffee');
    await amazon.bringToFront();
    await popup.reload();
    await expect(
      popup.getByRole('heading', { name: '当前页面不是支持的 Amazon 商品页面' }),
    ).toBeVisible();
    await workspace.goto(`${BASE}/products`);
    await workspace
      .getByRole('button', { name: '删除商品 Portable Coffee Grinder', exact: true })
      .click();
    await workspace.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(
      workspace.getByRole('heading', { name: '还没有采集商品', exact: true }),
    ).toBeVisible();
    expect(pageErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('API rejects untrusted writes and unsupported media URLs', async ({ request }) => {
  const hostile = await request.post(`${BASE}/api/products`, {
    headers: { Origin: 'https://untrusted.example', 'X-ProductSpy-Client': 'web' },
    data: {},
  });
  expect(hostile.status()).toBe(403);
  const unsupported = await request.get(
    `${BASE}/api/media?url=${encodeURIComponent('https://127.0.0.1/private')}`,
  );
  expect(unsupported.status()).toBe(400);
  expect((await unsupported.json()).ok).toBe(false);
});
