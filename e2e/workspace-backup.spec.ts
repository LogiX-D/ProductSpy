import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test, expect, type APIRequestContext } from './test-fixtures';
import {
  builtinTemplates,
  templateDefinition,
  type AITemplate,
} from '../packages/shared/src/templates';
import {
  DEFAULT_CONTENT_OPTIONS,
  type ContentGenerationResponse,
  type ContentPlan,
} from '../packages/shared/src/content';
import { DEFAULT_ANALYSIS_OPTIONS } from '../packages/shared/src/schema';
import { parseWorkspaceBackupText } from '../packages/shared/src/business-backup';
import type { Product } from '../packages/shared/src/types';
const origin = 'http://127.0.0.1:3000';
const headers = {
  Origin: origin,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
async function api<T>(
  request: APIRequestContext,
  path: string,
  value?: unknown,
  method = value === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request.fetch(`${origin}${path}`, {
    method,
    headers,
    ...(value === undefined ? {} : { data: value }),
  });
  const body = (await response.json()) as { data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  return body.data;
}
test('complete business backup UI exports real local state and restores with explicit confirmation without overwriting newer edits', async ({
  page,
  request,
}) => {
  const product = await api<Product>(request, '/api/products', {
    source: 'amazon',
    sourceId: 'B019BAK001',
    url: 'https://www.amazon.com/dp/B019BAK001',
    title: 'Phase19 完整备份合成样本，非 Amazon 验收',
    images: [],
    videos: [],
    bulletPoints: ['合成流程样本；不调用收费模型'],
  });
  const template = await api<AITemplate>(request, '/api/templates', {
    ...templateDefinition(builtinTemplates[0]),
    name: 'Phase19 备份模板（合成）',
  });
  let plan = await api<ContentPlan>(request, '/api/content-plans', {
    name: 'Phase19 备份方案（合成）',
    productId: product.id,
    templateId: template.id,
    options: DEFAULT_CONTENT_OPTIONS,
  });
  try {
    const generated = await api<ContentGenerationResponse>(request, '/api/generate-content', {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      requestId: randomUUID(),
    });
    plan = generated.plan;
    expect(generated.version.metadata?.mode).toBe('mock');
    plan = await api<ContentPlan>(
      request,
      `/api/content-plans/${plan.id}`,
      {
        expectedUpdatedAt: plan.updatedAt,
        output: { ...generated.version.output, voiceover: ['备份中的人工口播'] },
      },
      'PATCH',
    );
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '设置与业务备份', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '导出完整业务备份', exact: true })).toBeEnabled();
    await page.evaluate((options) => {
      localStorage.setItem(
        'productspy:analysis-preferences:v1',
        JSON.stringify({ version: 1, options, pricing: {} }),
      );
      localStorage.setItem('productspy:unrelated-test-token', 'synthetic-excluded-private-value');
    }, DEFAULT_ANALYSIS_OPTIONS);
    await page.getByLabel('另附此浏览器的商品库、分析、创作偏好与内置模板收藏').check();
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出完整业务备份', exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(/^ProductSpy-0\.8\.0-workspace-.*\.json$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const text = await readFile(path!, 'utf8');
    expect(text).not.toContain('synthetic-excluded-private-value');
    const backup = parseWorkspaceBackupText(text);
    expect(backup.preferences?.analysis?.options).toEqual(DEFAULT_ANALYSIS_OPTIONS);
    expect(backup.contentPlans.find((item) => item.id === plan.id)?.versions).toEqual(
      plan.versions,
    );
    plan = await api<ContentPlan>(
      request,
      `/api/content-plans/${plan.id}`,
      {
        expectedUpdatedAt: plan.updatedAt,
        output: { ...generated.version.output, voiceover: ['备份后更新的人工口播，不得覆盖'] },
      },
      'PATCH',
    );
    const beforeRestore = structuredClone(plan);
    await page.getByLabel('完整业务备份文件').setInputFiles({
      name: 'workspace-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
    await expect(page.getByRole('heading', { name: '恢复预览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '确认恢复这份业务备份', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '再次确认恢复', exact: true });
    await expect(dialog).toBeVisible();
    expect(await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).toEqual(beforeRestore);
    await dialog.getByRole('button', { name: '恢复并保留本机资料', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '恢复完成：新增 0 条' })).toBeVisible();
    expect(await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).toEqual(beforeRestore);
    await page.reload();
    await expect(page.getByRole('heading', { name: '完整业务备份', exact: true })).toBeVisible();
    expect(await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).toEqual(beforeRestore);
  } finally {
    await api(
      request,
      `/api/content-plans/${plan.id}`,
      { confirmed: true, expectedUpdatedAt: plan.updatedAt },
      'DELETE',
    );
    await api(
      request,
      `/api/templates/${template.id}`,
      { confirmed: true, expectedUpdatedAt: template.updatedAt },
      'DELETE',
    );
    await api(request, `/api/products/${product.id}`, undefined, 'DELETE');
  }
});
test('backup settings remain usable without document overflow at four target widths', async ({
  page,
}) => {
  for (const width of [320, 375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings');
    const heading = page.getByRole('heading', { name: '设置与业务备份', exact: true });
    await expect(heading).toBeVisible();
    await expect(page.getByRole('button', { name: '导出完整业务备份', exact: true })).toBeEnabled();
    const geometry = await page.evaluate(() => ({
      viewport: innerWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(geometry.page).toBeLessThanOrEqual(geometry.viewport + 1);
    await page.getByRole('button', { name: '导出完整业务备份', exact: true }).focus();
    await expect(page.getByRole('button', { name: '导出完整业务备份', exact: true })).toBeFocused();
  }
});
