import { test, expect, type APIRequestContext, type Page } from './test-fixtures';
import { readFile } from 'node:fs/promises';
import type { Product } from '../packages/shared/src/types';

const BASE = 'http://127.0.0.1:3000';
const headers = {
  Origin: BASE,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
async function seed(request: APIRequestContext, asin: string) {
  expect((await request.post(`${BASE}/api/session`, { headers, data: {} })).ok()).toBe(true);
  const endpoint = `${BASE}/api/products/${encodeURIComponent(`amazon:${asin}`)}`;
  await request.delete(endpoint, { headers });
  const saved = await request.post(`${BASE}/api/products`, {
    headers,
    data: {
      source: 'amazon',
      sourceId: asin,
      url: `https://www.amazon.com/dp/${asin}`,
      title: 'Phase 12 合成 AI 验收商品',
      images: [],
      videos: [],
      bulletPoints: ['Manual coffee grinding', 'Adjustable grind setting'],
    },
  });
  expect(saved.ok()).toBe(true);
  return { endpoint, product: ((await saved.json()) as { data: Product }).data };
}
async function current(request: APIRequestContext, endpoint: string) {
  return ((await (await request.get(endpoint, { headers })).json()) as { data: Product }).data;
}
async function openOptions(page: Page) {
  if ((await page.locator('.analysis-options').getAttribute('open')) === null)
    await page.locator('.analysis-options > summary').click();
}

test('AI preferences → manual edit → partial regeneration → versions → export → restore', async ({
  page,
  request,
}) => {
  const { endpoint, product } = await seed(request, 'B012AI0001');
  try {
    await page.goto(`${BASE}/products/${encodeURIComponent(product.id)}?tab=analysis`);
    await page.getByLabel('目标市场', { exact: true }).selectOption('UK');
    await page.getByLabel('输出语言', { exact: true }).selectOption('en');
    await page.getByLabel('内容平台', { exact: true }).selectOption('Reels');
    await page.getByLabel('内容风格', { exact: true }).selectOption('humorous');
    await page.getByLabel('视频时长', { exact: true }).selectOption('30');
    await page
      .getByLabel('自定义分析要求', { exact: true })
      .fill('Use a tabletop demonstration. QA_REQUIREMENT');
    await page.getByRole('button', { name: '保存分析偏好', exact: true }).click();
    await page.reload();
    await expect(page.getByLabel('目标市场', { exact: true })).toHaveValue('UK');
    await expect(page.getByLabel('输出语言', { exact: true })).toHaveValue('en');
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
    const generated = await current(request, endpoint);
    expect(generated.analysisMetadata?.options.market).toBe('UK');
    expect(generated.analysisMetadata?.evidence.reviewTextAnalyzed).toBe(false);
    await page.getByRole('button', { name: '编辑分析', exact: true }).click();
    await page.getByLabel('商品总结', { exact: true }).fill('人工摘要必须保留。');
    await page.getByRole('button', { name: '保存分析', exact: true }).click();
    await expect(page.getByText('分析已保存。', { exact: true })).toBeVisible();
    const edited = await current(request, endpoint);
    const originalSummary = edited.aiAnalysis!.summary;
    const manualVersion = edited.analysisHistory!.find((entry) => entry.kind === 'edited')!;
    await openOptions(page);
    await page.getByLabel('目标市场', { exact: true }).selectOption('JP');
    await page.getByLabel('输出语言', { exact: true }).selectOption('ja');
    await page.getByLabel('视频时长', { exact: true }).selectOption('15');
    await page.getByRole('button', { name: '清除选择', exact: true }).click();
    await page.getByLabel('重新生成开场文案', { exact: true }).check();
    await page.getByRole('button', { name: '重新生成分析', exact: true }).click();
    await page.getByRole('button', { name: '确认重新生成', exact: true }).click();
    await expect
      .poll(async () => (await current(request, endpoint)).analysisMetadata?.options.language)
      .toBe('ja');
    const partial = await current(request, endpoint);
    expect(partial.aiAnalysis!.summary).toBe(originalSummary);
    expect(partial.aiAnalysis!.hooks.some((hook) => /[\u3040-\u30ff]/.test(hook))).toBe(true);
    expect(partial.analysisMetadata?.selectedFields).toEqual(['hooks']);
    await expect(page.locator('#analysis-summary')).toContainText(originalSummary);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Markdown', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.md$/);
    const path = await download.path();
    expect(path).not.toBeNull();
    const markdown = await readFile(path!, 'utf8');
    expect(markdown).toContain('人工摘要必须保留');
    expect(markdown).toContain('QA_REQUIREMENT');
    await page.locator('.analysis-history > summary').click();
    await page.getByLabel('比较版本 A', { exact: true }).selectOption(manualVersion.id);
    await page.getByLabel('比较版本 B', { exact: true }).selectOption('current');
    await expect(page.locator('.analysis-comparison')).toContainText('1 个内容字段不同');
    await page
      .locator('.analysis-history-row')
      .filter({ hasText: '人工编辑' })
      .getByRole('button', { name: '恢复版本', exact: true })
      .click();
    await page.getByRole('button', { name: '确认恢复版本', exact: true }).click();
    await expect
      .poll(async () => (await current(request, endpoint)).analysisHistory?.at(-1)?.kind)
      .toBe('restored');
    const restored = await current(request, endpoint);
    expect(restored.aiAnalysis).toEqual(edited.aiAnalysis);
    await page.reload();
    await expect(page.locator('#analysis-summary')).toContainText(originalSummary);
    expect((await current(request, endpoint)).analysisHistory).toEqual(restored.analysisHistory);
  } finally {
    await request.delete(endpoint, { headers });
  }
});

test('real-mode UI Stub requires a separate paid-request confirmation and sends no media or history', async ({
  page,
  request,
}) => {
  const { endpoint, product } = await seed(request, 'B012AI0002');
  let requests = 0;
  let payload: Record<string, unknown> | undefined;
  await page.route(`${BASE}/api/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { mode: 'real', version: '0.4.0' } }),
    }),
  );
  await page.route(`${BASE}/api/analyze-product`, async (route) => {
    requests++;
    payload = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Stub: no paid model has been called' }),
    });
  });
  try {
    await page.goto(`${BASE}/products/${encodeURIComponent(product.id)}?tab=analysis`);
    await expect(page.getByText('真实 AI 服务已配置', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '确认调用真实 AI 服务？', exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/费用未知。继续并不代表免费。/)).toBeVisible();
    expect(requests).toBe(0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    expect(requests).toBe(0);
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await page.getByRole('button', { name: '授权本次调用', exact: true }).click();
    await expect(page.getByText(/Stub: no paid model has been called/)).toBeVisible();
    expect(requests).toBe(1);
    expect(payload?.authorizeReal).toBe(true);
    expect(payload?.requestId).toMatch(/^[a-f0-9-]{36}$/i);
    const sent = payload?.product as Record<string, unknown>;
    expect(sent).not.toHaveProperty('analysisHistory');
    expect(sent).not.toHaveProperty('analysisMetadata');
    expect(sent).not.toHaveProperty('aiAnalysis');
    expect((await current(request, endpoint)).aiAnalysis).toBeUndefined();
    await page.waitForTimeout(250);
    expect(requests).toBe(1);
  } finally {
    await request.delete(endpoint, { headers });
  }
});

test('lost analysis response survives reload and recovers current manual result without a second AI request', async ({
  page,
  request,
}) => {
  const { endpoint, product } = await seed(request, 'B012AI0003');
  let requests = 0;
  await page.route(`${BASE}/api/analyze-product`, async (route) => {
    requests++;
    // Forward via the already authenticated local test client. Browser routing's
    // APIRequestContext does not preserve the browser-only origin security metadata.
    const response = await request.post(`${BASE}/api/analyze-product`, {
      headers,
      data: route.request().postDataJSON() as unknown,
    });
    expect(response.ok()).toBe(true);
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Stub: saved response was lost' }),
    });
  });
  try {
    await page.goto(`${BASE}/products/${encodeURIComponent(product.id)}?tab=analysis`);
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await expect(page.getByText(/Stub: saved response was lost/)).toBeVisible();
    expect(requests).toBe(1);
    const generated = await current(request, endpoint);
    expect(generated.aiAnalysis).toBeDefined();
    const manualAnalysis = {
      ...generated.aiAnalysis!,
      summary: 'Mock 演示分析：另一标签页在失败响应后保存的人工修改。',
    };
    expect(
      (
        await request.patch(endpoint, {
          headers,
          data: { analysis: manualAnalysis, expectedUpdatedAt: generated.updatedAt },
        })
      ).ok(),
    ).toBe(true);
    await page.reload();
    await page.getByRole('button', { name: '检查上次请求结果', exact: true }).click();
    await expect(page.getByText(/现在显示商品当前分析/)).toBeVisible();
    await expect(page.locator('#analysis-summary')).toContainText(manualAnalysis.summary);
    expect(requests).toBe(1);
    expect((await current(request, endpoint)).aiAnalysis).toEqual(manualAnalysis);
  } finally {
    await request.delete(endpoint, { headers });
  }
});
