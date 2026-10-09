import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_LIBRARY_IMPORT_BYTES,
  exportAnalysesMarkdown,
  exportProductsCsv,
  mergeLibraryImport,
  parseLibraryImport,
  parseLibraryImportText,
  previewLibraryImport,
  serializeLibraryBackup,
} from './library-transfer';
import type { LibraryDefinition, LibrarySnapshot, Product, ProductAnalysis } from './types';

const date = '2026-10-09T00:00:00.000Z';
const analysis: ProductAnalysis = {
  summary: '人工修改的总结',
  sellingPoints: ['便于携带'],
  targetAudience: ['旅行者'],
  purchaseMotivations: ['收纳'],
  painPoints: ['容量待确认'],
  strengths: ['轻便'],
  weaknesses: ['耐用性待验证'],
  marketingAngles: ['旅行收纳演示'],
  hooks: ['一', '二', '三', '四', '五'],
  shortVideoScript: 'Hook: 开场\nProblem: 收纳\nSolution: 使用\nDemo: 展示\nCTA: 查看',
  imagePrompts: ['桌面上的商品'],
  videoPrompts: ['演示收纳过程'],
};
function product(asin = 'B012345678', id = `amazon:${asin}`): Product {
  return {
    id,
    source: 'amazon',
    sourceId: asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: '测试商品',
    images: ['https://m.media-amazon.com/images/I/test.jpg'],
    videos: [],
    bulletPoints: ['测试卖点'],
    createdAt: date,
    updatedAt: date,
    aiAnalysis: analysis,
    analysisHistory: [{ id: randomUUID(), kind: 'edited', createdAt: date, analysis }],
  };
}
function definition(name: string, id = randomUUID()): LibraryDefinition {
  return { id, name, color: '#336699', createdAt: date, updatedAt: date };
}
function snapshot(products = [product()]): LibrarySnapshot {
  return { products, groups: [], tags: [] };
}
function backup(value: LibrarySnapshot): unknown {
  return JSON.parse(serializeLibraryBackup(value)) as unknown;
}

describe('validated non-destructive library import and backup', () => {
  it('round-trips every product ID, ASIN, manual analysis, history and membership', () => {
    const group = definition('厨房');
    const tag = definition('待选品');
    const original = {
      products: [{ ...product(), groupIds: [group.id], tagIds: [tag.id] }],
      groups: [group],
      tags: [tag],
    };
    expect(parseLibraryImportText(serializeLibraryBackup(original))).toEqual(original);
    const exported = backup(original) as Record<string, unknown>;
    expect(Object.keys(exported)).toEqual([
      'format',
      'schemaVersion',
      'exportedAt',
      'products',
      'groups',
      'tags',
    ]);
    expect(exported).not.toHaveProperty('revision');
    expect(exported).not.toHaveProperty('apiKey');
    expect(exported).not.toHaveProperty('usage');
  });
  it('reads unchanged v0.4 product arrays without adding memberships or losing AI', () => {
    const original = product();
    expect(parseLibraryImport([original])).toEqual(snapshot([original]));
    expect(parseLibraryImportText(`\uFEFF${JSON.stringify([original])}`).products[0]).toEqual(
      original,
    );
  });
  it.each(['skip', 'preserve'] as const)(
    'policy %s leaves duplicate existing records exactly untouched',
    (policy) => {
      const original = product();
      const changed = {
        ...original,
        id: 'changed-import-id',
        title: '不同标题',
        aiAnalysis: { ...analysis, summary: '导入版' },
      };
      const incoming = snapshot([changed, product('B012345679')]);
      const existing = snapshot([original]);
      const merged = mergeLibraryImport(incoming, existing, policy, randomUUID);
      expect(merged.snapshot.products[0]).toBe(original);
      expect(merged.snapshot.products[0]).toEqual(original);
      expect(merged.result).toMatchObject({
        total: 2,
        imported: 1,
        skipped: 1,
        failed: 0,
        skippedIds: ['changed-import-id'],
      });
      expect(
        previewLibraryImport(incoming, { ...existing, revision: 'a'.repeat(64) }),
      ).toMatchObject({
        total: 2,
        newProducts: 1,
        revision: 'a'.repeat(64),
        conflicts: [
          {
            incomingId: 'changed-import-id',
            existingId: original.id,
            sourceId: original.sourceId,
            title: changed.title,
          },
        ],
      });
    },
  );
  it('reassigns an incoming colliding ID and conflicting definition IDs without touching old metadata', () => {
    const existingGroup = definition('原分组');
    const incomingGroup = { ...existingGroup, name: '新分组' };
    const existingTag = definition('原标签');
    const incomingTag = { ...existingTag, name: '新标签' };
    const original = product('B012345678', 'same-id');
    const other = {
      ...product('B012345679', 'same-id'),
      groupIds: [incomingGroup.id],
      tagIds: [incomingTag.id],
    };
    const existing = { products: [original], groups: [existingGroup], tags: [existingTag] };
    const incoming = { products: [other], groups: [incomingGroup], tags: [incomingTag] };
    const merged = mergeLibraryImport(incoming, existing, 'skip', randomUUID);
    const restored = merged.snapshot.products[1];
    expect(restored?.id).not.toBe('same-id');
    expect(restored?.aiAnalysis).toEqual(other.aiAnalysis);
    expect(restored?.analysisHistory).toEqual(other.analysisHistory);
    expect(restored?.groupIds).not.toEqual(other.groupIds);
    expect(restored?.tagIds).not.toEqual(other.tagIds);
    expect(merged.snapshot.groups[0]).toBe(existingGroup);
    expect(merged.snapshot.tags[0]).toBe(existingTag);
    expect(merged.result).toMatchObject({ reassignedIds: 1, groupsAdded: 1, tagsAdded: 1 });
  });
  it('reuses matching names and preserves original name/color while mapping new products', () => {
    const existing = definition('Kitchen');
    const incoming = { ...definition('kitchen'), color: '#ffffff' };
    const merged = mergeLibraryImport(
      { products: [{ ...product(), groupIds: [incoming.id] }], groups: [incoming], tags: [] },
      { products: [], groups: [existing], tags: [] },
      'preserve',
      randomUUID,
    );
    expect(merged.snapshot.groups).toEqual([existing]);
    expect(merged.snapshot.products[0]?.groupIds).toEqual([existing.id]);
    expect(merged.result.groupsAdded).toBe(0);
  });
  it('rejects a corrupt file or unknown backup version instead of importing valid pieces', () => {
    expect(() => parseLibraryImportText('{"products":')).toThrow('JSON');
    expect(() =>
      parseLibraryImport({ ...(backup(snapshot()) as Record<string, unknown>), schemaVersion: 99 }),
    ).toThrow('版本');
    expect(() => parseLibraryImport([product(), { source: 'amazon' }])).toThrow('格式');
    expect(() =>
      parseLibraryImport({
        ...(backup(snapshot()) as Record<string, unknown>),
        apiKey: 'never-import-settings',
      }),
    ).toThrow('格式');
    expect(() => parseLibraryImport([{ ...product(), injected: 'unexpected' }])).toThrow('格式');
  });
  it('rejects duplicate ASINs, duplicate IDs, invalid membership and duplicate definitions', () => {
    expect(() => parseLibraryImport([product(), { ...product(), id: 'second' }])).toThrow('重复');
    expect(() =>
      parseLibraryImport([product('B012345678', 'same'), product('B012345679', 'same')]),
    ).toThrow('重复');
    expect(() => parseLibraryImport([{ ...product(), tagIds: [randomUUID()] }])).toThrow('不存在');
    const group = definition('Kitchen');
    expect(() =>
      parseLibraryImport({
        format: 'productspy-library',
        schemaVersion: 1,
        exportedAt: date,
        products: [],
        groups: [group, definition('kitchen')],
        tags: [],
      }),
    ).toThrow('重复');
    expect(() =>
      parseLibraryImport({
        format: 'productspy-library',
        schemaVersion: 1,
        exportedAt: date,
        products: [{ ...product(), groupIds: [group.id, group.id] }],
        groups: [group],
        tags: [],
      }),
    ).toThrow('重复');
  });
  it('rejects ambiguous repeated analysis version IDs without trimming history', () => {
    const original = product();
    const version = original.analysisHistory?.[0];
    if (!version) throw new Error('Missing fixture version');
    expect(() =>
      parseLibraryImport([
        {
          ...original,
          analysisHistory: [
            version,
            { ...version, analysis: { ...analysis, summary: '不同历史内容' } },
          ],
        },
      ]),
    ).toThrow('版本编号');
    expect(original.analysisHistory).toHaveLength(1);
  });
  it('rejects files over 25 MiB and more than 2000 products, counting UTF-8 bytes', () => {
    expect(() =>
      parseLibraryImportText('中'.repeat(Math.floor(MAX_LIBRARY_IMPORT_BYTES / 3) + 1)),
    ).toThrow('25 MiB');
    const over = Array.from({ length: 2001 }, (_, i) =>
      product(`B${i.toString().padStart(9, '0')}`),
    );
    expect(() => parseLibraryImport(over)).toThrow('2000');
    expect(() => serializeLibraryBackup(snapshot(over))).toThrow('格式');
  });
  it.each([
    'javascript:alert(1)',
    'data:image/svg+xml,<svg/>',
    'file:///C:/secret',
    'https://127.0.0.1/picture.jpg',
    'https://2130706433/picture.jpg',
    'https://[::1]/picture.jpg',
    'https://192.168.1.1/picture.jpg',
    'https://localhost/picture.jpg',
    'https://server.local/a.jpg',
    'https://server.internal/a.jpg',
    'https://127.0.0.1.nip.io/a.jpg',
    'https://user:password@example.com/a.jpg',
    'https://example.com:8443/a.jpg',
    'https://example.com/a\n.jpg',
  ])('rejects unsafe imported media URL %s', (url) => {
    expect(() => parseLibraryImport([{ ...product(), images: [url] }])).toThrow();
    expect(() => parseLibraryImport([{ ...product(), videos: [{ url }] }])).toThrow();
    expect(() =>
      parseLibraryImport([
        { ...product(), videos: [{ url: 'https://example.com/video.mp4', thumbnail: url }] },
      ]),
    ).toThrow();
  });
  it('preserves compatible public HTTP(S) media and validates ASIN for all supported product paths', () => {
    const old = {
      ...product(),
      images: ['http://example.com/old.jpg'],
      videos: [{ url: 'https://cdn.example.com/movie.mp4' }],
    };
    expect(parseLibraryImport([old]).products[0]).toEqual(old);
    for (const path of ['dp', 'gp/product', 'gp/aw/d'])
      expect(
        parseLibraryImport([
          { ...product(), url: `https://www.amazon.co.jp/${path}/B012345678/ref=test` },
        ]).products,
      ).toHaveLength(1);
    expect(() =>
      parseLibraryImport([{ ...product(), url: 'https://www.amazon.com/dp/B012345679' }]),
    ).toThrow('ASIN');
    expect(() =>
      parseLibraryImport([
        { ...product(), url: 'https://user:password@www.amazon.com/dp/B012345678' },
      ]),
    ).toThrow('凭据');
    expect(() =>
      parseLibraryImport([
        { ...product(), url: 'https://www.amazon.com.evil.example/dp/B012345678' },
      ]),
    ).toThrow();
  });
  it('rejects definition capacity overflow atomically and refuses a broken ID factory', () => {
    const old = {
      products: [],
      groups: Array.from({ length: 200 }, (_, i) => definition(`Group ${i}`)),
      tags: [],
    };
    expect(() =>
      mergeLibraryImport(
        { products: [], groups: [definition('Extra')], tags: [] },
        old,
        'skip',
        randomUUID,
      ),
    ).toThrow('容量');
    expect(old.groups).toHaveLength(200);
    const same = snapshot([product('B012345678', 'same')]);
    expect(() =>
      mergeLibraryImport(snapshot([product('B012345679', 'same')]), same, 'skip', () => 'not-uuid'),
    ).toThrow('编号');
  });
});

describe('safe readable exports', () => {
  it.each(['=HYPERLINK("evil")', '+cmd', '-1+2', '@SUM(1)', ' \t=1+1', '\u0000=1+1', '\tplain'])(
    'neutralizes formula value %j in CSV',
    (title) => {
      const csv = exportProductsCsv([{ ...product(), title }]);
      expect(csv).toContain(`"'${title.replaceAll('"', '""')}"`);
      expect(csv.startsWith('\uFEFF')).toBe(true);
    },
  );
  it('quotes embedded commas, quotes and newlines using RFC CSV rules', () => {
    const csv = exportProductsCsv([
      { ...product(), title: 'Line, "one"\nTwo', rating: 0, reviewCount: 0 },
    ]);
    expect(csv).toContain('"Line, ""one""\nTwo"');
    expect(csv).toContain('"0","0"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
  it('escapes injected HTML, links and fences without losing plain analysis text', () => {
    const markdown = exportAnalysesMarkdown([
      {
        ...product(),
        title: '<script>alert(1)</script>',
        aiAnalysis: {
          ...analysis,
          summary: '```html\n<img src=x onerror=alert(1)>\n[link](javascript:alert(1))',
        },
      },
    ]);
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('<img');
    expect(markdown).not.toContain('[link](javascript:');
    expect(markdown).not.toContain('```html');
    expect(markdown).toContain('## 短视频脚本');
  });
  it('exports all products, including a clear note for absent analysis', () => {
    const pending = product('B012345679');
    delete pending.aiAnalysis;
    expect(exportAnalysesMarkdown([product(), pending])).toContain('尚未保存 AI 分析');
    expect(exportAnalysesMarkdown([])).toBe('');
  });
});
