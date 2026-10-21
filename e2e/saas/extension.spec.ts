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

async function openCapture(
  context: BrowserContext,
  worker: Worker,
  amazon: Page,
  needsConsent = true,
): Promise<Page> {
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
  if (needsConsent)
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
  const launch = () =>
    chromium.launchPersistentContext(testInfo.outputPath('extension-profile'), {
      channel: 'chromium',
      headless: true,
      args: [
        '--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
      ],
      viewport: { width: 1360, height: 950 },
    });
  let context = await launch();
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
    await expect(popup.getByText(`当前账号：${email}`, { exact: true })).toBeVisible();
    await expect(popup.getByLabel('一次性登录授权码', { exact: true })).toHaveCount(0);
    expect(
      await worker.evaluate(async () => {
        const key = 'productspy.cloud-session.v1';
        return {
          memory: Boolean((await chrome.storage.session.get(key))[key]),
          disk: Boolean((await chrome.storage.local.get(key))[key]),
        };
      }),
    ).toEqual({ memory: true, disk: false });
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

    // Browser restart clears only the in-memory credential. Keep the same real
    // profile/outbox, reauthorize, and recover the original idempotency key.
    await amazon.evaluate(() => {
      document.querySelector('#productTitle')!.textContent = 'Restart Pending Grinder';
    });
    await amazon.bringToFront();
    await popup.reload();
    await expect(
      popup.getByRole('heading', { name: 'Restart Pending Grinder', exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByText('1 件商品待同步', { exact: true })).toBeVisible();
    const pending = await worker.evaluate(async () => {
      const value = (await chrome.storage.session.get('productspy.cloud-session.v1'))[
        'productspy.cloud-session.v1'
      ] as { user: { id: string } };
      const queueKey = `productspy.cloud-queue.v1.user.${encodeURIComponent(value.user.id)}`;
      const data = (await chrome.storage.local.get(queueKey))[queueKey] as {
        pending: Record<string, { captureId: string }>;
      };
      return { queueKey, captureId: Object.values(data.pending)[0].captureId };
    });
    // Also remove the website cookie, so startup cannot automatically reconnect
    // before the persisted outbox/cleared-memory boundary has been observed.
    await context.clearCookies();
    await context.close();
    context = await launch();
    const restartedWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 45000 }));
    expect(new URL(restartedWorker.url()).hostname).toBe(extensionId);
    expect(
      await restartedWorker.evaluate(async ({ queueKey }) => {
        const key = 'productspy.cloud-session.v1';
        const data = (await chrome.storage.local.get(queueKey))[queueKey] as {
          pending: Record<string, { captureId: string }>;
        };
        return {
          memory: Boolean((await chrome.storage.session.get(key))[key]),
          disk: Boolean((await chrome.storage.local.get(key))[key]),
          captureIds: Object.values(data.pending).map((item) => item.captureId),
        };
      }, pending),
    ).toEqual({ memory: false, disk: false, captureIds: [pending.captureId] });
    await context.route('https://www.amazon.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: html }),
    );
    await context.route('https://m.media-amazon.com/**', (route) => route.abort());
    await context.route('https://media.example.com/**', (route) => route.abort());
    const restartedWeb = context.pages()[0];
    await login(restartedWeb, email);
    const restartedAmazon = await context.newPage();
    await restartedAmazon.goto(`https://www.amazon.com/dp/${ASIN}`);
    const uploadedIds: string[] = [];
    context.on('request', (request) => {
      if (request.url() === `${BASE}/api/products` && request.method() === 'POST')
        uploadedIds.push(request.headers()['idempotency-key']);
    });
    const restartedPopup = await openCapture(context, restartedWorker, restartedAmazon, false);
    await restartedPopup.locator('.connection-panel > summary').click();
    await expect(restartedPopup.getByText(`当前账号：${email}`, { exact: true })).toBeVisible();
    await expect.poll(() => uploadedIds).toEqual([pending.captureId]);
    await expect
      .poll(() =>
        restartedWorker.evaluate(async (queueKey) => {
          const data = (await chrome.storage.local.get(queueKey))[queueKey] as {
            pending: Record<string, unknown>;
          };
          return Object.keys(data.pending).length;
        }, pending.queueKey),
      )
      .toBe(0);
    await another.goto(`${BASE}/products`);
    await expect(
      another.getByRole('link', { name: 'Restart Pending Grinder', exact: true }),
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
            credentialStorage:
              'actual session memory; browser restart with website cookie removed clears auth; logging into the website automatically restores the original outbox',
            payment: 'not exercised',
            production: 'not deployed',
          },
          null,
          2,
        ),
      ),
    });
  } finally {
    await context.setOffline(false).catch(() => undefined);
    await context.close();
    await second.close();
    await other.close();
  }
});
