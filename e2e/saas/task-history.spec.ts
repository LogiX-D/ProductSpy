import { test, expect, type Request } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { AccountJob, AccountJobsPage } from '../../apps/web/src/lib/saas-types';

const BASE = 'http://127.0.0.1:3100';
const PASSWORD = 'Synthetic-task-history-password-2026!';
const OLDER_CURSOR = 'synthetic-task-history-after-first-50';
const jobs: AccountJob[] = Array.from({ length: 57 }, (_, index) => ({
  id: `synthetic-task-history-fixture-${String(index + 1).padStart(3, '0')}`,
  kind: index % 2 === 0 ? 'analysis' : 'content',
  status: index === 0 ? 'failed' : 'succeeded',
  createdAt: new Date(Date.UTC(2026, 9, 18) - index * 60_000).toISOString(),
  updatedAt: new Date(Date.UTC(2026, 9, 18) - index * 60_000 + 1000).toISOString(),
  ...(index === 0
    ? { error: 'Synthetic GET fixture only; no AI task or provider request was executed.' }
    : {}),
}));

function isJobsPage(request: Request, cursor: string | null): boolean {
  const url = new URL(request.url());
  return (
    request.method() === 'GET' &&
    url.origin === BASE &&
    url.pathname === '/api/jobs' &&
    url.searchParams.get('limit') === '50' &&
    url.searchParams.get('cursor') === cursor
  );
}

test('task history pagination and 375px layout (synthetic GET fixture, real registration/login)', async ({
  page,
}, info) => {
  const email = `task-history-${randomUUID()}@example.test`;
  // Registration, logout, login, and session checks use the real local SaaS HTTP API.
  await page.goto('/register');
  await page.getByLabel('姓名', { exact: true }).fill('Synthetic Task History Browser Test');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(`${BASE}/`);

  const requestedPages: { cursor: string | null; limit: string | null }[] = [];
  const jobWrites: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === BASE && url.pathname === '/api/jobs' && request.method() !== 'GET')
      jobWrites.push(request.method());
  });
  // Only this read-only task-list endpoint is fulfilled. These records never enter
  // the database; SQL pagination/authorization have separate integration coverage.
  await page.route('**/api/jobs?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== 'GET' || url.origin !== BASE) {
      await route.continue();
      return;
    }
    const cursor = url.searchParams.get('cursor');
    const limit = url.searchParams.get('limit');
    requestedPages.push({ cursor, limit });
    if (limit !== '50' || (cursor !== null && cursor !== OLDER_CURSOR)) {
      await route.fulfill({
        status: 400,
        json: { ok: false, error: 'Unexpected synthetic task-list pagination request' },
      });
      return;
    }
    const data: AccountJobsPage = {
      jobs: cursor === null ? jobs.slice(0, 50) : jobs.slice(50),
      nextCursor: cursor === null ? OLDER_CURSOR : null,
    };
    await route.fulfill({
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'X-ProductSpy-Test-Fixture': 'synthetic-task-history-list',
      },
      json: { ok: true, data },
    });
  });

  await page.setViewportSize({ width: 375, height: 812 });
  const firstRequest = page.waitForRequest((request) => isJobsPage(request, null));
  await page.goto('/tasks');
  await firstRequest;
  await expect(page.getByRole('heading', { name: '任务记录', exact: true })).toBeVisible();
  const pagination = page.getByRole('navigation', { name: '任务分页', exact: true });
  const previous = pagination.getByRole('button', { name: '上一页', exact: true });
  const next = pagination.getByRole('button', { name: '下一页', exact: true });
  const rows = page.getByRole('table').locator('tbody tr');
  const noPageOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

  await expect(rows).toHaveCount(50);
  await expect(pagination.getByRole('status')).toHaveText('第 1 页 · 本页 50 条');
  await expect(page.getByText(jobs[0].id, { exact: true })).toBeVisible();
  await expect(page.getByText(jobs[49].id, { exact: true })).toBeVisible();
  await expect(page.getByText(jobs[50].id, { exact: true })).toHaveCount(0);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect.poll(noPageOverflow).toBe(true);

  const olderRequest = page.waitForRequest((request) => isJobsPage(request, OLDER_CURSOR));
  await next.click();
  await olderRequest;
  await expect(rows).toHaveCount(7);
  await expect(pagination.getByRole('status')).toHaveText('第 2 页 · 本页 7 条');
  await expect(page.getByText(jobs[50].id, { exact: true })).toBeVisible();
  await expect(page.getByText(jobs[56].id, { exact: true })).toBeVisible();
  await expect(page.getByText(jobs[0].id, { exact: true })).toHaveCount(0);
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect.poll(noPageOverflow).toBe(true);
  await pagination.scrollIntoViewIfNeeded();
  await expect(previous).toBeInViewport();
  await expect(next).toBeInViewport();
  await page.screenshot({
    path: info.outputPath('synthetic-task-history-375px.png'),
    fullPage: true,
  });

  const refreshRequest = page.waitForRequest((request) => isJobsPage(request, OLDER_CURSOR));
  await page.getByRole('button', { name: '刷新任务', exact: true }).click();
  await refreshRequest;
  await expect(rows).toHaveCount(7);
  await expect(pagination.getByRole('status')).toHaveText('第 2 页 · 本页 7 条');
  await expect(next).toBeDisabled();

  const previousRequest = page.waitForRequest((request) => isJobsPage(request, null));
  await previous.click();
  await previousRequest;
  await expect(rows).toHaveCount(50);
  await expect(pagination.getByRole('status')).toHaveText('第 1 页 · 本页 50 条');
  await expect(page.getByText(jobs[0].id, { exact: true })).toBeVisible();
  await expect(page.getByText(jobs[50].id, { exact: true })).toHaveCount(0);
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();
  await expect.poll(noPageOverflow).toBe(true);
  expect(requestedPages).toEqual(
    expect.arrayContaining([
      { cursor: null, limit: '50' },
      { cursor: OLDER_CURSOR, limit: '50' },
    ]),
  );
  expect(jobWrites).toEqual([]);
  await info.attach('scope', {
    body: Buffer.from(
      JSON.stringify({
        authentication: 'Real registration, logout, login, and SaaS session HTTP requests',
        taskList: '57 synthetic GET /api/jobs fixture records; no database tasks or AI execution',
        requests: requestedPages,
        limits: 'UI/cursor/375px coverage only; does not prove SQL pagination or cloud deployment',
      }),
    ),
    contentType: 'application/json',
  });
});
