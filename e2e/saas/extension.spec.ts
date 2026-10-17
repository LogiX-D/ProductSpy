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
import { randomUUID } from 'node:crypto';

const BASE = 'http://127.0.0.1:3100';
const ASIN = 'B012345678';
const PASSWORD = 'Synthetic-test-password-2026!';

async function register(page: Page, email: string, name: string) {
  await page.goto(`${BASE}/register`);
  await page.getByLabel('姓名', { exact: true }).fill(name);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

async function login(page: Page, email: string) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);
}

async function openCapture(context: BrowserContext, worker: Worker, amazon: Page): Promise<Page> {
  const id = new URL(worker.url()).hostname;
  await amazon.bringToFront();
  const cdp = await context.browser()!.newBrowserCDPSession();
  const targets = await cdp.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item: { url: string }) => item.url === amazon.url());
  if (!target) throw new Error('Fixture Amazon tab was not found');
  // Grant real activeTab via the installed MV3 action. The capture UI below is an extension tab.
  await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await cdp.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await amazon.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
  await expect(
    popup.getByRole('heading', { name: 'Portable Coffee Grinder', exact: true }),
  ).toBeVisible();
  return popup;
}

test('real MV3 + Amazon HTML fixture + real SaaS HTTP → saved Mock AI → isolated browser sessions and offline recovery', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const dist = resolve('apps/extension/dist-saas-e2e');
  const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.host_permissions).toEqual([`${BASE}/*`]);
  expect(manifest.permissions).toContain('alarms');
  const context = await chromium.launchPersistentContext(testInfo.outputPath('extension-profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
    ],
    viewport: { width: 1360, height: 950 },
  });
  const second = await browser.newContext();
  const other = await browser.newContext();
  const email = `mv3-${randomUUID()}@example.test`;
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 45000 }));
    const extensionId = new URL(worker.url()).hostname;
    const web = context.pages()[0];
    await register(web, email, 'Extension Fixture Owner');
    await web.goto(`${BASE}/settings?extensionId=${extensionId}`);
    const dialog = web.getByRole('dialog');
    await expect(dialog.getByLabel('Chrome 扩展 ID', { exact: true })).toHaveValue(extensionId);
    await dialog.getByRole('button', { name: '生成配对码', exact: true }).click();
    const code = await dialog.getByLabel('扩展配对码', { exact: true }).inputValue();
    expect(code).toMatch(/^[a-f0-9]{32}$/);

    const html = await readFile(
      resolve('apps/extension/tests/fixtures/jsonld-product.html'),
      'utf8',
    );
    await context.route('https://www.amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }),
    );
    await context.route('https://m.media-amazon.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="gray"/></svg>',
      }),
    );
    await context.route('https://media.example.com/**', (route) => route.abort());
    const amazon = await context.newPage();
    await amazon.goto(`https://www.amazon.com/dp/${ASIN}`);
    const popup = await openCapture(context, worker, amazon);
    await popup.locator('.connection-panel > summary').click();
    await popup.getByLabel('一次性登录授权码', { exact: true }).fill(code);
    await popup.getByRole('button', { name: '登录插件', exact: true }).click();
    await expect(popup.getByText(`当前账号：${email}`, { exact: true })).toBeVisible();
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
    await popup.screenshot({ path: testInfo.outputPath('saas-extension-captured.png') });

    await web.goto(`${BASE}/products`);
    await web.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }).click();
    await web.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await web.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(web.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    await expect(web.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
    const productUrl = web.url();
    await web.screenshot({ path: testInfo.outputPath('saas-saved-mock-analysis.png') });

    const another = await second.newPage();
    await login(another, email);
    await another.goto(productUrl);
    await another.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await expect(another.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    await expect(another.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
    const stranger = await other.newPage();
    await register(stranger, `other-${randomUUID()}@example.test`, 'Other Account');
    await stranger.goto(`${BASE}/products`);
    await expect(
      stranger.getByRole('link', { name: 'Portable Coffee Grinder', exact: true }),
    ).toHaveCount(0);
    const isolated = await other.request.get(productUrl.replace('/products/', '/api/products/'), {
      headers: { 'X-ProductSpy-Client': 'web' },
    });
    expect(isolated.status()).toBe(404);

    // Disconnect actual browser networking, preserve the extension's persisted queue, then restore HTTP.
    await amazon.evaluate(() => {
      document.querySelector('#productTitle')!.textContent = 'Offline Updated Grinder';
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(
      popup.getByRole('heading', { name: 'Offline Updated Grinder', exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByText('1 件商品待同步', { exact: true })).toBeVisible();
    await context.setOffline(false);
    await popup.getByRole('button', { name: '重试同步', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已同步 1 件商品' })).toBeVisible();
    await another.goto(`${BASE}/products`);
    await expect(
      another.getByRole('link', { name: 'Offline Updated Grinder', exact: true }),
    ).toBeVisible();
    await testInfo.attach('verification-scope', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify(
          {
            extension: 'actual loaded MV3',
            collection: 'Amazon HTML fixture, not live Amazon',
            network: 'real HTTP to local SaaS backend',
            ai: 'Mock, no external provider',
            sessions: 'two isolated browser contexts, not two physical devices',
            payment: 'not exercised',
            production: 'not deployed',
          },
          null,
          2,
        ),
      ),
    });
  } finally {
    await context.setOffline(false);
    await context.close();
    await second.close();
    await other.close();
  }
});
