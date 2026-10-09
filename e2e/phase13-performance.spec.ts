import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LibrarySnapshot, LibraryDefinition } from '../packages/shared/src/types';
import type {
  LibraryExportFile,
  LibraryImportPreview,
  LibraryImportResult,
} from '../packages/shared/src/library-transfer';
import { libraryFixtures } from './library-fixtures';

const BASE = 'http://127.0.0.1:3000';
const headers = {
  Origin: BASE,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
async function post<T>(request: APIRequestContext, path: string, data: unknown): Promise<T> {
  const response = await request.post(`${BASE}${path}`, { headers, data });
  const body = (await response.json()) as { data: T; error?: string };
  expect(response.status(), body.error).toBe(200);
  return body.data;
}
async function library(request: APIRequestContext): Promise<LibrarySnapshot> {
  const response = await request.get(`${BASE}/api/library`, { headers });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { data: LibrarySnapshot }).data;
}
function median(values: number[]) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

test('synthetic library benchmark: 100 and 500 products, bounded DOM, filters, bulk update, backup and screenshots', async ({
  page,
  request,
}) => {
  test.setTimeout(180000);
  await post(request, '/api/session', {});
  const fixtures = libraryFixtures(500);
  const ids = fixtures.map((product) => product.id);
  const definitions: { kind: 'group' | 'tag'; id: string }[] = [];
  const output = resolve(
    '.test-data/phase13-performance',
    new Date().toISOString().replace(/[:.]/g, '-'),
  );
  const shots = resolve('artifacts/ProductSpy-0.5.0-library-experience');
  await mkdir(output, { recursive: true });
  await mkdir(shots, { recursive: true });
  const metrics: {
    count: number;
    importMs: number;
    apiMedianMs: number;
    apiMaxMs: number;
    renderMs: number;
    filterMs: number;
    pageChangeMs: number;
    renderedCards: number;
    batchMs?: number;
    backupMs?: number;
    backupBytes?: number;
    restoreMs?: number;
  }[] = [];
  const screenshots: {
    file: string;
    width: number;
    height: number;
    sha256: string;
    synthetic: true;
  }[] = [];
  async function screenshot(file: string, width = 1440, height = 960) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    );
    const path = resolve(shots, file);
    await page.screenshot({ path });
    screenshots.push({
      file,
      width,
      height,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
      synthetic: true,
    });
  }
  let passed = false;
  try {
    let state = await post<LibrarySnapshot>(request, '/api/library', {
      kind: 'group',
      action: 'create',
      name: '性能验收分组',
      color: '#0f766e',
    });
    const group: LibraryDefinition = state.groups.find((item) => item.name === '性能验收分组')!;
    definitions.push({ kind: 'group', id: group.id });
    state = await post<LibrarySnapshot>(request, '/api/library', {
      kind: 'tag',
      action: 'create',
      name: '合成测试标签',
      color: '#b45309',
    });
    const tag = state.tags.find((item) => item.name === '合成测试标签')!;
    definitions.push({ kind: 'tag', id: tag.id });
    fixtures.forEach((product) => {
      product.groupIds = [group.id];
      if (Number(product.sourceId.slice(4)) % 2 === 0) product.tagIds = [tag.id];
    });
    for (const count of [100, 500]) {
      const data = {
        format: 'productspy-library',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        products: fixtures.slice(0, count),
        groups: [group],
        tags: [tag],
      };
      const importStart = performance.now();
      const preview = await post<LibraryImportPreview>(request, '/api/library/import', {
        action: 'preview',
        data,
      });
      const imported = await post<LibraryImportResult>(request, '/api/library/import', {
        action: 'commit',
        data,
        policy: 'skip',
        confirmed: true,
        expectedRevision: preview.revision,
      });
      expect(imported.imported).toBe(count === 100 ? 100 : 400);
      const importMs = performance.now() - importStart;
      const reads: number[] = [];
      for (let sample = 0; sample < 5; sample++) {
        const start = performance.now();
        const current = await library(request);
        expect(current.products.filter((product) => ids.includes(product.id))).toHaveLength(count);
        reads.push(performance.now() - start);
      }
      const renderStart = performance.now();
      await page.goto(`${BASE}/products`);
      await expect(page.locator('.ws-product-card')).toHaveCount(36);
      const renderMs = performance.now() - renderStart;
      const filterStart = performance.now();
      await page.getByLabel('搜索商品', { exact: true }).fill('厨房');
      await expect(page.locator('.ws-product-card')).toHaveCount(Math.min(36, count / 5));
      const filterMs = performance.now() - filterStart;
      await page.getByLabel('筛选分组', { exact: true }).selectOption(group.id);
      await page.getByLabel('筛选标签', { exact: true }).selectOption(tag.id);
      await page.getByLabel('筛选分析状态', { exact: true }).selectOption('pending');
      await expect(page.locator('.ws-product-card')).toHaveCount(Math.min(36, count / 10));
      await screenshot(`0${count === 100 ? '1' : '2'}-${count}-products-filtered.png`);
      await page.getByRole('button', { name: '清除筛选', exact: true }).click();
      const pageStart = performance.now();
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(page.getByText(new RegExp(`第 2 / ${Math.ceil(count / 36)} 页`))).toBeVisible();
      const pageChangeMs = performance.now() - pageStart;
      await page.getByRole('button', { name: '上一页', exact: true }).click();
      await screenshot(`0${count === 100 ? '3' : '4'}-${count}-products-grid.png`);
      metrics.push({
        count,
        importMs,
        apiMedianMs: median(reads),
        apiMaxMs: Math.max(...reads),
        renderMs,
        filterMs,
        pageChangeMs,
        renderedCards: await page.locator('.ws-product-card').count(),
      });
      expect(renderMs).toBeLessThan(10000);
      expect(filterMs).toBeLessThan(5000);
      expect(Math.max(...reads)).toBeLessThan(5000);
    }
    await page.getByRole('button', { name: '多选商品', exact: true }).click();
    await page.getByRole('button', { name: '选择全部筛选结果', exact: true }).click();
    await expect(page.getByText('已选择 500 个商品', { exact: true })).toBeVisible();
    await page.getByLabel('批量操作', { exact: true }).selectOption('add-tags');
    await page.getByLabel('选择标签', { exact: true }).selectOption(tag.id);
    await screenshot('05-500-bulk-selection.png');
    const batchStart = performance.now();
    await page.getByRole('button', { name: '执行所选操作', exact: true }).click();
    await expect(page.getByText('成功 500 项，失败 0 项', { exact: false })).toBeVisible();
    metrics[1].batchMs = performance.now() - batchStart;
    const current = await library(request);
    expect(
      current.products.filter(
        (product) => ids.includes(product.id) && product.tagIds?.includes(tag.id),
      ),
    ).toHaveLength(500);
    const original = fixtures[0];
    const retained = current.products.find((product) => product.id === original.id)!;
    expect(retained.aiAnalysis).toEqual(original.aiAnalysis);
    expect(retained.analysisHistory).toEqual(original.analysisHistory);
    for (const fixture of fixtures.filter((product) => product.aiAnalysis)) {
      const saved = current.products.find((product) => product.id === fixture.id)!;
      expect(saved.aiAnalysis).toEqual(fixture.aiAnalysis);
      expect(saved.analysisHistory).toEqual(fixture.analysisHistory);
    }
    const backupStart = performance.now();
    const backup = await post<LibraryExportFile>(request, '/api/library/export', {
      format: 'json',
      ids,
    });
    metrics[1].backupMs = performance.now() - backupStart;
    metrics[1].backupBytes = new TextEncoder().encode(backup.content).byteLength;
    expect((JSON.parse(backup.content) as { products: unknown[] }).products).toHaveLength(500);
    await page.getByRole('button', { name: '退出多选', exact: true }).click();
    await page.getByRole('button', { name: '管理分组与标签', exact: true }).click();
    await screenshot('06-group-tag-management.png');
    await page.getByRole('dialog').getByRole('button', { name: '关闭窗口', exact: true }).click();
    await page.getByRole('button', { name: '导入与备份', exact: true }).click();
    await page.getByLabel('选择 JSON 文件', { exact: true }).setInputFiles({
      name: 'synthetic-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backup.content),
    });
    await page.getByRole('button', { name: '验证并预览', exact: true }).click();
    await expect(
      page.getByText('文件共 500 个商品 · 可新增 0 个 · 重复 500 个', { exact: true }),
    ).toBeVisible();
    await screenshot('07-backup-conflict-preview.png');
    await page.getByRole('button', { name: '取消导入', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: '关闭窗口', exact: true }).click();
    await screenshot('08-library-mobile.png', 375, 812);
    await page.getByRole('button', { name: '多选商品', exact: true }).click();
    await page.getByRole('button', { name: '选择本页', exact: true }).click();
    await screenshot('09-library-mobile-selection.png', 375, 812);
    const restoreStart = performance.now();
    const deleted = await post<{ succeededIds: string[] }>(request, '/api/library/batch', {
      ids,
      operation: 'delete',
      confirmed: true,
    });
    expect(deleted.succeededIds).toHaveLength(500);
    const backupData = JSON.parse(backup.content) as { products: unknown[] };
    const restorePreview = await post<LibraryImportPreview>(request, '/api/library/import', {
      action: 'preview',
      data: backupData,
    });
    const restored = await post<LibraryImportResult>(request, '/api/library/import', {
      action: 'commit',
      data: backupData,
      policy: 'skip',
      confirmed: true,
      expectedRevision: restorePreview.revision,
    });
    expect(restored.imported).toBe(500);
    expect((await library(request)).products.filter((product) => ids.includes(product.id))).toEqual(
      backupData.products,
    );
    metrics[1].restoreMs = performance.now() - restoreStart;
    passed = true;
  } finally {
    // Synthetic benchmark data is confined to the E2E server's fresh isolated directory.
    for (let offset = 0; offset < ids.length; offset += 500)
      await post(request, '/api/library/batch', {
        ids: ids.slice(offset, offset + 500),
        operation: 'delete',
        confirmed: true,
      }).catch(() => undefined);
    for (const definition of definitions)
      await post(request, '/api/library', {
        ...definition,
        action: 'delete',
        confirmed: true,
      }).catch(() => undefined);
    const report = {
      schemaVersion: 1,
      version: '0.5.0',
      capturedAt: new Date().toISOString(),
      passed,
      synthetic: true,
      realAmazonProductsTested: 0,
      externalAiRequests: 0,
      browser: 'Playwright Chromium / Chrome for Testing; not installed Chrome stable',
      browserVersion: page.context().browser()?.version(),
      sampleScope:
        '500 basic products, 50 complete synthetic analyses/history; not maximum-size histories',
      metrics,
      screenshots,
    };
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
    await writeFile(resolve(shots, 'provenance.json'), JSON.stringify(report, null, 2));
    console.log(`Phase13 synthetic performance report: ${resolve(output, 'report.json')}`);
  }
});
