import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import {
  builtinTemplates,
  contentPlanSchema,
  contentOptionsSchema,
  mergeProduct,
  templateBackupSchema,
} from '@productspy/shared';
import { mockContent } from '../lib/ai/content-generation';
import { singleTemplateBackup } from './template-export';
import { buildContentZip } from './content-export';

const date = '2026-10-13T00:00:00.000Z';
const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Local export sample',
  images: ['https://m.media-amazon.com/images/I/abc.jpg'],
  videos: [],
  bulletPoints: ['Page-listed feature'],
});
const plan = contentPlanSchema.parse({
  id: randomUUID(),
  name: '../Safe: content',
  productId: product.id,
  productSnapshot: product,
  templateSnapshot: builtinTemplates[0],
  options: contentOptionsSchema.parse({}),
  status: 'draft',
  favorite: false,
  createdAt: date,
  updatedAt: date,
  versions: [],
});

describe('browser content and template export contracts', () => {
  it('exports a builtin as an importable independent custom template', () => {
    const source = builtinTemplates[0]!;
    const backup = singleTemplateBackup(source, date, randomUUID);
    expect(templateBackupSchema.safeParse(backup).success).toBe(true);
    expect(backup.templates[0]?.id).not.toBe(source.id);
    expect(backup.templates[0]?.origin).toBe('custom');
    expect(backup.templates[0]?.prompt).toBe(source.prompt);
    expect(source.origin).toBe('builtin');
  });
  it('keeps a user template ID and complete history for safe conflict detection', () => {
    const custom = singleTemplateBackup(builtinTemplates[0]!, date, randomUUID).templates[0]!;
    const backup = singleTemplateBackup(custom, date, randomUUID);
    expect(backup.templates[0]).toEqual(custom);
  });
  it('exports selected text with provenance without fetching or copying media', async () => {
    const version = {
      id: randomUUID(),
      createdAt: date,
      kind: 'edited' as const,
      output: mockContent(plan).output,
    };
    const saved = { ...plan, versions: [version], currentVersionId: version.id };
    const zip = await JSZip.loadAsync(await buildContentZip(saved, ['hooks', 'storyboard']), {
      checkCRC32: true,
    });
    const files = Object.keys(zip.files);
    expect(files).toHaveLength(5);
    expect(
      files.every((file) => !file.includes('/') && !file.includes('\\') && !file.includes('..')),
    ).toBe(true);
    expect(files.every((file) => /\.(?:md|json|txt)$/.test(file))).toBe(true);
    const provenance = JSON.parse(
      await zip.file(files.find((file) => file.endsWith('.json'))!)!.async('string'),
    ) as { product: { id: string }; output: Record<string, string[]>; template: { id: string } };
    expect(provenance.product.id).toBe(product.id);
    expect(provenance.template.id).toBe(plan.templateSnapshot.id);
    expect(Object.keys(provenance.output)).toEqual(['hooks', 'storyboard']);
    expect(await zip.file('README.txt')!.async('string')).toContain('未上传、下载或复制');
  });
  it('refuses an export without a saved generation version', async () => {
    await expect(buildContentZip(plan)).rejects.toThrow('请先生成');
  });
});
