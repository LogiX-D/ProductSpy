import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const BASE = 'http://127.0.0.1:3100';
const password = 'Synthetic-workspace-password-2026';
async function register(page: Page, email: string) {
  await page.goto('/register');
  await page.getByLabel('姓名', { exact: true }).fill('SaaS Browser Test');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await expect(page.getByRole('link', { name: '商品库', exact: true }).first()).toBeVisible();
}
test('SaaS UI account, product, content, tasks, billing, mobile, and cross-account isolation', async ({
  page,
  browser,
}, info) => {
  const email = `workspace-${randomUUID()}@example.test`;
  await register(page, email);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page
    .locator('.ws-sidebar-footer')
    .getByRole('link', { name: '隐私说明', exact: true })
    .click();
  await expect(page).toHaveURL(`${BASE}/privacy`);
  await expect(page.getByRole('heading', { name: '扩展数据用途限制', exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Chrome Web Store 用户数据政策', exact: true }),
  ).toHaveAttribute(
    'href',
    'https://developer.chrome.com/docs/webstore/program-policies/limited-use',
  );
  await page.getByRole('link', { name: 'ProductSpy', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await page.setViewportSize({ width: 1280, height: 900 });
  const draft = {
    source: 'amazon',
    sourceId: 'B098765432',
    url: 'https://www.amazon.com/dp/B098765432',
    title: 'Synthetic Workspace Coffee Mug',
    images: [],
    videos: [],
    bulletPoints: ['Synthetic fixture only'],
    description: 'Browser test fixture; not a live Amazon product.',
  };
  const saved = await page.request.post('/api/products', {
    headers: { Origin: BASE, 'X-ProductSpy-Client': 'web' },
    data: draft,
  });
  expect(saved.ok()).toBe(true);
  await page.goto('/products');
  await expect(page.getByText(draft.title, { exact: true }).first()).toBeVisible();
  await page.goto(`/products/${encodeURIComponent(`amazon:${draft.sourceId}`)}`);
  await page.getByRole('tab', { name: 'AI 分析', exact: true }).click();
  await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  await expect(page.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
  await expect(page.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
  await page.goto('/content');
  await page.getByLabel('方案名称', { exact: true }).fill('Synthetic Cloud Content');
  await page.getByLabel('创作商品', { exact: true }).selectOption(`amazon:${draft.sourceId}`);
  const template = page.getByLabel('创作模板', { exact: true });
  const option = await template
    .locator('option')
    .evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).value).find(Boolean));
  expect(option).toBeTruthy();
  await template.selectOption(option!);
  await page.getByRole('button', { name: '创建方案', exact: true }).click();
  await page.getByRole('button', { name: '生成内容', exact: true }).click();
  await expect(page.getByText('Mock 示例版本', { exact: false }).first()).toBeVisible();
  await page.goto('/tasks');
  await expect(page.getByText('已完成', { exact: true }).first()).toBeVisible();
  await page.goto('/billing');
  await expect(page.getByRole('heading', { name: '订阅与账单', exact: true })).toBeVisible();
  await page.goto('/account');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(email);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.screenshot({ path: info.outputPath('saas-account-mobile.png'), fullPage: true });
  await page.locator('.ws-mobile-nav').getByRole('link', { name: '隐私说明', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/privacy`);
  await expect(page.getByRole('heading', { name: '扩展数据用途限制', exact: true })).toBeVisible();
  await page.goto('/account');
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue(email);
  const second = await browser.newContext();
  try {
    const another = await second.newPage();
    await another.goto(`${BASE}/login`);
    await another.getByLabel('邮箱', { exact: true }).fill(email);
    await another.getByLabel('密码', { exact: true }).fill(password);
    await another.getByRole('button', { name: '登录', exact: true }).click();
    await expect(another).toHaveURL(`${BASE}/`);
    await another.goto(`${BASE}/content`);
    await expect(another.getByRole('button', { name: /Synthetic Cloud Content/ })).toBeVisible();
    await another.goto(`${BASE}/products`);
    await expect(another.getByText(draft.title, { exact: true }).first()).toBeVisible();
  } finally {
    await second.close();
  }
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await register(page, `other-${randomUUID()}@example.test`);
  await page.goto('/products');
  await expect(page.getByText(draft.title, { exact: true })).toHaveCount(0);
  await page.goto('/content');
  await expect(page.getByRole('button', { name: /Synthetic Cloud Content/ })).toHaveCount(0);
  await info.attach('scope', {
    body: Buffer.from(
      'Real local SaaS HTTP/database, synthetic product, Mock AI; independent browser contexts do not prove physical cross-device access.',
    ),
    contentType: 'text/plain',
  });
});
