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
  type ContentPlan,
  type ContentGenerationResponse,
} from '../packages/shared/src/content';
import type { ContentReferenceStatus } from '../packages/shared/src/content-references';
import type { HistorySummary } from '../packages/shared/src/history-management';
import type { ComparisonPlan } from '../packages/shared/src/comparison';
import type { Product } from '../packages/shared/src/types';
const base = 'http://127.0.0.1:3000';
const headers = {
  Origin: base,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
async function api<T>(
  request: APIRequestContext,
  path: string,
  data?: unknown,
  method = data === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request.fetch(`${base}${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  const body = (await response.json()) as { data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  return body.data;
}
const image = 'https://m.media-amazon.com/images/I/phase19-integration.jpg';
function draft(asin: string) {
  return {
    source: 'amazon' as const,
    sourceId: asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `Phase19 跨模块合成样本 ${asin}，非真实验收`,
    currency: 'USD',
    price: '$29.99',
    images: [image, 'https://m.media-amazon.com/images/I/phase19-integration._AC_SX300_.jpg'],
    mainImage: image,
    videos: [],
    bulletPoints: ['商家自述；未独立验证'],
  };
}

test('cross-module identity, selected media, analysis provenance, stale sources and deleted snapshots survive full backup and reload', async ({
  page,
  request,
}) => {
  let product = await api<Product>(request, '/api/products', draft('B019FLOW01'));
  const peer = await api<Product>(request, '/api/products', draft('B019FLOW02'));
  const template = await api<AITemplate>(request, '/api/templates', {
    ...templateDefinition(builtinTemplates[0]),
    name: 'Phase19 流程模板（合成）',
  });
  let plan: ContentPlan | undefined;
  let comparison: ComparisonPlan | undefined;
  let latest: ContentPlan | undefined;
  try {
    product = (
      await api<{ product: Product }>(request, '/api/analyze-product', {
        product,
        expectedUpdatedAt: product.updatedAt,
        requestId: randomUUID(),
      })
    ).product;
    comparison = await api<ComparisonPlan>(request, '/api/comparisons', {
      name: 'Phase19 来源对比（合成）',
      productIds: [product.id, peer.id],
    });
    comparison = (
      await api<{ plan: ComparisonPlan }>(request, '/api/analyze-comparison', {
        comparisonId: comparison.id,
        expectedUpdatedAt: comparison.updatedAt,
        requestId: randomUUID(),
      })
    ).plan;
    plan = await api<ContentPlan>(request, '/api/content-plans', {
      name: 'Phase19 来源创作（合成）',
      productId: product.id,
      templateId: template.id,
      comparisonId: comparison.id,
      options: { ...DEFAULT_CONTENT_OPTIONS, market: 'JP', language: 'ja', duration: 45 },
    });
    await page.goto(`/products/${encodeURIComponent(product.id)}`);
    await expect(page.getByRole('link', { name: '选择 AI 模板', exact: true })).toHaveAttribute(
      'href',
      `/templates?product=${encodeURIComponent(product.id)}`,
    );
    await page.goto(`/content?plan=${plan.id}`);
    await expect(page.getByRole('heading', { name: '来源与更新状态' })).toBeVisible();
    await page.getByText('选择创作参考素材', { exact: false }).click();
    await expect(page.getByRole('checkbox', { name: /创作参考图片/ })).toHaveCount(1);
    await expect(page.getByRole('combobox', { name: '参考图片 1来源', exact: true })).toBeVisible();
    await expect
      .poll(
        async () =>
          (await page.locator('.integration-media-choice > span').first().boundingBox())?.width ??
          0,
      )
      .toBeGreaterThan(70);
    await page.getByRole('checkbox', { name: '创作参考图片 1', exact: true }).check();
    await expect(page.getByRole('button', { name: '生成内容', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '保存素材选择', exact: true }).click();
    await expect(page.getByText('素材来源选择已保存。', { exact: false })).toBeVisible();
    plan = await api<ContentPlan>(request, `/api/content-plans/${plan.id}`);
    const generated = await api<ContentGenerationResponse>(request, '/api/generate-content', {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      requestId: randomUUID(),
    });
    plan = generated.plan;
    expect(generated.version.metadata?.productAnalysisReference?.productId).toBe(product.id);
    expect(generated.version.metadata?.productAnalysisReference?.asin).toBe(product.sourceId);
    expect(generated.version.metadata?.productAnalysisReference?.classification).toBe(
      'saved-analysis-unverified',
    );
    expect(generated.version.metadata?.selectedMedia).toEqual([{ kind: 'image', url: image }]);
    const savedSnapshot = structuredClone(plan.productSnapshot);
    const savedVersions = structuredClone(plan.versions);
    await api(request, '/api/products', {
      ...draft(product.sourceId),
      price: '$34.99',
      title: 'Phase19 已更新资料（合成）',
    });
    const references = await api<ContentReferenceStatus>(
      request,
      `/api/content-plans/${plan.id}/references`,
    );
    expect(references.product.status).toBe('updated');
    await page.reload();
    await expect(page.getByText('源资料已更新，本方案仍使用原快照').first()).toBeVisible();
    await page.getByRole('button', { name: '用最新资料创建新方案', exact: true }).click();
    await page.getByRole('button', { name: '载入最新资料', exact: true }).click();
    await expect(page.getByRole('heading', { name: '新建内容方案', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '创建方案', exact: true }).click();
    await expect(page).not.toHaveURL(new RegExp(`plan=${plan.id}`));
    const newId = new URL(page.url()).searchParams.get('plan');
    expect(newId).toBeTruthy();
    latest = await api<ContentPlan>(request, `/api/content-plans/${newId}`);
    expect(latest.id).not.toBe(plan.id);
    expect(latest.productSnapshot.price).toBe('$34.99');
    expect(
      (await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).productSnapshot,
    ).toEqual(savedSnapshot);
    await api(request, `/api/products/${encodeURIComponent(product.id)}`, undefined, 'DELETE');
    expect(
      (await api<ContentReferenceStatus>(request, `/api/content-plans/${plan.id}/references`))
        .product.status,
    ).toBe('deleted');
    const backup = await api<{ contentPlans: ContentPlan[] }>(request, '/api/workspace-backup');
    expect(backup.contentPlans.find((item) => item.id === plan!.id)?.versions).toEqual(
      savedVersions,
    );
    await page.goto(`/content?plan=${plan.id}`);
    await page.reload();
    await expect(page.getByText('来源已删除，本方案快照和历史仍保留').first()).toBeVisible();
    await expect(page.getByRole('heading', { name: '当前采用内容' })).toBeVisible();
    expect((await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).versions).toEqual(
      savedVersions,
    );
  } finally {
    for (const item of [plan, latest])
      if (item) {
        const current = await api<ContentPlan>(request, `/api/content-plans/${item.id}`);
        await api(
          request,
          `/api/content-plans/${item.id}`,
          { confirmed: true, expectedUpdatedAt: current.updatedAt },
          'DELETE',
        );
      }
    if (comparison)
      await api(
        request,
        `/api/comparisons/${comparison.id}`,
        { confirmed: true, expectedUpdatedAt: comparison.updatedAt },
        'DELETE',
      );
    await api(
      request,
      `/api/templates/${template.id}`,
      { confirmed: true, expectedUpdatedAt: template.updatedAt },
      'DELETE',
    );
    await request.delete(`${base}/api/products/${encodeURIComponent(product.id)}`, { headers });
    await request.delete(`${base}/api/products/${encodeURIComponent(peer.id)}`, { headers });
  }
});

test('explicit history archive and confirmation protect current, recovery nodes and human editing', async ({
  page,
  request,
}, testInfo) => {
  const product = await api<Product>(request, '/api/products', draft('B019HIST01'));
  let plan = await api<ContentPlan>(request, '/api/content-plans', {
    name: 'Phase19 历史归档（合成）',
    productId: product.id,
    templateId: builtinTemplates[0].id,
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
    const first = plan.versions[0].id;
    for (const text of ['可选旧人工编辑', '受保护当前人工编辑'])
      plan = await api(
        request,
        `/api/content-plans/${plan.id}`,
        {
          expectedUpdatedAt: plan.updatedAt,
          output: { ...generated.version.output, voiceover: [text] },
        },
        'PATCH',
      );
    const summary = await api<HistorySummary>(request, `/api/history?kind=content&id=${plan.id}`);
    expect(summary.count).toBe(3);
    expect(summary.versions.find((item) => item.id === first)?.protected).toBe(true);
    expect(summary.versions.find((item) => item.id === plan.currentVersionId)?.protected).toBe(
      true,
    );
    const removable = summary.versions.find((item) => !item.protected)!;
    expect(removable).toBeTruthy();
    await page.goto(`/content?plan=${plan.id}`);
    await page.getByText('历史容量管理', { exact: false }).click();
    await expect(page.getByRole('button', { name: '导出所选历史', exact: true })).toBeDisabled();
    await page
      .getByRole('checkbox', { name: `归档 人工编辑 ${removable.date}`, exact: true })
      .check();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出所选历史（1）', exact: true }).click();
    const download = await downloading;
    const path = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const archive = JSON.parse(await readFile(path, 'utf8')) as { selectedVersionIds: string[] };
    expect(archive.selectedVersionIds).toEqual([removable.id]);
    await expect(
      page.getByRole('button', { name: '确认清理所选旧版本', exact: true }),
    ).toBeDisabled();
    await page
      .getByRole('checkbox', {
        name: '我已确认归档文件保存成功，明确清理上述旧版本。',
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: '确认清理所选旧版本', exact: true }).click();
    await expect(page.getByText('已清理 1 个归档版本。', { exact: false })).toBeVisible();
    plan = await api(request, `/api/content-plans/${plan.id}`);
    expect(plan.versions).toHaveLength(2);
    expect(plan.versions.map((item) => item.id)).toContain(first);
    expect(
      plan.versions.find((item) => item.id === plan.currentVersionId)?.output.voiceover,
    ).toEqual(['受保护当前人工编辑']);
    await page.reload();
    await expect(page.getByText('受保护当前人工编辑', { exact: true })).toBeVisible();
  } finally {
    const current = await api<ContentPlan>(request, `/api/content-plans/${plan.id}`);
    await api(
      request,
      `/api/content-plans/${plan.id}`,
      { confirmed: true, expectedUpdatedAt: current.updatedAt },
      'DELETE',
    );
    await api(request, `/api/products/${encodeURIComponent(product.id)}`, undefined, 'DELETE');
  }
});
