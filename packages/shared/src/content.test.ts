import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { builtinTemplates, CONTENT_FIELDS } from './templates';
import { mergeProduct } from './product';
import {
  contentOptionsSchema,
  contentPlanSchema,
  contentOutputSchema,
  contentBackupSchema,
  currentContentVersion,
  estimateContentDuration,
  exportContentMarkdown,
  exportContentTxt,
  exportContentJson,
  contentExportFilename,
  contentMediaChoices,
  contentMediaChoiceGroups,
} from './content';
import { mockContent } from '../../../apps/web/src/lib/ai/content-generation';
const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Bottle [unsafe](https://example.com)',
  images: [],
  videos: [],
  bulletPoints: ['Page-listed steel'],
});
const time = '2026-10-13T00:00:00.000Z';
it('groups captured quality sources into one visible reference asset without removing saved URL choices', () => {
  const low = 'https://m.media-amazon.com/images/I/31test._AC_SX300_.jpg';
  const high = 'https://m.media-amazon.com/images/I/31test._AC_SL1500_.jpg';
  const sample = { ...product, images: [low, high] };
  expect(contentMediaChoices(sample)).toHaveLength(2);
  const groups = contentMediaChoiceGroups(sample);
  expect(groups).toHaveLength(1);
  expect(groups[0].variants.map((item) => item.url).sort()).toEqual([low, high].sort());
});
const plan = contentPlanSchema.parse({
  id: randomUUID(),
  name: '../Package: [link](evil)',
  productId: product.id,
  productSnapshot: product,
  templateSnapshot: builtinTemplates[0],
  options: contentOptionsSchema.parse({}),
  status: 'draft',
  favorite: false,
  createdAt: time,
  updatedAt: time,
  versions: [],
});
const imageUrl = 'https://m.media-amazon.com/images/I/current-product.jpg';
const videoUrl = 'https://m.media-amazon.com/images/S/current-product.mp4';
const mediaPlan = {
  ...plan,
  productSnapshot: {
    ...product,
    images: [imageUrl],
    videos: [{ url: videoUrl }],
    mediaMetadata: [
      {
        kind: 'image' as const,
        url: 'https://m.media-amazon.com/images/I/wrong-product.jpg',
        sourceUrl: 'https://www.amazon.com/dp/B012345679',
        productSourceId: 'B012345679',
        extractedAt: time,
      },
    ],
  },
};
describe('content contracts, duration and safe text exports', () => {
  it('accepts optional bounded selection for legacy plans and only approves media belonging to their snapshots', () => {
    expect(contentPlanSchema.parse(plan).selectedMedia).toBeUndefined();
    expect(
      contentPlanSchema.parse({ ...mediaPlan, selectedMedia: [{ kind: 'image', url: imageUrl }] })
        .selectedMedia,
    ).toEqual([{ kind: 'image', url: imageUrl }]);
    expect(contentMediaChoices(mediaPlan.productSnapshot)).toEqual([
      { kind: 'image', url: imageUrl },
      { kind: 'video', url: videoUrl },
    ]);
    for (const invalid of [
      [
        { kind: 'image', url: imageUrl },
        { kind: 'image', url: `${imageUrl}#duplicate` },
      ],
      [{ kind: 'image', url: 'https://m.media-amazon.com/images/I/wrong-product.jpg' }],
      [{ kind: 'image', url: 'http://127.0.0.1:3000/api/private' }],
      [{ kind: 'image', url: 'https://example.com/current-product.jpg' }],
      [{ kind: 'video', url: imageUrl }],
      Array.from({ length: 51 }, (_, index) => ({ kind: 'image', url: `${imageUrl}?${index}` })),
    ])
      expect(contentPlanSchema.safeParse({ ...mediaPlan, selectedMedia: invalid }).success).toBe(
        false,
      );
  });
  it('refuses unsupported HLS selection and preserves per-generation media provenance in all text exports', () => {
    const unsupported = {
      ...mediaPlan,
      productSnapshot: {
        ...mediaPlan.productSnapshot,
        videos: [{ url: 'https://m.media-amazon.com/images/S/index.m3u8' }],
      },
    };
    expect(
      contentMediaChoices(unsupported.productSnapshot).some((asset) => asset.kind === 'video'),
    ).toBe(false);
    const options = contentOptionsSchema.parse({});
    const output = mockContent(mediaPlan).output;
    const version = {
      id: randomUUID(),
      createdAt: time,
      kind: 'generated' as const,
      output,
      metadata: {
        mode: 'mock' as const,
        options,
        generatedAt: time,
        sourceUpdatedAt: mediaPlan.productSnapshot.updatedAt,
        templateId: mediaPlan.templateSnapshot.id,
        evidence: mockContent(mediaPlan).evidence,
        textDurationEstimate: estimateContentDuration(output, options),
        selectedMedia: [{ kind: 'image' as const, url: imageUrl }],
      },
    };
    const saved = contentPlanSchema.parse({
      ...mediaPlan,
      selectedMedia: [{ kind: 'video', url: videoUrl }],
      currentVersionId: version.id,
      versions: [version],
    });
    const json = JSON.parse(exportContentJson(saved)) as {
      selectedMedia: { kind: string; url: string }[];
    };
    expect(json.selectedMedia).toEqual([{ kind: 'image', url: imageUrl }]);
    expect(exportContentTxt(saved)).toContain(imageUrl);
    expect(exportContentTxt(saved)).not.toContain(videoUrl);
    const wrong = {
      ...version,
      metadata: {
        ...version.metadata,
        selectedMedia: [
          { kind: 'image', url: 'https://m.media-amazon.com/images/I/wrong-product.jpg' },
        ],
      },
    };
    expect(contentPlanSchema.safeParse({ ...saved, versions: [wrong] }).success).toBe(false);
  });
  it('keeps legacy defaults and accepts a custom content duration independently', () => {
    expect(contentOptionsSchema.parse({}).duration).toBe(30);
    expect(contentOptionsSchema.parse({ duration: 45 }).duration).toBe(45);
    for (const duration of [0, 4, 181, 1.2, Infinity])
      expect(contentOptionsSchema.safeParse({ duration }).success).toBe(false);
    expect(contentOptionsSchema.safeParse({ execute: 'script' }).success).toBe(false);
  });
  it('validates required script sections and five hooks', () => {
    const output = mockContent(plan).output;
    expect(contentOutputSchema.safeParse(output).success).toBe(true);
    expect(contentOutputSchema.safeParse({ ...output, hooks: ['one'] }).success).toBe(false);
    expect(
      contentOutputSchema.safeParse({ ...output, shortVideoScript: ['Hook: only'] }).success,
    ).toBe(false);
    expect(contentOutputSchema.safeParse({ ...output, unexpected: 'x' }).success).toBe(false);
  });
  it('labels the duration heuristic honestly and warns on an obvious text conflict', () => {
    const output = mockContent(plan).output;
    const estimate = estimateContentDuration(
      { ...output, voiceover: ['words '.repeat(300)] },
      contentOptionsSchema.parse({ language: 'en', duration: 15 }),
    );
    expect(estimate.method).toBe('text-only-estimate');
    expect(estimate.estimatedSeconds).toBeGreaterThan(100);
    expect(estimate.warnings.join(' ')).toContain('超过');
    expect(estimate.warnings.join(' ')).toContain('未合成');
  });
  it('preserves snapshots without a live source and validates the current version', () => {
    expect(contentPlanSchema.safeParse(plan).success).toBe(true);
    expect(contentPlanSchema.safeParse({ ...plan, currentVersionId: randomUUID() }).success).toBe(
      false,
    );
    expect(contentPlanSchema.safeParse({ ...plan, productId: 'mismatch' }).success).toBe(false);
    expect(currentContentVersion(plan)).toBeUndefined();
  });
  it('rejects duplicate plan/version IDs and unsupported backup formats', () => {
    expect(
      contentBackupSchema.safeParse({
        format: 'productspy-content',
        schemaVersion: 1,
        exportedAt: time,
        plans: [plan, plan],
      }).success,
    ).toBe(false);
    expect(
      contentBackupSchema.safeParse({
        format: 'productspy-library',
        schemaVersion: 1,
        exportedAt: time,
        plans: [],
      }).success,
    ).toBe(false);
    const version = {
      id: randomUUID(),
      createdAt: time,
      kind: 'edited',
      output: mockContent(plan).output,
    };
    expect(contentPlanSchema.safeParse({ ...plan, versions: [version, version] }).success).toBe(
      false,
    );
  });
  it('exports selected fields with provenance and escaped Markdown', () => {
    const output = mockContent(plan).output;
    const version = { id: randomUUID(), createdAt: time, kind: 'edited' as const, output };
    const saved = { ...plan, versions: [version], currentVersionId: version.id };
    const markdown = exportContentMarkdown(saved, ['hooks']);
    expect(markdown).toContain('开场文案');
    expect(markdown).not.toContain('## 图片生成提示词');
    expect(markdown).toContain('\\[unsafe\\]\\(https://example\\.com\\)');
    expect(markdown).toContain('历史记录，非实时');
    expect(exportContentTxt(saved, ['hooks'])).toContain('ASIN：B012345678');
    const json = JSON.parse(exportContentJson(saved, ['hooks'])) as {
      output: Record<string, string[]>;
      product: { id: string };
      template: { id: string };
      disclaimer: string;
    };
    expect(Object.keys(json.output)).toEqual(['hooks']);
    expect(json.product.id).toBe(product.id);
    expect(json.template.id).toBe(builtinTemplates[0]?.id);
    expect(json.disclaimer).toContain('未上传或复制媒体');
    const filename = contentExportFilename(saved, '../zip');
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
    expect(filename).toContain(product.sourceId);
    expect(CONTENT_FIELDS).toHaveLength(9);
  });
});
