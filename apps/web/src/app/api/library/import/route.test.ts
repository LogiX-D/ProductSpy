import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LIBRARY_IMPORT_BYTES,
  serializeLibraryBackup,
  type ApiResult,
  type LibraryExportFile,
  type LibraryImportPreview,
  type LibraryImportResult,
  type LibrarySnapshot,
  type Product,
  type ProductAnalysis,
} from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { GET as exportGet, POST as exportPost } from '../export/route';
import { POST as capture } from '../../products/route';
import { getProductRepository } from '../../../../lib/server/product-repository';
import { webHeaders } from '../../../../lib/server/test-auth';

const date = '2026-10-09T00:00:00.000Z';
const analysis: ProductAnalysis = {
  summary: '保留人工总结',
  sellingPoints: ['便携'],
  targetAudience: ['旅行者'],
  purchaseMotivations: ['方便'],
  painPoints: ['尺寸待核实'],
  strengths: ['便于携带'],
  weaknesses: ['容量未核实'],
  marketingAngles: ['旅行场景'],
  hooks: ['一', '二', '三', '四', '五'],
  shortVideoScript: 'Hook: 开场\nProblem: 问题\nSolution: 解决\nDemo: 演示\nCTA: 查看',
  imagePrompts: ['商品场景'],
  videoPrompts: ['商品演示'],
};
function product(index = 0, id?: string): Product {
  const asin = `B${index.toString().padStart(9, '0')}`;
  return {
    id: id ?? `amazon:${asin}`,
    source: 'amazon',
    sourceId: asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: '合成测试商品',
    images: ['https://m.media-amazon.com/images/I/test.jpg'],
    videos: [],
    bulletPoints: ['测试卖点'],
    createdAt: date,
    updatedAt: date,
    aiAnalysis: analysis,
    analysisHistory: [{ id: randomUUID(), createdAt: date, kind: 'edited', analysis }],
  };
}
function snapshot(products = [product()]): LibrarySnapshot {
  return { products, groups: [], tags: [] };
}
function file(value = snapshot()): unknown {
  return JSON.parse(serializeLibraryBackup(value)) as unknown;
}
function request(path: string, method = 'POST', body?: unknown): Request {
  return new Request(`http://localhost:3000/api/library/${path}`, {
    method,
    headers: webHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data<T>(response: Response): Promise<T> {
  const body = (await response.json()) as ApiResult<T>;
  if (!body.ok) throw new Error(`Unexpected ${response.status}: ${body.error}`);
  return body.data;
}
async function importFile(payload: unknown): Promise<LibraryImportResult> {
  const preview = await data<LibraryImportPreview>(
    await POST(request('import', 'POST', { action: 'preview', data: payload })),
  );
  return data<LibraryImportResult>(
    await POST(
      request('import', 'POST', {
        action: 'commit',
        data: payload,
        policy: 'skip',
        confirmed: true,
        expectedRevision: preview.revision,
      }),
    ),
  );
}

describe('protected library transfer API', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-transfer-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('previews without mutation, requires confirmation and restores complete analyses/history', async () => {
    const original = product();
    const input = file(snapshot([original]));
    const preview = await data<LibraryImportPreview>(
      await POST(request('import', 'POST', { action: 'preview', data: input })),
    );
    expect(preview).toMatchObject({ total: 1, newProducts: 1, conflicts: [] });
    expect(await getProductRepository().list()).toEqual([]);
    expect(
      (
        await POST(
          request('import', 'POST', {
            action: 'commit',
            data: input,
            policy: 'skip',
            expectedRevision: preview.revision,
          }),
        )
      ).status,
    ).toBe(428);
    expect(
      (
        await POST(
          request('import', 'POST', {
            action: 'commit',
            data: input,
            policy: 'skip',
            confirmed: true,
          }),
        )
      ).status,
    ).toBe(428);
    const imported = await data<LibraryImportResult>(
      await POST(
        request('import', 'POST', {
          action: 'commit',
          data: input,
          policy: 'skip',
          confirmed: true,
          expectedRevision: preview.revision,
        }),
      ),
    );
    expect(imported).toMatchObject({ total: 1, imported: 1, skipped: 0, failed: 0 });
    expect(await getProductRepository().get(original.id)).toEqual(original);
    const exported = await data<LibraryExportFile>(
      await exportGet(request('export?format=json', 'GET')),
    );
    expect((JSON.parse(exported.content) as { products: Product[] }).products).toEqual([original]);
    expect(exported.filename).toContain('backup');
  });
  it.each(['skip', 'preserve'])(
    'conflict policy %s never overwrites the original manual analysis/history',
    async (policy) => {
      const original = product();
      await importFile(file(snapshot([original])));
      const before = await readFile(join(directory, 'products.json'), 'utf8');
      const duplicate = {
        ...original,
        id: 'incoming-other-id',
        title: '企图覆盖',
        aiAnalysis: { ...analysis, summary: '导入新结果' },
        analysisHistory: [],
      };
      const incoming = file(snapshot([duplicate, product(1)]));
      const preview = await data<LibraryImportPreview>(
        await POST(request('import', 'POST', { action: 'preview', data: incoming })),
      );
      expect(preview.conflicts).toHaveLength(1);
      const result = await data<LibraryImportResult>(
        await POST(
          request('import', 'POST', {
            action: 'commit',
            data: incoming,
            policy,
            confirmed: true,
            expectedRevision: preview.revision,
          }),
        ),
      );
      expect(result).toMatchObject({ imported: 1, skipped: 1, failed: 0, total: 2 });
      expect(await getProductRepository().get(original.id)).toEqual(original);
      expect(before).toContain('保留人工总结');
    },
  );
  it('rejects a stale preview atomically after another page changes the library', async () => {
    const incoming = file();
    const preview = await data<LibraryImportPreview>(
      await POST(request('import', 'POST', { action: 'preview', data: incoming })),
    );
    await getProductRepository().manageDefinition({
      kind: 'tag',
      action: 'create',
      name: '其他页面新增',
    });
    const before = await readFile(join(directory, 'products.json'), 'utf8');
    const response = await POST(
      request('import', 'POST', {
        action: 'commit',
        data: incoming,
        policy: 'skip',
        confirmed: true,
        expectedRevision: preview.revision,
      }),
    );
    expect(response.status).toBe(409);
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(before);
    expect(await getProductRepository().list()).toEqual([]);
  });
  it('rejects corrupt structure, duplicate input and malicious URLs before any write', async () => {
    await importFile(file());
    const before = await readFile(join(directory, 'products.json'), 'utf8');
    for (const invalid of [
      { format: 'other', products: [] },
      [product(2), { source: 'amazon' }],
      [product(2), product(2)],
      [{ ...product(2), mainImage: 'https://127.0.0.1/private.jpg' }],
      [{ ...product(2), url: 'https://www.amazon.com/dp/B999999999' }],
    ]) {
      expect(
        (await POST(request('import', 'POST', { action: 'preview', data: invalid }))).status,
      ).toBe(400);
      expect(
        (
          await POST(
            request('import', 'POST', {
              action: 'commit',
              data: invalid,
              policy: 'skip',
              confirmed: true,
              expectedRevision: 'a'.repeat(64),
            }),
          )
        ).status,
      ).toBe(400);
    }
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(before);
  });
  it('allows a validated import over the old 1 MiB limit without enlarging capture limits', async () => {
    const products = Array.from({ length: 40 }, (_, i) => ({
      ...product(i),
      description: '合成'.repeat(10_000),
    }));
    const incoming = file(snapshot(products));
    expect(new TextEncoder().encode(JSON.stringify(incoming)).byteLength).toBeGreaterThan(
      1024 * 1024,
    );
    const response = await POST(request('import', 'POST', { action: 'preview', data: incoming }));
    expect(response.status).toBe(200);
    expect((await data<LibraryImportPreview>(response)).newProducts).toBe(40);
    expect(await getProductRepository().list()).toEqual([]);
    const oversizedCapture = new Request('http://localhost:3000/api/products', {
      method: 'POST',
      headers: webHeaders(),
      body: JSON.stringify({ text: 'a'.repeat(1024 * 1024) }),
    });
    expect((await capture(oversizedCapture)).status).toBe(413);
  });
  it('rejects oversized requests at the stream boundary', async () => {
    const oversized = new Request('http://localhost:3000/api/library/import', {
      method: 'POST',
      headers: { ...webHeaders(), 'content-length': String(MAX_LIBRARY_IMPORT_BYTES + 65 * 1024) },
      body: '{}',
    });
    expect((await POST(oversized)).status).toBe(413);
    expect(await getProductRepository().list()).toEqual([]);
  });
  it('backs up unused groups/tags and excludes pairing, AI configuration and usage files', async () => {
    await importFile(file());
    const library = getProductRepository();
    await library.manageDefinition({
      kind: 'group',
      action: 'create',
      name: '空分组',
      color: '#112233',
    });
    await library.manageDefinition({
      kind: 'tag',
      action: 'create',
      name: '空标签',
      color: '#445566',
    });
    await writeFile(
      join(directory, 'analysis-usage.json'),
      JSON.stringify({ private: 'usage-fixture-never-export' }),
    );
    await writeFile(
      join(directory, 'ai-settings.json'),
      JSON.stringify({ private: 'settings-fixture-never-export' }),
    );
    const exported = await data<LibraryExportFile>(
      await exportPost(request('export', 'POST', { format: 'json', ids: [] })),
    );
    expect(exported.content).toContain('空分组');
    expect(exported.content).toContain('空标签');
    expect(exported.content).not.toContain('usage-fixture');
    expect(exported.content).not.toContain('settings-fixture');
    const restored = await importFile(JSON.parse(exported.content) as unknown);
    expect(restored).toMatchObject({ imported: 0, skipped: 1, groupsAdded: 0, tagsAdded: 0 });
    expect((await library.librarySnapshot()).groups).toHaveLength(1);
  });
  it('exports CSV formulas safely and Markdown as inert text', async () => {
    await importFile(
      file(
        snapshot([
          {
            ...product(),
            title: '=HYPERLINK("evil")',
            aiAnalysis: { ...analysis, summary: '<script>unsafe</script>' },
          },
        ]),
      ),
    );
    const csv = await data<LibraryExportFile>(await exportGet(request('export?format=csv', 'GET')));
    expect(csv.content).toContain('"\'=HYPERLINK(""evil"")"');
    const markdown = await data<LibraryExportFile>(
      await exportPost(request('export', 'POST', { format: 'markdown', ids: [] })),
    );
    expect(markdown.content).toContain('&lt;script&gt;');
    expect(markdown.content).not.toContain('<script>');
  });
  it('exports 500 UUID selections via POST without an oversized URL or missing records', async () => {
    const products = Array.from({ length: 500 }, (_, i) => product(i, randomUUID()));
    await importFile(file(snapshot(products)));
    const exported = await data<LibraryExportFile>(
      await exportPost(
        request('export', 'POST', { format: 'json', ids: products.map((item) => item.id) }),
      ),
    );
    expect(exported.count).toBe(500);
    expect((JSON.parse(exported.content) as { products: Product[] }).products).toHaveLength(500);
  });
  it('rejects missing selections and invalid export formats rather than silently omitting them', async () => {
    await importFile(file());
    expect(
      (await exportPost(request('export', 'POST', { format: 'json', ids: ['missing'] }))).status,
    ).toBe(409);
    expect((await exportPost(request('export', 'POST', { format: 'exe', ids: [] }))).status).toBe(
      400,
    );
    expect(
      (await exportPost(request('export', 'POST', { format: 'csv', ids: ['same', 'same'] })))
        .status,
    ).toBe(400);
  });
  it('rejects foreign origins, missing sessions and extension access to private backup/import', async () => {
    const origin = 'https://evil.example';
    const foreign = new Request('http://localhost:3000/api/library/import', {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'x-productspy-client': 'web' },
      body: JSON.stringify({ action: 'preview', data: file() }),
    });
    expect((await POST(foreign)).status).toBe(403);
    const unauthenticated = new Request('http://localhost:3000/api/library/export');
    expect((await exportGet(unauthenticated)).status).toBe(403);
    const extension = new Request('http://localhost:3000/api/library/export', {
      headers: {
        origin: `chrome-extension://${'a'.repeat(32)}`,
        'x-productspy-client': 'extension',
      },
    });
    expect((await exportGet(extension)).status).toBe(403);
  });
});
