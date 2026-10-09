import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Product } from '../packages/shared/src/types';
import { libraryFixtures } from './library-fixtures';
import type {
  LibraryExportFile,
  LibraryImportPreview,
  LibraryImportResult,
} from '../packages/shared/src/library-transfer';

const BASE = 'http://127.0.0.1:3000';
const headers = {
  Origin: BASE,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
interface Snapshot {
  products: Product[];
  groups: { id: string; name: string; color: string }[];
  tags: { id: string; name: string; color: string }[];
  revision?: string;
}
async function auth(request: APIRequestContext) {
  expect((await request.post(`${BASE}/api/session`, { headers, data: {} })).ok()).toBe(true);
}
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${BASE}${path}`, { headers, data });
  const body = (await response.json()) as { ok: boolean; data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  expect(body.ok).toBe(true);
  return body.data;
}
async function snapshot(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get(`${BASE}/api/library`, { headers });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { data: Snapshot }).data;
}
async function clean(
  request: APIRequestContext,
  ids: string[],
  definitions: { kind: string; id: string }[],
) {
  for (const id of ids)
    await request.delete(`${BASE}/api/products/${encodeURIComponent(id)}`, { headers });
  for (const definition of definitions)
    await request.post(`${BASE}/api/library`, {
      headers,
      data: { ...definition, action: 'delete', confirmed: true },
    });
}

test('library memberships persist, recapture retains history and stale batch items fail individually', async ({
  request,
  page,
}) => {
  await auth(request);
  const products: Product[] = [];
  const definitions: { kind: string; id: string }[] = [];
  try {
    for (const fixture of libraryFixtures(2, 'B13E'))
      products.push(await post<Product>(request, '/api/products', fixture));
    const first = products[0];
    await post(request, '/api/analyze-product', first);
    let state = await snapshot(request);
    const analyzed = state.products.find((product) => product.id === first.id)!;
    expect(analyzed.analysisHistory!.length).toBeGreaterThan(0);
    state = await post<Snapshot>(request, '/api/library', {
      kind: 'group',
      action: 'create',
      name: '验收研究组',
      color: '#0f766e',
    });
    const group = state.groups.find((entry) => entry.name === '验收研究组')!;
    definitions.push({ kind: 'group', id: group.id });
    state = await post<Snapshot>(request, '/api/library', {
      kind: 'tag',
      action: 'create',
      name: '验收待核验',
      color: '#b45309',
    });
    const tag = state.tags.find((entry) => entry.name === '验收待核验')!;
    definitions.push({ kind: 'tag', id: tag.id });
    await post(request, '/api/library/batch', {
      ids: products.map((product) => product.id),
      operation: 'add-groups',
      groupIds: [group.id],
    });
    await post(request, '/api/library/batch', {
      ids: products.map((product) => product.id),
      operation: 'add-tags',
      tagIds: [tag.id],
    });
    state = await snapshot(request);
    const grouped = state.products.find((product) => product.id === first.id)!;
    expect(grouped.aiAnalysis).toEqual(analyzed.aiAnalysis);
    expect(grouped.analysisHistory).toEqual(analyzed.analysisHistory);
    const updated = await post<Product>(request, '/api/products', { ...first, price: '$99.00' });
    expect(updated.id).toBe(first.id);
    expect(updated.groupIds).toEqual([group.id]);
    expect(updated.tagIds).toEqual([tag.id]);
    expect(updated.analysisHistory).toEqual(analyzed.analysisHistory);
    const result = await post<{
      succeededIds: string[];
      failures: { id: string; error: string }[];
    }>(request, '/api/library/batch', {
      ids: [first.id, products[1].id, 'missing-product'],
      operation: 'add-tags',
      tagIds: [tag.id],
      expectedUpdatedAt: {
        [first.id]: grouped.updatedAt,
        [products[1].id]: state.products.find((product) => product.id === products[1].id)!
          .updatedAt,
      },
    });
    expect(result.succeededIds).toEqual([products[1].id]);
    expect(new Set(result.failures.map((failure) => failure.id))).toEqual(
      new Set([first.id, 'missing-product']),
    );
    await page.goto(`${BASE}/products`);
    await page.reload();
    await expect(page.locator('.ws-product-card').filter({ hasText: first.title })).toContainText(
      '验收待核验',
    );
    const unconfirmed = await request.post(`${BASE}/api/library/batch`, {
      headers,
      data: { ids: [first.id], operation: 'delete' },
    });
    expect(unconfirmed.status()).toBe(400);
    expect((await snapshot(request)).products.some((product) => product.id === first.id)).toBe(
      true,
    );
    await post(request, '/api/library', {
      kind: 'group',
      action: 'rename',
      id: group.id,
      name: '验收已重命名',
      color: '#1d4ed8',
    });
    await post(request, '/api/library', {
      kind: 'group',
      action: 'delete',
      id: group.id,
      confirmed: true,
    });
    const final = (await snapshot(request)).products.find((product) => product.id === first.id)!;
    expect(final.groupIds ?? []).toEqual([]);
    expect(final.analysisHistory).toEqual(analyzed.analysisHistory);
    expect(final.tagIds).toEqual([tag.id]);
  } finally {
    await clean(
      request,
      products.map((product) => product.id),
      definitions,
    );
  }
});

test('backup roundtrip preserves complete histories; duplicate import, stale preview and malicious URLs never overwrite', async ({
  request,
}) => {
  await auth(request);
  const fixtures = libraryFixtures(2, 'B13R');
  const ids = fixtures.map((product) => product.id);
  try {
    const preview = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: fixtures,
    });
    const imported = await post<LibraryImportResult>(request, '/api/library/import', {
      action: 'commit',
      data: fixtures,
      policy: 'skip',
      confirmed: true,
      expectedRevision: preview.revision,
    });
    expect(imported.imported).toBe(2);
    const fileResponse = await request.get(
      `${BASE}/api/library/export?format=json&${ids.map((id) => `id=${encodeURIComponent(id)}`).join('&')}`,
      { headers },
    );
    expect(fileResponse.ok()).toBe(true);
    const exported = ((await fileResponse.json()) as { data: LibraryExportFile }).data;
    const backup = JSON.parse(exported.content) as { products: Product[] };
    expect(backup.products).toEqual(expect.arrayContaining(fixtures));
    expect(exported.content).not.toMatch(/tokenHash|AI_API_KEY|productspy_session/);
    const changed = structuredClone(fixtures);
    changed[0].aiAnalysis!.summary = '恶意尝试覆盖已有人工摘要';
    const conflict = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: changed,
    });
    expect(conflict.conflicts).toHaveLength(2);
    const kept = await post<LibraryImportResult>(request, '/api/library/import', {
      action: 'commit',
      data: changed,
      policy: 'preserve',
      confirmed: true,
      expectedRevision: conflict.revision,
    });
    expect(kept.imported).toBe(0);
    expect(kept.skipped).toBe(2);
    expect((await snapshot(request)).products.find((product) => product.id === ids[0])).toEqual(
      fixtures[0],
    );
    const stale = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: backup,
    });
    await post(request, '/api/products', { ...fixtures[1], price: '$88.00' });
    const denied = await request.post(`${BASE}/api/library/import`, {
      headers,
      data: {
        action: 'commit',
        data: backup,
        policy: 'skip',
        confirmed: true,
        expectedRevision: stale.revision,
      },
    });
    expect(denied.status()).toBe(409);
    const malformed = await request.post(`${BASE}/api/library/import`, {
      headers,
      data: {
        action: 'preview',
        data: [{ ...fixtures[0], mainImage: 'http://127.0.0.1/private' }],
      },
    });
    expect(malformed.status()).toBe(400);
    const beforeDelete = (await snapshot(request)).products.find(
      (product) => product.id === ids[0],
    )!;
    await post(request, '/api/library/batch', {
      ids: [ids[0]],
      operation: 'delete',
      confirmed: true,
      expectedUpdatedAt: { [ids[0]]: beforeDelete.updatedAt },
    });
    const restore = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: backup,
    });
    const restored = await post<LibraryImportResult>(request, '/api/library/import', {
      action: 'commit',
      data: backup,
      policy: 'skip',
      confirmed: true,
      expectedRevision: restore.revision,
    });
    expect(restored.imported).toBe(1);
    expect(restored.skipped).toBe(1);
    const final = await snapshot(request);
    expect(final.products.find((product) => product.id === ids[0])).toEqual(fixtures[0]);
    expect(final.products.find((product) => product.id === ids[1])?.price).toBe('$88.00');
  } finally {
    await clean(request, ids, []);
  }
});

test('library multi-selection requires destructive confirmation and exports full selected products', async ({
  page,
  request,
}) => {
  await auth(request);
  const fixtures = libraryFixtures(2, 'B13U');
  const ids = fixtures.map((product) => product.id);
  try {
    const preview = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: fixtures,
    });
    await post(request, '/api/library/import', {
      action: 'commit',
      data: fixtures,
      policy: 'skip',
      confirmed: true,
      expectedRevision: preview.revision,
    });
    await page.goto(`${BASE}/products`);
    await expect(page.locator('.ws-product-card')).toHaveCount(2);
    await page.getByRole('button', { name: '多选商品', exact: true }).click();
    await page.getByRole('button', { name: '选择本页', exact: true }).click();
    await page.getByLabel('导出所选商品', { exact: true }).selectOption('json');
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await page.getByLabel('批量操作', { exact: true }).selectOption('delete');
    await page.getByRole('button', { name: '执行所选操作', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量删除商品？', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    expect(
      (await snapshot(request)).products.filter((product) => ids.includes(product.id)),
    ).toHaveLength(2);
    await page.getByRole('button', { name: '执行所选操作', exact: true }).click();
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByText('成功 2 项，失败 0 项', { exact: false })).toBeVisible();
    expect(
      (await snapshot(request)).products.filter((product) => ids.includes(product.id)),
    ).toHaveLength(0);
  } finally {
    await clean(request, ids, []);
  }
});

test('bulk delete confirmation freezes the reviewed revision despite background polling', async ({
  page,
  request,
}) => {
  await auth(request);
  const fixture = libraryFixtures(1, 'B13C')[0];
  try {
    const preview = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: [fixture],
    });
    await post(request, '/api/library/import', {
      action: 'commit',
      data: [fixture],
      policy: 'skip',
      confirmed: true,
      expectedRevision: preview.revision,
    });
    await page.goto(`${BASE}/products`);
    await page.getByRole('button', { name: '多选商品', exact: true }).click();
    await page.getByLabel(`选择商品 ${fixture.title}`, { exact: true }).check();
    await page.getByLabel('批量操作', { exact: true }).selectOption('delete');
    await page.getByRole('button', { name: '执行所选操作', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '确认批量删除商品？', exact: true });
    await expect(dialog).toBeVisible();
    await post(request, '/api/products', { ...fixture, price: '$77.00' });
    // Wait for the real five-second poll to observe the new product while confirmation stays open.
    const response = await page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/library') && response.request().method() === 'GET',
    );
    expect(response.ok()).toBe(true);
    await expect(page.locator('.ws-product-card').filter({ hasText: fixture.title })).toContainText(
      '$77.00',
    );
    await dialog.getByRole('button', { name: '确认执行', exact: true }).click();
    await expect(page.getByText('成功 0 项，失败 1 项', { exact: false })).toBeVisible();
    const remaining = (await snapshot(request)).products.find(
      (product) => product.id === fixture.id,
    )!;
    expect(remaining.price).toBe('$77.00');
    expect(remaining.analysisHistory).toEqual(fixture.analysisHistory);
  } finally {
    await clean(request, [fixture.id], []);
  }
});

test('group/tag manager creates, renames, recolors and confirms deletion without deleting products', async ({
  page,
  request,
}) => {
  await auth(request);
  const product = await post<Product>(request, '/api/products', libraryFixtures(1, 'B13M')[0]);
  const definitions: { kind: string; id: string }[] = [];
  try {
    await page.goto(`${BASE}/products`);
    await page.getByRole('button', { name: '管理分组与标签', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '管理分组与标签', exact: true });
    await dialog.getByLabel('分组名称', { exact: true }).fill('用户创建研究组');
    await dialog.getByLabel('分组颜色', { exact: true }).fill('#335577');
    await dialog.getByRole('button', { name: '创建分组', exact: true }).click();
    await expect(dialog.getByText('分组已创建。', { exact: true })).toBeVisible();
    const group = (await snapshot(request)).groups.find((item) => item.name === '用户创建研究组')!;
    definitions.push({ kind: 'group', id: group.id });
    expect(group.color).toBe('#335577');
    await dialog.getByRole('button', { name: '修改分组 用户创建研究组', exact: true }).click();
    await dialog.getByLabel('分组名称', { exact: true }).fill('用户修改研究组');
    await dialog.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect(dialog.getByText('分组已修改。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '商品标签', exact: true }).click();
    await dialog.getByLabel('标签名称', { exact: true }).fill('素材待核验');
    await dialog.getByLabel('标签颜色', { exact: true }).fill('#bb6633');
    await dialog.getByRole('button', { name: '创建标签', exact: true }).click();
    await expect(dialog.getByText('标签已创建。', { exact: true })).toBeVisible();
    const tag = (await snapshot(request)).tags.find((item) => item.name === '素材待核验')!;
    definitions.push({ kind: 'tag', id: tag.id });
    expect(tag.color).toBe('#bb6633');
    await dialog.getByRole('button', { name: '删除标签 素材待核验', exact: true }).click();
    await expect(dialog.getByRole('group', { name: '确认删除标签', exact: true })).toBeVisible();
    expect((await snapshot(request)).tags.some((item) => item.id === tag.id)).toBe(true);
    await dialog.getByRole('button', { name: '确认删除标签', exact: true }).click();
    await expect(dialog.getByText('标签已删除，商品资料仍保留。', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭窗口', exact: true }).click();
    await page.reload();
    const state = await snapshot(request);
    expect(state.groups.find((item) => item.id === group.id)?.name).toBe('用户修改研究组');
    expect(state.products.find((item) => item.id === product.id)).toEqual(product);
  } finally {
    await clean(request, [product.id], definitions);
  }
});

test('externally deleted selection stays cleared when the same ASIN is captured again', async ({
  page,
  request,
}) => {
  await auth(request);
  const fixture = libraryFixtures(1, 'B13S')[0];
  await post(request, '/api/products', fixture);
  try {
    await page.goto(`${BASE}/products`);
    await page.getByRole('button', { name: '多选商品', exact: true }).click();
    await page.getByLabel(`选择商品 ${fixture.title}`, { exact: true }).check();
    await request.delete(`${BASE}/api/products/${encodeURIComponent(fixture.id)}`, { headers });
    await expect(
      page.getByText('已移除 1 个不再存在的商品选择；其余选择保留。', { exact: true }),
    ).toBeVisible();
    await post(request, '/api/products', fixture);
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(page.getByLabel(`选择商品 ${fixture.title}`, { exact: true })).not.toBeChecked();
    await expect(page.getByText('已选择 0 个商品', { exact: true })).toBeVisible();
  } finally {
    await clean(request, [fixture.id], []);
  }
});
