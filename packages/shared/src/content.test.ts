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
describe('content contracts, duration and safe text exports', () => {
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
