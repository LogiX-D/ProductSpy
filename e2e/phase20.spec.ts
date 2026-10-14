import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import JSZip from '../apps/web/node_modules/jszip';
import { test, expect, type APIRequestContext } from './test-fixtures';
import {
  parseWorkspaceBackup,
  type WorkspaceBackup,
  type WorkspaceBackupPreview,
} from '../packages/shared/src/business-backup';
import {
  DEFAULT_CONTENT_OPTIONS,
  type ContentPlan,
  type ContentGenerationResponse,
} from '../packages/shared/src/content';
import {
  builtinTemplates,
  templateDefinition,
  type AITemplate,
} from '../packages/shared/src/templates';
import type { ComparisonPlan } from '../packages/shared/src/comparison';
import type {
  LibrarySnapshot,
  Product,
  AnalysisGenerationResponse,
} from '../packages/shared/src/types';

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
  value?: unknown,
  method = value === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await request.fetch(`${base}${path}`, {
    method,
    headers,
    ...(value === undefined ? {} : { data: value }),
  });
  const body = (await response.json()) as { data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  return body.data;
}
function draft(asin: string) {
  const image = 'https://m.media-amazon.com/images/I/rc-business-synthetic.jpg';
  return {
    source: 'amazon' as const,
    sourceId: asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: `RC 最终业务合成样本 ${asin}，非真实 Amazon 质量证据`,
    price: '$29.00',
    currency: 'USD',
    images: [image],
    mainImage: image,
    videos: [],
    bulletPoints: ['商家宣称便携；待人工核实'],
  };
}

test('RC complete business state restores deleted entities, rejects stale previews, preserves newer edits and replays without new AI usage', async ({
  request,
  page,
}, testInfo) => {
  const productIds: string[] = [];
  const definitions: { kind: 'group' | 'tag'; id: string }[] = [];
  let template: AITemplate | undefined;
  let comparison: ComparisonPlan | undefined;
  let plan: ContentPlan | undefined;
  try {
    let product = await api<Product>(request, '/api/products', draft('B020RC0001'));
    let peer = await api<Product>(request, '/api/products', draft('B020RC0002'));
    productIds.push(product.id, peer.id);
    const groupName = `RC 分组 ${randomUUID().slice(0, 8)}`;
    const tagName = `RC 标签 ${randomUUID().slice(0, 8)}`;
    let library = await api<LibrarySnapshot>(request, '/api/library', {
      kind: 'group',
      action: 'create',
      name: groupName,
      color: '#0f766e',
    });
    const group = library.groups.find((item) => item.name === groupName)!;
    definitions.push({ kind: 'group', id: group.id });
    library = await api<LibrarySnapshot>(request, '/api/library', {
      kind: 'tag',
      action: 'create',
      name: tagName,
      color: '#b45309',
    });
    const tag = library.tags.find((item) => item.name === tagName)!;
    definitions.push({ kind: 'tag', id: tag.id });
    await api(request, '/api/library/batch', {
      ids: productIds,
      operation: 'add-groups',
      groupIds: [group.id],
    });
    await api(request, '/api/library/batch', {
      ids: productIds,
      operation: 'add-tags',
      tagIds: [tag.id],
    });
    product = await api<Product>(request, `/api/products/${product.id}`);
    product = (
      await api<AnalysisGenerationResponse>(request, '/api/analyze-product', {
        product,
        requestId: randomUUID(),
      })
    ).product;
    product = await api<Product>(
      request,
      `/api/products/${product.id}`,
      {
        expectedUpdatedAt: product.updatedAt,
        analysis: { ...product.aiAnalysis!, summary: 'RC 人工商品分析；完整历史必须保留' },
      },
      'PATCH',
    );
    peer = await api<Product>(request, `/api/products/${peer.id}`);
    comparison = await api<ComparisonPlan>(request, '/api/comparisons', {
      name: 'RC 备份横向对比（合成）',
      productIds,
    });
    comparison = (
      await api<{ plan: ComparisonPlan }>(request, '/api/analyze-comparison', {
        comparisonId: comparison.id,
        expectedUpdatedAt: comparison.updatedAt,
        requestId: randomUUID(),
      })
    ).plan;
    comparison = await api<ComparisonPlan>(
      request,
      `/api/comparisons/${comparison.id}`,
      {
        expectedUpdatedAt: comparison.updatedAt,
        analysis: { ...comparison.analysis!, coreDifferences: ['RC 人工对比结论；保留来源和历史'] },
      },
      'PATCH',
    );
    template = await api<AITemplate>(request, '/api/templates', {
      ...templateDefinition(builtinTemplates[0]!),
      name: 'RC 备份自定义模板（合成）',
    });
    template = await api<AITemplate>(
      request,
      `/api/templates/${template.id}`,
      {
        expectedUpdatedAt: template.updatedAt,
        definition: {
          ...templateDefinition(template),
          description: 'RC 人工模板改动；两份版本必须保留',
        },
      },
      'PATCH',
    );
    plan = await api<ContentPlan>(request, '/api/content-plans', {
      name: 'RC 全资料恢复方案（合成）',
      productId: product.id,
      templateId: template.id,
      comparisonId: comparison.id,
      options: { ...DEFAULT_CONTENT_OPTIONS, market: 'JP', language: 'ja', duration: 45 },
    });
    plan = await api<ContentPlan>(
      request,
      `/api/content-plans/${plan.id}`,
      {
        expectedUpdatedAt: plan.updatedAt,
        selectedMedia: [{ kind: 'image', url: product.images[0] }],
      },
      'PATCH',
    );
    const first = await api<ContentGenerationResponse>(request, '/api/generate-content', {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      requestId: randomUUID(),
    });
    expect(first.version.metadata?.mode).toBe('mock');
    expect(first.version.metadata?.evidence.reviewTextAnalyzed).toBe(false);
    plan = await api<ContentPlan>(
      request,
      `/api/content-plans/${plan.id}`,
      {
        expectedUpdatedAt: first.plan.updatedAt,
        output: { ...first.version.output, voiceover: ['RC 人工口播；备份恢复和重新生成不得覆盖'] },
        status: 'completed',
        favorite: true,
      },
      'PATCH',
    );
    const currentVersionId = plan.currentVersionId;
    const regenerateInput = {
      planId: plan.id,
      expectedUpdatedAt: plan.updatedAt,
      options: plan.options,
      selectedFields: ['hooks'],
      requestId: randomUUID(),
    };
    plan = (await api<ContentGenerationResponse>(request, '/api/generate-content', regenerateInput))
      .plan;
    expect(plan.currentVersionId).toBe(currentVersionId);
    expect(plan.versions).toHaveLength(3);
    expect(plan.versions.at(-1)?.metadata?.productAnalysisReference?.productId).toBe(product.id);

    const fullBackup = parseWorkspaceBackup(await api(request, '/api/workspace-backup'));
    const ownedRequests = fullBackup.usage.filter((record) =>
      [product.id, `comparison:${comparison!.id}`, `content:${plan!.id}`].includes(
        record.productId,
      ),
    );
    // Only restore this test's records: never delete or replace another test's local library.
    const backup: WorkspaceBackup = parseWorkspaceBackup({
      ...fullBackup,
      library: {
        products: fullBackup.library.products.filter((item) => productIds.includes(item.id)),
        groups: fullBackup.library.groups.filter((item) => item.id === group.id),
        tags: fullBackup.library.tags.filter((item) => item.id === tag.id),
      },
      comparisons: [comparison],
      templates: [template],
      contentPlans: [plan],
      usage: ownedRequests,
    });
    expect(ownedRequests).toHaveLength(4);
    expect(backup.library.products.find((item) => item.id === product.id)).toEqual(product);
    expect(product.analysisHistory).toHaveLength(2);
    expect(comparison.analysisHistory).toHaveLength(2);
    expect(template.versions).toHaveLength(2);
    const beforeRestore = structuredClone(backup);
    for (const [kind, item] of [
      ['content-plans', plan],
      ['comparisons', comparison],
      ['templates', template],
    ] as const)
      await api(
        request,
        `/api/${kind}/${item.id}`,
        {
          confirmed: true,
          expectedUpdatedAt: item.updatedAt,
        },
        'DELETE',
      );
    await api(request, `/api/products/${product.id}`, undefined, 'DELETE');
    for (const definition of definitions)
      await api(request, '/api/library', { ...definition, action: 'delete', confirmed: true });
    const preview = await api<{ preview: WorkspaceBackupPreview }>(
      request,
      '/api/workspace-backup',
      { backup },
    );
    const updatedPeer = await api<Product>(request, '/api/products', {
      ...draft(peer.sourceId),
      title: 'RC 本机较新资料必须保留',
      price: '$35.00',
    });
    const stale = await request.post(`${base}/api/workspace-backup`, {
      headers,
      data: {
        backup,
        commit: true,
        confirmed: true,
        policy: 'preserve',
        expectedRevision: preview.preview.revision,
      },
    });
    expect(stale.status()).toBe(409);
    expect(await api<Product>(request, `/api/products/${peer.id}`)).toEqual(updatedPeer);
    expect((await request.get(`${base}/api/content-plans/${plan.id}`, { headers })).status()).toBe(
      404,
    );
    const refreshed = await api<{ preview: WorkspaceBackupPreview }>(
      request,
      '/api/workspace-backup',
      { backup },
    );
    const restored = await api<{ committed: boolean; imported: number; skipped: number }>(
      request,
      '/api/workspace-backup',
      {
        backup,
        commit: true,
        confirmed: true,
        policy: 'preserve',
        expectedRevision: refreshed.preview.revision,
      },
    );
    expect(restored.committed).toBe(true);
    expect(restored.imported).toBe(6);
    expect(restored.skipped).toBe(5);
    expect(await api<Product>(request, `/api/products/${product.id}`)).toEqual(product);
    expect(await api<Product>(request, `/api/products/${peer.id}`)).toEqual(updatedPeer);
    expect(await api<ComparisonPlan>(request, `/api/comparisons/${comparison.id}`)).toEqual(
      comparison,
    );
    expect(await api<AITemplate>(request, `/api/templates/${template.id}`)).toEqual(template);
    expect(await api<ContentPlan>(request, `/api/content-plans/${plan.id}`)).toEqual(plan);
    const after = parseWorkspaceBackup(await api(request, '/api/workspace-backup'));
    expect(after.library.groups.find((item) => item.id === group.id)).toEqual(group);
    expect(after.library.tags.find((item) => item.id === tag.id)).toEqual(tag);
    expect(
      after.usage.filter((record) =>
        ownedRequests.some((old) => old.requestId === record.requestId),
      ),
    ).toEqual(ownedRequests);
    const replay = await api<ContentGenerationResponse>(
      request,
      '/api/generate-content',
      regenerateInput,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.plan).toEqual(plan);
    expect(beforeRestore.contentPlans[0]).toEqual(replay.plan);

    await page.goto(`/content?plan=${plan.id}`);
    await page.reload();
    await expect(
      page.getByText('RC 人工口播；备份恢复和重新生成不得覆盖', { exact: true }),
    ).toBeVisible();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出内容包 ZIP', exact: true }).click();
    const download = await downloadEvent;
    const saved = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(saved);
    const zip = await JSZip.loadAsync(await readFile(saved), { checkCRC32: true });
    expect(Object.keys(zip.files).every((path) => !/\.\.|\\|^\//.test(path))).toBe(true);
    expect(Object.keys(zip.files).some((path) => /\.(mp4|webm|jpg|png)$/i.test(path))).toBe(false);
    const jsonPath = Object.keys(zip.files).find((path) => path.endsWith('.json'))!;
    const exported = JSON.parse(await zip.file(jsonPath)!.async('string')) as {
      product: Product;
      metadata: { mode: string; selectedMedia: unknown[] };
      output: { voiceover: string[] };
    };
    expect(exported.product.id).toBe(product.id);
    expect(exported.product.sourceId).toBe(product.sourceId);
    expect(exported.metadata.mode).toBe('mock');
    expect(exported.metadata.selectedMedia).toEqual(plan.selectedMedia);
    expect(exported.output.voiceover).toEqual(['RC 人工口播；备份恢复和重新生成不得覆盖']);
  } finally {
    for (const [kind, item] of [
      ['content-plans', plan],
      ['comparisons', comparison],
      ['templates', template],
    ] as const)
      if (item) {
        const response = await request.get(`${base}/api/${kind}/${item.id}`, { headers });
        if (response.status() === 200) {
          const current = ((await response.json()) as { data: { updatedAt: string } }).data;
          await api(
            request,
            `/api/${kind}/${item.id}`,
            { confirmed: true, expectedUpdatedAt: current.updatedAt },
            'DELETE',
          );
        } else expect(response.status()).toBe(404);
      }
    for (const id of productIds) await api(request, `/api/products/${id}`, undefined, 'DELETE');
    const library = await api<LibrarySnapshot>(request, '/api/library');
    for (const definition of definitions)
      if (
        (definition.kind === 'group' ? library.groups : library.tags).some(
          (item) => item.id === definition.id,
        )
      )
        await api(request, '/api/library', { ...definition, action: 'delete', confirmed: true });
  }
});

test('RC backup authentication and strict import reject private fields and unsafe snapshot URLs without changing any business file', async ({
  request,
  playwright,
}) => {
  const original = parseWorkspaceBackup(await api(request, '/api/workspace-backup'));
  const snapshot = { ...original, exportedAt: '2026-01-01T00:00:00.000Z' };
  for (const backup of [
    { ...original, apiKey: 'synthetic-private-field-must-be-rejected' },
    { ...original, schemaVersion: 999 },
    {
      ...original,
      contentPlans: [{ id: randomUUID(), productSnapshot: { url: 'http://127.0.0.1/private' } }],
    },
  ]) {
    const response = await request.post(`${base}/api/workspace-backup`, {
      headers,
      data: { backup },
    });
    expect(response.status()).toBe(400);
    expect({
      ...parseWorkspaceBackup(await api(request, '/api/workspace-backup')),
      exportedAt: snapshot.exportedAt,
    }).toEqual(snapshot);
  }
  const foreign = await request.post(`${base}/api/workspace-backup`, {
    headers: { ...headers, Origin: 'https://evil.example' },
    data: { backup: original },
  });
  expect(foreign.status()).toBe(403);
  // Playwright Test applies the worker's trusted storageState to new request contexts.
  // Override it explicitly so this test actually sends an unauthenticated request.
  const anonymous = await playwright.request.newContext({
    storageState: { cookies: [], origins: [] },
  });
  try {
    expect((await anonymous.storageState()).cookies).toEqual([]);
    for (const path of [
      '/api/workspace-backup',
      '/api/history?kind=content&id=missing',
      '/api/analysis-usage',
    ])
      expect((await anonymous.get(`${base}${path}`, { headers })).status()).toBe(401);
    expect((await anonymous.storageState()).cookies).toEqual([]);
  } finally {
    await anonymous.dispose();
  }
  expect({
    ...parseWorkspaceBackup(await api(request, '/api/workspace-backup')),
    exportedAt: snapshot.exportedAt,
  }).toEqual(snapshot);
});
