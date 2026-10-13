import { test, expect, type APIRequestContext } from './test-fixtures';
import { randomUUID } from 'node:crypto';
import type {
  ComparisonPlan,
  ComparisonGenerationResponse,
} from '../packages/shared/src/comparison';
import type { Product } from '../packages/shared/src/types';
const BASE = 'http://127.0.0.1:3000';
const headers = {
  Origin: BASE,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
async function call<T>(
  request: APIRequestContext,
  path: string,
  data?: unknown,
  method = data === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request.fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  const body = (await response.json()) as { ok: boolean; error?: string; data: T };
  expect(response.status(), body.error).toBe(200);
  return body.data;
}
async function seed(request: APIRequestContext) {
  await call(request, '/api/session', {});
  const drafts = [
    {
      sourceId: 'B017TEST01',
      title: '=Phase 17 测试研磨器（合成商品）',
      price: '$20',
      currency: 'USD',
      brand: 'Fixture A',
    },
    {
      sourceId: 'B017TEST02',
      title: 'Phase 17 测试研磨器 B（合成商品）',
      price: '£18',
      currency: 'GBP',
    },
    { sourceId: 'B017TEST03', title: 'Phase 17 缺失字段（合成商品）' },
  ].map((p) => ({
    ...p,
    source: 'amazon',
    url: `https://www.amazon.com/dp/${p.sourceId}`,
    images: [],
    videos: [],
    bulletPoints: ['商家页面宣称便携，未经独立验证'],
  }));
  const products: Product[] = [];
  for (const draft of drafts) products.push(await call<Product>(request, '/api/products', draft));
  return { drafts, products };
}
async function cleanup(request: APIRequestContext, plan?: ComparisonPlan) {
  if (plan) {
    const current = await call<ComparisonPlan>(request, `/api/comparisons/${plan.id}`);
    await call(
      request,
      `/api/comparisons/${plan.id}`,
      { confirmed: true, expectedUpdatedAt: current.updatedAt },
      'DELETE',
    );
  }
  for (const asin of ['B017TEST01', 'B017TEST02', 'B017TEST03'])
    await request.delete(`${BASE}/api/products/${encodeURIComponent(`amazon:${asin}`)}`, {
      headers,
    });
}
test('saved snapshots, mixed currencies, Mock history and source deletion survive UI reload', async ({
  page,
  request,
}) => {
  const { products, drafts } = await seed(request);
  let plan: ComparisonPlan | undefined;
  try {
    await page.goto(
      `/comparisons?products=${encodeURIComponent(products.map((p) => p.id).join(','))}`,
    );
    await page.getByRole('button', { name: '保存方案', exact: true }).click();
    await expect(page.getByRole('table')).toBeVisible();
    plan = (await call<{ plans: ComparisonPlan[] }>(request, '/api/comparisons')).plans.find((p) =>
      p.products.some((product) => product.sourceId === 'B017TEST01'),
    );
    expect(plan).toBeDefined();
    const original = structuredClone(plan!);
    await expect(page.getByText('未知', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/不同货币/).first()).toBeVisible();
    await page.getByRole('button', { name: '开始 AI 对比分析', exact: true }).click();
    await expect(page.getByRole('heading', { name: '核心差异', exact: true })).toBeVisible();
    plan = await call(request, `/api/comparisons/${plan!.id}`);
    expect(plan!.analysisMetadata?.mode).toBe('mock');
    expect(plan!.analysisMetadata?.evidence.reviewTextAnalyzed).toBe(false);
    expect(plan!.analysisHistory).toHaveLength(1);
    await page.getByRole('button', { name: '编辑结果', exact: true }).click();
    await page.getByLabel('编辑核心差异', { exact: true }).fill('人工结论必须保留');
    await page.getByRole('button', { name: '保存编辑', exact: true }).click();
    await expect(page.getByText('人工结论必须保留', { exact: true })).toBeVisible();
    plan = await call(request, `/api/comparisons/${plan!.id}`);
    expect(plan!.analysisHistory).toHaveLength(2);
    await call(request, '/api/products', { ...drafts[0], title: 'UPDATED source only' });
    await request.delete(`${BASE}/api/products/${encodeURIComponent(products[1].id)}`, { headers });
    await page.reload();
    await expect(page.getByText(/原商品已删除/).first()).toBeVisible();
    await expect(page.getByText(/商品库已更新/).first()).toBeVisible();
    expect((await call<ComparisonPlan>(request, `/api/comparisons/${plan!.id}`)).products).toEqual(
      original.products,
    );
    await call(
      request,
      `/api/comparisons/${plan!.id}`,
      { expectedUpdatedAt: plan!.updatedAt, restoreVersionId: plan!.analysisHistory![0].id },
      'PATCH',
    );
    plan = await call(request, `/api/comparisons/${plan!.id}`);
    expect(plan!.analysisHistory).toHaveLength(3);
    expect(plan!.analysis).toEqual(plan!.analysisHistory![0].analysis);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.getByRole('table')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
  } finally {
    await cleanup(request, plan);
  }
});
test('comparison backup preserves duplicate history, safe restore and AI idempotence', async ({
  request,
}) => {
  const { products } = await seed(request);
  let plan: ComparisonPlan | undefined;
  try {
    plan = await call(request, '/api/comparisons', {
      name: 'Phase 17 isolated backup fixture',
      productIds: products.slice(0, 2).map((p) => p.id),
    });
    const requestId = randomUUID();
    const input = {
      comparisonId: plan!.id,
      expectedUpdatedAt: plan!.updatedAt,
      requestId,
      options: {
        market: 'JP',
        language: 'ja',
        platform: 'Shorts',
        duration: 15,
        style: 'professional',
        goal: 'consideration',
        customInstructions: '手元のみの撮影',
      },
    };
    const generated = await call<ComparisonGenerationResponse>(
      request,
      '/api/analyze-comparison',
      input,
    );
    const replayed = await call<ComparisonGenerationResponse>(
      request,
      '/api/analyze-comparison',
      input,
    );
    expect(replayed.replayed).toBe(true);
    expect(replayed.plan).toEqual(generated.plan);
    plan = generated.plan;
    const backup = await call<{ plans: ComparisonPlan[] }>(request, '/api/comparisons/backup');
    const filtered = { ...backup, plans: backup.plans.filter((p) => p.id === plan!.id) };
    const preview = await call<{ revision: string; conflicts: unknown[] }>(
      request,
      '/api/comparisons/backup',
      { backup: filtered },
    );
    expect(preview.conflicts).toHaveLength(1);
    const imported = await call<{ skipped: number }>(request, '/api/comparisons/backup', {
      backup: filtered,
      commit: true,
      expectedRevision: preview.revision,
      policy: 'preserve',
    });
    expect(imported.skipped).toBe(1);
    expect(await call(request, `/api/comparisons/${plan!.id}`)).toEqual(plan);
    await call(
      request,
      `/api/comparisons/${plan!.id}`,
      { confirmed: true, expectedUpdatedAt: plan!.updatedAt },
      'DELETE',
    );
    const newPreview = await call<{ revision: string }>(request, '/api/comparisons/backup', {
      backup: filtered,
    });
    await call(request, '/api/comparisons/backup', {
      backup: filtered,
      commit: true,
      expectedRevision: newPreview.revision,
      policy: 'skip',
    });
    expect(await call(request, `/api/comparisons/${plan!.id}`)).toEqual(plan);
    const invalid = await request.post(`${BASE}/api/comparisons/backup`, {
      headers,
      data: { backup: { ...filtered, schemaVersion: 999 } },
    });
    expect(invalid.status()).toBe(400);
  } finally {
    await cleanup(request, plan);
  }
});
test('comparison API refuses untrusted writes, stale edits and unconfirmed deletion', async ({
  request,
}) => {
  const { products } = await seed(request);
  let plan: ComparisonPlan | undefined;
  try {
    plan = await call(request, '/api/comparisons', {
      name: 'Phase 17 safety fixture',
      productIds: products.slice(0, 2).map((p) => p.id),
    });
    const before = structuredClone(plan!);
    for (const [method, data, override, status] of [
      ['PATCH', { expectedUpdatedAt: '2020-01-01T00:00:00.000Z', name: 'Bad' }, {}, 409],
      ['DELETE', { expectedUpdatedAt: plan!.updatedAt, confirmed: false }, {}, 400],
      [
        'PATCH',
        { expectedUpdatedAt: plan!.updatedAt, name: 'Bad' },
        { Origin: 'https://evil.example' },
        403,
      ],
    ] as const) {
      const response = await request.fetch(`${BASE}/api/comparisons/${plan!.id}`, {
        method,
        data,
        headers: { ...headers, ...override },
      });
      expect(response.status()).toBe(status);
    }
    expect(await call(request, `/api/comparisons/${plan!.id}`)).toEqual(before);
  } finally {
    await cleanup(request, plan);
  }
});
