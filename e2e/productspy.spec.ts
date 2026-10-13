import {
  test,
  expect,
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
  type APIRequestContext,
} from './test-fixtures';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import JSZip from '../apps/web/node_modules/jszip';
import type { Product, ProductDraft } from '../packages/shared/src/types';
import {
  builtinTemplates,
  templateDefinition,
  type AITemplate,
} from '../packages/shared/src/templates';
import type { ContentPlan, ContentMetadata } from '../packages/shared/src/content';
import { DEFAULT_ANALYSIS_OPTIONS } from '../packages/shared/src/schema';
import type {
  ComparisonPlan,
  ComparisonGenerationResponse,
} from '../packages/shared/src/comparison';
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
async function workspaceOperation<T>(
  request: APIRequestContext,
  path: string,
  value?: unknown,
  method = value === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request.fetch(`${BASE}${path}`, {
    method,
    headers: WEB_HEADERS,
    ...(value === undefined ? {} : { data: value }),
  });
  const body = (await response.json()) as { data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  return body.data;
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
  await popup.setViewportSize({ width: 400, height: 600 });
  await expect(popup.getByRole('button', { name: '同意并开始采集', exact: true })).toBeVisible();
  await expect(popup.getByText('商品已采集')).toHaveCount(0);
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
  return popup;
}

test('production extension fixture → capture → save → workspace → Mock AI → template → content → export → persistence and recovery', async ({
  request,
}, testInfo) => {
  // This full chain now exercises 200+ actions across all core modules, followed
  // by the existing offline queue and pairing recovery checks. Individual action
  // limits remain unchanged; do not drop recovery assertions to fit the old total.
  test.setTimeout(180000);
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
  let integrationTemplate: AITemplate | undefined;
  let integrationContent: ContentPlan | undefined;
  let integrationComparison: ComparisonPlan | undefined;
  let integrationPeerId: string | undefined;
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  try {
    // MV3 startup can exceed the 15s action limit under Windows disk/build load.
    // Keep a separate bounded startup wait; capture/save assertions remain unchanged.
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 45000 }));
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
    await expect(popup.getByText('商品已采集')).toBeVisible();
    await expect(popup.getByRole('heading', { name: 'Portable Coffee Grinder' })).toBeVisible();
    await expect(popup.getByText(ASIN, { exact: true })).toBeVisible();
    const pairingResponse = await request.post(`${BASE}/api/bridge/code`, {
      headers: WEB_HEADERS,
      data: {},
    });
    expect(pairingResponse.ok()).toBe(true);
    const pairingBody = (await pairingResponse.json()) as { data: { code: string } };
    if (!(await popup.getByLabel('工作台配对码').isVisible()))
      await popup.locator('.connection-panel > summary').click();
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
    await workspace.getByRole('searchbox', { name: '搜索商品' }).fill('no match in fixture');
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
    await workspace.getByRole('tab', { name: /^素材/ }).click();
    await expect(workspace.getByRole('button', { name: /^下载图片 \d+$/ })).toHaveCount(2);
    // Browser download handling is tested with deterministic image bytes; CDN policy is unit-tested separately.
    await context.route(`${BASE}/api/media?**`, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    // Headless browser cannot display a system save dialog. Explicit fallback acknowledgement
    // covers browser download handling; Windows directory picker is a separate manual gate.
    await context.addInitScript(() =>
      Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }),
    );
    await workspace.reload();
    await workspace.getByRole('tab', { name: /^素材/ }).click();
    await workspace.getByRole('checkbox', { name: /我的浏览器已开启/ }).check();
    const singleDownload = workspace.waitForEvent('download');
    await workspace
      .getByRole('button', { name: /^下载图片 \d+$/ })
      .first()
      .click();
    const image = await singleDownload;
    expect(image.suggestedFilename()).toBe(`Portable Coffee Grinder-${ASIN}-图片-01.png`);
    await image.saveAs(testInfo.outputPath(image.suggestedFilename()));
    const zipDownload = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '下载全部图片（ZIP）', exact: true }).click();
    const archive = await zipDownload;
    expect(archive.suggestedFilename()).toBe(`Portable Coffee Grinder-${ASIN}-图片-素材.zip`);
    const zipPath = testInfo.outputPath(archive.suggestedFilename());
    await archive.saveAs(zipPath);
    expect((await readFile(zipPath)).subarray(0, 2).toString()).toBe('PK');

    await workspace.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await expect(workspace.getByText('本机演示', { exact: true })).toBeVisible();
    await workspace.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(workspace.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    for (const heading of [
      '核心卖点',
      '用户痛点',
      '目标用户',
      '商品优势',
      '不足与待验证',
      '营销角度',
      '开场文案',
      '短视频脚本',
      '图片提示词',
      '视频提示词',
    ]) {
      await expect(workspace.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    }
    const hookRows = workspace.locator('#analysis-hooks .analysis-insights li');
    expect(await hookRows.count()).toBeGreaterThanOrEqual(5);
    expect(await workspace.locator('.analysis-script-step h3').allTextContents()).toEqual([
      '开场吸引',
      '提出问题',
      '提供方案',
      '产品演示',
      '行动引导',
    ]);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
    await hookRows.first().getByRole('button').click();
    await expect(hookRows.first().getByRole('button')).toHaveText('已复制');
    await workspace.reload();
    await expect(workspace.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    const analyzedBody = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(analyzedBody.data.aiAnalysis?.hooks.length).toBeGreaterThanOrEqual(5);
    await workspace.screenshot({ path: testInfo.outputPath('analysis.png'), fullPage: true });

    // This is a real production MV3/workspace integration driven by retained HTML and media
    // fixtures, not evidence of access to a live Amazon page or real-model content quality.
    const peer = await workspaceOperation<Product>(request, '/api/products', {
      source: 'amazon',
      sourceId: 'B019CMP001',
      url: 'https://www.amazon.com/dp/B019CMP001',
      title: 'Phase19 合成比较商品，非真实 Amazon 验收',
      images: [],
      videos: [],
      bulletPoints: ['合成对比流程样本'],
    });
    integrationPeerId = peer.id;
    integrationComparison = await workspaceOperation<ComparisonPlan>(request, '/api/comparisons', {
      name: 'Phase19 MV3 来源对比（Fixture）',
      productIds: [ID, peer.id],
    });
    const comparisonGeneration = await workspaceOperation<ComparisonGenerationResponse>(
      request,
      '/api/analyze-comparison',
      {
        comparisonId: integrationComparison.id,
        expectedUpdatedAt: integrationComparison.updatedAt,
        options: DEFAULT_ANALYSIS_OPTIONS,
        requestId: randomUUID(),
      },
    );
    integrationComparison = comparisonGeneration.plan;
    expect(comparisonGeneration.metadata.mode).toBe('mock');
    expect(comparisonGeneration.metadata.evidence.reviewTextAnalyzed).toBe(false);
    integrationTemplate = await workspaceOperation<AITemplate>(request, '/api/templates', {
      ...templateDefinition(builtinTemplates[0]),
      name: 'Phase19 MV3 营销模板（Fixture）',
    });
    await workspace.getByRole('link', { name: '选择 AI 模板', exact: true }).click();
    await expect(workspace).toHaveURL(new RegExp(`/templates\\?product=${encodeURIComponent(ID)}`));
    const selectedTemplate = workspace
      .locator('article')
      .filter({ hasText: integrationTemplate.name });
    await selectedTemplate.getByRole('link', { name: '用于创作', exact: true }).click();
    await expect(workspace.getByLabel('创作商品')).toHaveValue(ID);
    await expect(workspace.getByLabel('创作模板')).toHaveValue(integrationTemplate.id);
    await expect(workspace.getByText(/已保存商品分析将作为带来源的既有推断引用/)).toBeVisible();
    await workspace.getByLabel('引用竞品分析').selectOption(integrationComparison.id);
    await workspace.getByLabel('方案名称').fill('Phase19 MV3 完整流程营销方案（Fixture）');
    await workspace.getByRole('button', { name: '创建方案', exact: true }).click();
    await expect(workspace.getByRole('button', { name: '生成内容', exact: true })).toBeVisible();
    const beforeGeneration = await workspaceOperation<{ plans: ContentPlan[] }>(
      request,
      '/api/content-plans',
    );
    integrationContent = beforeGeneration.plans.find(
      (item) => item.name === 'Phase19 MV3 完整流程营销方案（Fixture）',
    );
    expect(integrationContent).toBeTruthy();
    expect(integrationContent!.productId).toBe(ID);
    expect(integrationContent!.productSnapshot.sourceId).toBe(ASIN);
    expect(integrationContent!.productSnapshot.aiAnalysis).toEqual(analyzedBody.data.aiAnalysis);
    expect(integrationContent!.comparisonSource?.id).toBe(integrationComparison.id);
    await workspace.getByRole('button', { name: '生成内容', exact: true }).click();
    await expect(
      workspace.getByRole('heading', { name: '当前采用内容', exact: true }),
    ).toBeVisible();
    integrationContent = await workspaceOperation<ContentPlan>(
      request,
      `/api/content-plans/${integrationContent!.id}`,
    );
    const version = integrationContent.versions.find(
      (item) => item.id === integrationContent?.currentVersionId,
    );
    expect(integrationContent.versions).toHaveLength(1);
    expect(version?.metadata?.mode).toBe('mock');
    expect(version?.metadata?.evidence.reviewTextAnalyzed).toBe(false);
    expect(version?.metadata?.productAnalysisReference).toMatchObject({
      productId: ID,
      asin: ASIN,
      versionId: analyzedBody.data.analysisHistory!.at(-1)!.id,
      mode: 'mock',
      classification: 'saved-analysis-unverified',
    });
    await expect(
      workspace
        .getByRole('region', { name: '内容来源与更新状态' })
        .getByText('商品分析', { exact: true }),
    ).toBeVisible();
    const contentArchiveDownload = workspace.waitForEvent('download');
    await workspace.getByRole('button', { name: '导出内容包 ZIP', exact: true }).click();
    const contentArchive = await contentArchiveDownload;
    expect(contentArchive.suggestedFilename()).toMatch(new RegExp(`${ASIN}.*\\.zip$`));
    const contentArchivePath = testInfo.outputPath(contentArchive.suggestedFilename());
    await contentArchive.saveAs(contentArchivePath);
    const contentZip = await JSZip.loadAsync(await readFile(contentArchivePath), {
      checkCRC32: true,
    });
    const contentFiles = Object.keys(contentZip.files).filter(
      (name) => !contentZip.files[name].dir,
    );
    expect(contentFiles.some((name) => name.endsWith('.md'))).toBe(true);
    expect(contentFiles.some((name) => name.endsWith('.txt'))).toBe(true);
    expect(contentFiles.some((name) => /\.(?:png|jpe?g|webp|mp4|webm|m3u8)$/i.test(name))).toBe(
      false,
    );
    for (const name of contentFiles) expect(name).not.toMatch(/(?:^|\/)\.\.|[\\:]/);
    const exportedJson = contentFiles.find((name) => name.endsWith('.json'));
    expect(exportedJson).toBeTruthy();
    const exported = JSON.parse(await contentZip.file(exportedJson!)!.async('string')) as {
      product: Product;
      metadata: ContentMetadata;
      comparisonSource: ComparisonPlan;
      template: AITemplate;
      versionId: string;
    };
    expect(exported.product.id).toBe(ID);
    expect(exported.product.sourceId).toBe(ASIN);
    expect(exported.product.aiAnalysis).toEqual(analyzedBody.data.aiAnalysis);
    expect(exported.template.id).toBe(integrationTemplate.id);
    expect(exported.comparisonSource.id).toBe(integrationComparison.id);
    expect(exported.versionId).toBe(integrationContent.currentVersionId);
    expect(exported.metadata.productAnalysisReference).toEqual(
      version!.metadata!.productAnalysisReference,
    );
    await workspace.reload();
    await expect(
      workspace.getByRole('heading', { name: '当前采用内容', exact: true }),
    ).toBeVisible();
    const reloadedContent = await workspaceOperation<ContentPlan>(
      request,
      `/api/content-plans/${integrationContent.id}`,
    );
    expect(reloadedContent).toEqual(integrationContent);
    await workspace.screenshot({
      path: testInfo.outputPath('integrated-content-fixture.png'),
      fullPage: true,
    });
    // Remove the extra live product before the original offline/recovery and empty-library
    // assertions. Its preserved comparison/content snapshots remain separate until cleanup.
    await api.delete(`${BASE}/api/products/${encodeURIComponent(peer.id)}`);
    integrationPeerId = undefined;
    await workspace.goto(`${BASE}/products/${encodeURIComponent(ID)}?tab=analysis`);
    await expect(workspace.locator('#analysis-summary')).toContainText(
      analyzedBody.data.aiAnalysis!.summary,
    );

    // Inject a transport failure only; the previously saved analysis must remain durable.
    const failedAnalysisMessage = '验收模拟：AI 服务暂时不可用';
    await workspace.route(`${BASE}/api/analyze-product`, (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: failedAnalysisMessage }),
      }),
    );
    await workspace.getByRole('button', { name: '重新生成分析', exact: true }).click();
    await workspace.getByRole('button', { name: '确认重新生成', exact: true }).click();
    await expect(workspace.locator('.error-notice')).toContainText(failedAnalysisMessage);
    await expect(workspace.locator('#analysis-summary')).toContainText(
      analyzedBody.data.aiAnalysis!.summary,
    );
    const afterFailedAnalysis = (await (
      await api.get(`${BASE}/api/products/${encodeURIComponent(ID)}`)
    ).json()) as { data: Product };
    expect(afterFailedAnalysis.data).toEqual(analyzedBody.data);
    await workspace.unroute(`${BASE}/api/analyze-product`);
    await workspace.reload();
    await expect(workspace.locator('#analysis-summary')).toContainText(
      analyzedBody.data.aiAnalysis!.summary,
    );

    // A browser cache populated online remains readable while the bridge is unavailable.
    await workspace.goto(`${BASE}/products`);
    await expect(
      workspace.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }),
    ).toBeVisible();
    await workspace.route(`${BASE}/api/products`, (route) => route.abort('connectionrefused'));
    await workspace.route(`${BASE}/api/library`, (route) => route.abort('connectionrefused'));
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
    await workspace.unroute(`${BASE}/api/library`);
    await workspace.getByRole('button', { name: '重试', exact: true }).click();
    await expect(workspace.locator('.error-notice')).toHaveCount(0);

    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('商品已采集')).toBeVisible();
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
    await expect(popup.getByRole('status').filter({ hasText: '已暂存在扩展中' })).toBeVisible();
    await amazon.evaluate(() => {
      const script = document.querySelector('script[type="application/ld+json"]');
      if (script?.textContent) script.textContent = script.textContent.replace('19.99', '18.99');
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(popup.getByText('18.99 USD', { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已暂存在扩展中' })).toBeVisible();
    const pendingCount = await popup.evaluate<ExtensionResponse>(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_PENDING_COUNT' }),
    );
    expect(pendingCount).toEqual({ status: 'pending-count', count: 1 });
    await popup.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(popup.getByText('1 件商品待同步', { exact: true })).toBeVisible();
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
    await expect(popup.getByRole('heading', { name: '请打开 Amazon 商品详情页' })).toBeVisible();
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
    if (integrationContent) {
      const current = await workspaceOperation<ContentPlan>(
        request,
        `/api/content-plans/${integrationContent.id}`,
      );
      await workspaceOperation(
        request,
        `/api/content-plans/${current.id}`,
        { confirmed: true, expectedUpdatedAt: current.updatedAt },
        'DELETE',
      );
    }
    if (integrationComparison) {
      const current = await workspaceOperation<ComparisonPlan>(
        request,
        `/api/comparisons/${integrationComparison.id}`,
      );
      await workspaceOperation(
        request,
        `/api/comparisons/${current.id}`,
        { confirmed: true, expectedUpdatedAt: current.updatedAt },
        'DELETE',
      );
    }
    if (integrationTemplate)
      await workspaceOperation(
        request,
        `/api/templates/${integrationTemplate.id}`,
        { confirmed: true, expectedUpdatedAt: integrationTemplate.updatedAt },
        'DELETE',
      );
    if (integrationPeerId)
      await api.delete(`${BASE}/api/products/${encodeURIComponent(integrationPeerId)}`);
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
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 45000 }));
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
  const anonymous = await playwright.request.newContext({
    storageState: { cookies: [], origins: [] },
  });
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

test('empty workspace explains portable installation and expired pairing can recover', async ({
  page,
}) => {
  // This is a UI fixture, separate from the real Amazon acceptance and store images.
  await page.route(`${BASE}/api/products`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: [] }),
    }),
  );
  await page.route(`${BASE}/api/library`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { products: [], groups: [], tags: [] } }),
    }),
  );
  await page.clock.install();
  await page.goto(`${BASE}/products`);
  await expect(page.getByRole('heading', { name: '还没有采集商品', exact: true })).toBeVisible();
  const setup = page.getByRole('button', { name: '开始首次使用', exact: true });
  await setup.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('ol > li')).toHaveCount(4);
  await dialog.locator('.ws-guide-more > summary').click();
  await expect(dialog.getByText(/ProductSpy.cmd/)).toBeVisible();
  await dialog.getByRole('button', { name: '开发者源码版', exact: true }).click();
  await expect(dialog.getByText('apps/extension/dist', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Windows 便携版', exact: true }).click();
  await dialog.getByRole('button', { name: '生成配对码', exact: true }).click();
  await expect(dialog.getByLabel('扩展配对码')).toHaveValue(/^[a-f0-9]{32}$/);
  await page.clock.fastForward('02:10');
  await expect(dialog.getByText(/配对码已过期。/)).toBeVisible();
  await expect(dialog.getByLabel('扩展配对码')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '生成配对码', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(setup).toBeFocused();
});

test('analysis editing preserves drafts, validates hooks and rejects concurrent overwrites', async ({
  page,
  request,
}) => {
  const api = await authenticateWeb(request);
  const draft: ProductDraft = {
    source: 'amazon',
    sourceId: 'B011EDIT01',
    url: 'https://www.amazon.com/dp/B011EDIT01',
    title: '分析编辑回归商品',
    images: [],
    videos: [],
    bulletPoints: ['便携设计'],
  };
  const id = `amazon:${draft.sourceId}`;
  const endpoint = `${BASE}/api/products/${encodeURIComponent(id)}`;
  await api.delete(endpoint);
  try {
    const saved = await request.post(`${BASE}/api/products`, { headers: WEB_HEADERS, data: draft });
    expect(saved.ok()).toBe(true);
    const original = ((await saved.json()) as { data: Product }).data;
    const analyzed = await request.post(`${BASE}/api/analyze-product`, {
      headers: WEB_HEADERS,
      data: original,
    });
    expect(analyzed.ok()).toBe(true);
    await page.goto(`${BASE}/products/${encodeURIComponent(id)}?tab=analysis`);
    await page.getByRole('button', { name: '编辑分析', exact: true }).click();
    const summary = page.getByLabel('商品总结', { exact: true });
    await summary.fill('修改后的总结\n第二行保留');
    await page.getByRole('tab', { name: '概览', exact: true }).click();
    await page.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await expect(summary).toHaveValue('修改后的总结\n第二行保留');
    page.on('dialog', (dialog) => void dialog.accept());
    await page.reload();
    await page.getByRole('button', { name: '恢复草稿', exact: true }).click();
    await expect(summary).toHaveValue('修改后的总结\n第二行保留');
    const hooks = page.locator('#analysis-hooks textarea');
    while ((await hooks.count()) > 4)
      await page
        .locator('#analysis-hooks')
        .getByRole('button', { name: /^移除条目/ })
        .last()
        .click();
    await page.getByRole('button', { name: '保存分析', exact: true }).click();
    await expect(
      page.getByText('开场文案需填写 5 至 30 个非空条目，每项最多 12,000 字。', { exact: true }),
    ).toBeVisible();
    const unchanged = ((await (await api.get(endpoint)).json()) as { data: Product }).data;
    expect(unchanged.aiAnalysis?.summary).not.toContain('修改后的总结');
    await page
      .locator('#analysis-hooks')
      .getByRole('button', { name: '添加条目', exact: true })
      .click();
    await hooks.last().fill('第五条开场文案\n保留换行');
    await page.getByLabel('开场吸引', { exact: true }).fill('新脚本开场\n第二行');
    await page.getByRole('button', { name: '保存分析', exact: true }).click();
    await expect(page.getByText('分析已保存。', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('#analysis-summary')).toContainText('修改后的总结\n第二行保留');
    await expect(
      page.locator('.analysis-title-line').getByText('本机演示', { exact: true }),
    ).toBeVisible();
    const edited = ((await (await api.get(endpoint)).json()) as { data: Product }).data;
    expect(edited.aiAnalysis?.hooks).toHaveLength(5);
    expect(edited.aiAnalysis?.shortVideoScript).toContain('Hook: 新脚本开场\n第二行');
    expect(edited.aiAnalysis?.summary).toMatch(/^Mock 演示分析/);
    await page.getByRole('button', { name: '编辑分析', exact: true }).click();
    await summary.fill('本页未保存的并发草稿');
    const concurrent = { ...edited.aiAnalysis!, summary: 'Mock 演示分析：另一页面的新版本' };
    const external = await request.patch(endpoint, {
      headers: WEB_HEADERS,
      data: { analysis: concurrent, expectedUpdatedAt: edited.updatedAt },
    });
    expect(external.ok()).toBe(true);
    await page.getByRole('button', { name: '保存分析', exact: true }).click();
    await expect(page.getByText(/保存冲突：商品或分析已在其他页面更新/)).toBeVisible();
    await expect(summary).toHaveValue('本页未保存的并发草稿');
    const afterConflict = ((await (await api.get(endpoint)).json()) as { data: Product }).data;
    expect(afterConflict.aiAnalysis).toEqual(concurrent);
    await page.getByRole('button', { name: '关闭编辑', exact: true }).click();
    await page.getByRole('button', { name: '保留草稿并关闭', exact: true }).click();
    await expect(page.getByRole('button', { name: '恢复草稿', exact: true })).toBeVisible();
  } finally {
    await api.delete(endpoint);
  }
});

test('library preferences, keyboard tabs, mobile layouts and manual copy remain usable', async ({
  page,
  request,
}) => {
  const api = await authenticateWeb(request);
  const draft: ProductDraft = {
    source: 'amazon',
    sourceId: 'B011UX0001',
    url: 'https://www.amazon.com/dp/B011UX0001',
    title: '移动界面回归商品',
    brand: 'ProductSpy 回归品牌',
    images: [],
    videos: [],
    bulletPoints: [],
  };
  const endpoint = `${BASE}/api/products/${encodeURIComponent(`amazon:${draft.sourceId}`)}`;
  await api.delete(endpoint);
  try {
    expect(
      (await request.post(`${BASE}/api/products`, { headers: WEB_HEADERS, data: draft })).ok(),
    ).toBe(true);
    await page.goto(`${BASE}/products`);
    await page.getByRole('searchbox', { name: '搜索商品' }).fill('回归品牌');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    await page.getByRole('combobox', { name: '筛选分析状态' }).selectOption('pending');
    await page.getByRole('combobox', { name: '商品排序' }).selectOption('collected-asc');
    await page.reload();
    await expect(page.getByRole('searchbox', { name: '搜索商品' })).toHaveValue('回归品牌');
    await expect(page.getByRole('button', { name: '列表视图' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('combobox', { name: '筛选分析状态' })).toHaveValue('pending');
    await expect(page.getByRole('combobox', { name: '商品排序' })).toHaveValue('collected-asc');
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      await expect(page.getByRole('link', { name: draft.title, exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      ).toBe(true);
    }
    await page.getByRole('link', { name: `打开商品 ${draft.title}`, exact: true }).click();
    await page.getByRole('tab', { name: '概览', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: /^素材/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'AI 分析', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(page.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: () => Promise.reject(new Error('regression denied clipboard')),
      }),
    );
    await page.getByRole('button', { name: /^复制全部文本/ }).click();
    const manual = page.getByLabel('手动复制内容');
    await expect(manual).toBeVisible();
    expect(await manual.inputValue()).toContain('短视频脚本');
    expect(await manual.inputValue()).toContain('商品总结');
    await page.getByRole('button', { name: '编辑分析', exact: true }).click();
    await expect(page.getByLabel('商品总结', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  } finally {
    await api.delete(endpoint);
  }
});
