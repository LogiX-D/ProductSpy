import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PRODUCTSPY_EXTENSION_ID } from '../../packages/shared/src/extension-identity';

const base = 'http://127.0.0.1:3100';
const password = 'Synthetic-account-switch-2026!';
async function register(page: Page, email: string) {
  await page.goto(`${base}/register`);
  await page.getByLabel('姓名', { exact: true }).fill('Automatic connection test');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page).toHaveURL(`${base}/`);
}
async function popup(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${PRODUCTSPY_EXTENSION_ID}/popup.html`);
  const consent = page.getByRole('button', { name: '同意并开始采集', exact: true });
  await expect(consent.or(page.locator('.connection-panel > summary'))).toBeVisible();
  if (await consent.isVisible()) await consent.click();
  await page.locator('.connection-panel > summary').click();
  return page;
}
async function reopen(page: Page) {
  await page.reload();
  await page.locator('.connection-panel > summary').click();
}
test('actual MV3 automatically follows the website account, reconnects after restart, and clears stale identity after cookie loss', async ({
  browserName,
}, info) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(120000);
  const dist = resolve('apps/extension/dist-saas-e2e');
  const launch = () =>
    chromium.launchPersistentContext(info.outputPath('profile'), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    });
  let context = await launch();
  const alice = `automatic-a-${randomUUID()}@example.test`;
  const bob = `automatic-b-${randomUUID()}@example.test`;
  try {
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(new URL(worker.url()).hostname).toBe(PRODUCTSPY_EXTENSION_ID);
    const web = context.pages()[0];
    let panel = await popup(context);
    await expect(panel.getByText(/当前账号：/)).toHaveCount(0);
    await expect(panel.getByLabel('一次性登录授权码', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('Chrome 扩展 ID', { exact: true })).toHaveCount(0);
    await register(web, alice);
    await reopen(panel);
    await expect(panel.getByText(`当前账号：${alice}`, { exact: true })).toBeVisible();
    await register(web, bob);
    await reopen(panel);
    await expect(panel.getByText(`当前账号：${bob}`, { exact: true })).toBeVisible();
    await expect(panel.getByText(`当前账号：${alice}`, { exact: true })).toHaveCount(0);
    await worker.evaluate(async () =>
      chrome.storage.session.set({ 'productspy.e2e.memory-marker': true }),
    );
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    expect(
      await worker.evaluate(async () =>
        Boolean(
          (await chrome.storage.session.get('productspy.e2e.memory-marker'))[
            'productspy.e2e.memory-marker'
          ],
        ),
      ),
    ).toBe(false);
    panel = await popup(context);
    // Existing persistent website login reconnects without any copied code or ID.
    await expect(panel.getByText(`当前账号：${bob}`, { exact: true })).toBeVisible();
    await context.clearCookies();
    await reopen(panel);
    await expect(panel.getByText(`当前账号：${bob}`, { exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        worker.evaluate(async () =>
          Boolean(
            (await chrome.storage.session.get('productspy.cloud-session.v1'))[
              'productspy.cloud-session.v1'
            ],
          ),
        ),
      )
      .toBe(false);
    expect(
      await worker.evaluate(async () =>
        Boolean(
          (await chrome.storage.local.get('productspy.cloud-session.v1'))[
            'productspy.cloud-session.v1'
          ],
        ),
      ),
    ).toBe(false);
  } finally {
    await context.close();
  }
});
