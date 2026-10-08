import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
  type APIRequestContext,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Product, ProductDraft } from '../packages/shared/src/types';
import type { ExtensionResponse } from '../apps/extension/src/background/messages';

const BASE = 'http://127.0.0.1:3000';
const ASIN = 'B012345678';
const ID = `amazon:${ASIN}`;
const SECOND_ASIN = 'B098765432';
const SECOND_ID = `amazon:${SECOND_ASIN}`;
const WEB_HEADERS = {
  Origin: BASE,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5v8AAAAASUVORK5CYII=',
  'base64',
);

async function authenticateWeb(request: APIRequestContext) {
  const response = await request.post(`${BASE}/api/session`, {
    headers: WEB_HEADERS,
    data: {},
  });
  expect(response.ok()).toBe(true);
  return {
    get: (url: string) => request.get(url, { headers: WEB_HEADERS }),
    delete: (url: string) => request.delete(url, { headers: WEB_HEADERS }),
  };
}

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
  const api = await authenticateWeb(request);
  await api.delete(`${BASE}/api/products/${encodeURIComponent(ID)}`);
  await api.delete(`${BASE}/api/products/${encodeURIComponent(SECOND_ID)}`);
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
    const pairingResponse = await request.post(`${BASE}/api/bridge/code`, {
      headers: WEB_HEADERS,
      data: {},
    });
    expect(pairingResponse.ok()).toBe(true);
    const pairingBody = (await pairingResponse.json()) as { data: { code: string } };
    await popup.getByLabel('工作台配对码').fill(pairingBody.data.code);
    await popup.getByRole('button', { name: '连接工作台', exact: true }).click();
    await expect(popup.getByText('工作台已连接', { exact: true })).toBeVisible();
    await popup.screenshot({ path: testInfo.outputPath('popup.png'), fullPage: true });
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
    const firstBody = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
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
    const listBody = (await (await api.get(`${BASE}/api/products`)).json()) as {
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
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(analyzedBody.data.aiAnalysis?.hooks.length).toBeGreaterThanOrEqual(5);
    await workspace.screenshot({ path: testInfo.outputPath('analysis.png'), fullPage: true });

    // Inject a transport failure only; the previously saved analysis must remain durable.
    const failedAnalysisMessage = '验收模拟：AI 服务暂时不可用';
    await workspace.route(`${BASE}/api/analyze-product`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: failedAnalysisMessage }),
      }),
    );
    await workspace.getByRole('button', { name: '重新 AI 分析', exact: true }).click();
    await expect(workspace.locator('.error-notice')).toContainText(failedAnalysisMessage);
    await expect(workspace.locator('.analysis-summary')).toContainText(
      analyzedBody.data.aiAnalysis!.summary,
    );
    const afterFailedAnalysis = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(afterFailedAnalysis.data).toEqual(analyzedBody.data);
    await workspace.unroute(`${BASE}/api/analyze-product`);
    await workspace.reload();
    await expect(workspace.locator('.analysis-summary')).toContainText(
      analyzedBody.data.aiAnalysis!.summary,
    );

    // A browser cache populated online remains readable while the bridge is unavailable.
    await workspace.goto(`${BASE}/products`);
    await expect(
      workspace.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }),
    ).toBeVisible();
    await workspace.route(`${BASE}/api/products`, (route) => route.abort('connectionrefused'));
    await workspace.reload();
    await expect(workspace.locator('.error-notice')).toContainText('当前显示本机缓存');
    await expect(
      workspace.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }),
    ).toBeVisible();
    const duringWorkspaceOffline = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(duringWorkspaceOffline.data).toEqual(analyzedBody.data);
    await workspace.unroute(`${BASE}/api/products`);
    await workspace.getByRole('button', { name: '重试', exact: true }).click();
    await expect(workspace.locator('.error-notice')).toHaveCount(0);

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
    await amazon.evaluate(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      if (script?.textContent) script.textContent = script.textContent.replace('24.99', '19.99');
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('19.99 USD', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '尚未同步到工作台' })).toBeVisible();
    await amazon.evaluate(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      if (script?.textContent) script.textContent = script.textContent.replace('19.99', '18.99');
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('18.99 USD', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '尚未同步到工作台' })).toBeVisible();
    const pendingCount = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_PENDING_COUNT' }),
    );
    expect(pendingCount).toEqual({ status: 'pending-count', count: 1 });
    await popup.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(popup.getByText('1 件商品暂存在插件中，等待同步。')).toBeVisible();
    const stillSaved = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(stillSaved.data).toEqual(analyzedBody.data);

    const secondDraft: ProductDraft = {
      source: 'amazon',
      sourceId: SECOND_ASIN,
      url: `https://www.amazon.com/dp/${SECOND_ASIN}`,
      title: 'Pending Kitchen Bottle',
      images: [],
      videos: [],
      bulletPoints: ['A second isolated capture to verify partial synchronization'],
    };
    const secondPending = await popup.evaluate<ExtensionResponse, ProductDraft>(
      (draft) => chrome.runtime.sendMessage({ type: 'PRODUCTSPY_SAVE', draft }),
      secondDraft,
    );
    expect(secondPending.status).toBe('pending');
    const beforePartialSync = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_PENDING_COUNT' }),
    );
    expect(beforePartialSync).toEqual({ status: 'pending-count', count: 2 });
    await worker.evaluate(() => {
      const scoped = globalThis as typeof globalThis & { __originalFetch?: typeof fetch };
      const original = scoped.__originalFetch;
      if (!original) throw new Error('Original fetch was not preserved');
      scoped.fetch = async (input, init) => {
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        if (
          body &&
          typeof body === 'object' &&
          'sourceId' in body &&
          body.sourceId === 'B098765432'
        )
          throw new TypeError('simulated bridge failure for the second pending capture');
        return original(input, init);
      };
    });
    const partialSync = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_SYNC_PENDING' }),
    );
    expect(partialSync.status).toBe('error');
    const remainingPending = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_PENDING_COUNT' }),
    );
    expect(remainingPending).toEqual({ status: 'pending-count', count: 1 });
    const updatedAfterReconnect = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(updatedAfterReconnect.data.price).toBe('18.99');
    expect(updatedAfterReconnect.data.createdAt).toBe(firstBody.data.createdAt);
    expect(updatedAfterReconnect.data.updatedAt > analyzedBody.data.updatedAt).toBe(true);
    expect(updatedAfterReconnect.data.aiAnalysis).toBeUndefined();
    const uniqueAfterReconnect = (await (await api.get(`${BASE}/api/products`)).json()) as {
      data: Product[];
    };
    expect(uniqueAfterReconnect.data.filter((product) => product.id === ID)).toHaveLength(1);
    expect((await api.get(`${BASE}/api/products/${encodeURIComponent(SECOND_ID)}`)).status()).toBe(
      404,
    );
    await worker.evaluate(() => {
      const scoped = globalThis as typeof globalThis & { __originalFetch?: typeof fetch };
      if (scoped.__originalFetch) scoped.fetch = scoped.__originalFetch;
      delete scoped.__originalFetch;
    });
    const synchronized = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_SYNC_PENDING' }),
    );
    expect(synchronized).toEqual({ status: 'synced', count: 1 });
    const clearedPending = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_PENDING_COUNT' }),
    );
    expect(clearedPending).toEqual({ status: 'pending-count', count: 0 });
    const secondSaved = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(SECOND_ID)}`)
    ).json()) as { data: Product };
    expect(secondSaved.data.title).toBe(secondDraft.title);
    await api.delete(`${BASE}/api/products/${encodeURIComponent(SECOND_ID)}`);

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
    await api.delete(`${BASE}/api/products/${encodeURIComponent(ID)}`);
    await api.delete(`${BASE}/api/products/${encodeURIComponent(SECOND_ID)}`);
  }
});

test('the first action grants activeTab after activating a previously background product tab', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  const dist = resolve('apps/extension/dist');
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath('first-action-profile'),
    {
      channel: 'chromium',
      headless: true,
      args: [
        '--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
      ],
    },
  );
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const html = await readFile(
      resolve('apps/extension/tests/fixtures/jsonld-product.html'),
      'utf8',
    );
    await context.route('https://www.amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }),
    );
    const amazon = context.pages()[0];
    await amazon.goto(`https://www.amazon.com/dp/${ASIN}`);
    // Loading an inactive tab does not activate it. The action must follow the user's focus change.
    await amazon.bringToFront();
    const session = await context.browser()!.newBrowserCDPSession();
    const targets = await session.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }],
    });
    const target = targets.targetInfos.find((item: { url: string }) => item.url === amazon.url());
    if (!target) throw new Error('First-action Amazon test target missing');
    await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
    await session.detach();
    await expect
      .poll(() =>
        popup.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return tab?.url;
        }),
      )
      .toBe(amazon.url());
    const popupTab = await popup.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { id: tab?.id, url: tab?.url, windowId: tab?.windowId };
    });
    const workerTab = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return { id: tab?.id, url: tab?.url, windowId: tab?.windowId };
    });
    expect(workerTab).toEqual(popupTab);
    expect(workerTab.url).toBe(amazon.url());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const captured = await popup.evaluate<ExtensionResponse>(() =>
        chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
      );
      expect(captured.status).toBe('captured');
      if (captured.status !== 'captured') throw new Error('Expected a first-action capture');
      expect(captured.draft.sourceId).toBe(ASIN);
      expect(captured.draft.title).toBe('Portable Coffee Grinder');
    }
  } finally {
    await context.close();
  }
});

test('API rejects untrusted writes and unsupported media URLs', async ({ request }) => {
  const api = await authenticateWeb(request);
  const hostile = await request.post(`${BASE}/api/products`, {
    headers: { Origin: 'https://untrusted.example', 'X-ProductSpy-Client': 'web' },
    data: {},
  });
  expect(hostile.status()).toBe(403);
  const unsupported = await api.get(
    `${BASE}/api/media?url=${encodeURIComponent('https://127.0.0.1/private')}`,
  );
  expect(unsupported.status()).toBe(400);
  expect((await unsupported.json()).ok).toBe(false);
});

test('local API rejects anonymous reads, forged extension access and cross-site session bootstrap', async ({
  playwright,
}) => {
  const anonymous = await playwright.request.newContext();
  try {
    const read = await anonymous.get(`${BASE}/api/products`, { headers: WEB_HEADERS });
    expect([401, 403]).toContain(read.status());
    expect((await read.json()).ok).toBe(false);
    const forgedExtension = await anonymous.get(`${BASE}/api/products`, {
      headers: {
        Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'X-ProductSpy-Client': 'extension',
        Authorization: 'Bearer forged-productspy-credential',
      },
    });
    expect([401, 403]).toContain(forgedExtension.status());
    expect((await forgedExtension.json()).ok).toBe(false);
    const crossSiteSession = await anonymous.post(`${BASE}/api/session`, {
      headers: { ...WEB_HEADERS, 'Sec-Fetch-Site': 'cross-site' },
      data: {},
    });
    expect(crossSiteSession.status()).toBe(403);
    expect((await crossSiteSession.json()).ok).toBe(false);
    const afterRejectedSession = await anonymous.get(`${BASE}/api/products`, {
      headers: WEB_HEADERS,
    });
    expect([401, 403]).toContain(afterRejectedSession.status());
  } finally {
    await anonymous.dispose();
  }
});
