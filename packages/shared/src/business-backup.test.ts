import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { builtinTemplates } from './templates';
import { DEFAULT_ANALYSIS_OPTIONS } from './schema';
import { DEFAULT_CONTENT_OPTIONS } from './content';
import {
  parseWorkspaceBackup,
  parseWorkspaceBackupText,
  workspaceBackupCounts,
  validateWorkspaceRelations,
  type WorkspaceBackup,
} from './business-backup';
const date = '2026-10-14T00:00:00.000Z';
const product = () => ({
  id: randomUUID(),
  source: 'amazon' as const,
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Synthetic local test item',
  images: ['https://m.media-amazon.com/images/I/test.jpg'],
  videos: [],
  bulletPoints: [],
  createdAt: date,
  updatedAt: date,
});
function backup(): WorkspaceBackup {
  return {
    format: 'productspy-workspace',
    schemaVersion: 1,
    exportedAt: date,
    library: { products: [], groups: [], tags: [] },
    comparisons: [],
    templates: [],
    contentPlans: [],
    usage: [],
  };
}
function contentSnapshot(): WorkspaceBackup {
  const value = backup();
  const source = product();
  value.contentPlans.push({
    id: randomUUID(),
    name: 'Preserved source snapshot',
    productId: source.id,
    productSnapshot: source,
    templateSnapshot: structuredClone(builtinTemplates[0]),
    options: DEFAULT_CONTENT_OPTIONS,
    status: 'draft',
    favorite: false,
    versions: [],
    createdAt: date,
    updatedAt: date,
  });
  return value;
}
describe('complete workspace backup schema and source boundaries', () => {
  it('keeps deleted sources as independently valid immutable snapshots', () => {
    const value = contentSnapshot();
    expect(parseWorkspaceBackup(value).contentPlans[0].productId).toBe(
      value.contentPlans[0].productSnapshot.id,
    );
    expect(workspaceBackupCounts(value).contentPlans).toBe(1);
  });
  it('rejects nested hostile media URLs and changed ASIN identity', () => {
    const value = contentSnapshot();
    value.contentPlans[0].productSnapshot.images = ['http://127.0.0.1/private'];
    expect(() => parseWorkspaceBackup(value)).toThrow('公开');
    const second = contentSnapshot();
    const source = second.contentPlans[0].productSnapshot;
    second.library.products.push({
      ...source,
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
    });
    expect(() => parseWorkspaceBackup(second)).toThrow('不同 ASIN');
  });
  it('checks incoming identities against an existing library without overwriting it', () => {
    const old = backup();
    const source = product();
    old.library.products.push(source);
    const incoming = backup();
    incoming.library.products.push({
      ...source,
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
    });
    expect(() => validateWorkspaceRelations(incoming, old)).toThrow('不同 ASIN');
    expect(old.library.products[0].sourceId).toBe('B012345678');
  });
  it('rejects credentials, arbitrary preferences and unsupported archive formats', () => {
    expect(() =>
      parseWorkspaceBackup({ ...backup(), apiKey: 'synthetic-never-a-real-key' }),
    ).toThrow('结构');
    expect(() => parseWorkspaceBackup({ ...backup(), preferences: { cookie: 'test' } })).toThrow(
      '结构',
    );
    expect(() =>
      parseWorkspaceBackup({
        ...backup(),
        preferences: {
          analysis: { version: 1, options: DEFAULT_ANALYSIS_OPTIONS, pricing: {}, token: 'test' },
        },
      }),
    ).toThrow('结构');
    expect(() => parseWorkspaceBackup({ ...backup(), format: 'productspy-library' })).toThrow();
    expect(() => parseWorkspaceBackupText('not json')).toThrow('有效');
  });
  it('keeps only explicit preference and one-way usage fields with exact generation options', () => {
    const value = backup();
    value.preferences = {
      analysis: { version: 1, options: DEFAULT_ANALYSIS_OPTIONS, pricing: {} },
      builtinFavorites: [builtinTemplates[0].id],
    };
    const id = randomUUID();
    value.usage.push({
      id,
      requestId: id,
      productId: 'deleted-product',
      createdAt: date,
      mode: 'real',
      status: 'started',
      options: DEFAULT_ANALYSIS_OPTIONS,
      fingerprint: 'a'.repeat(64),
    });
    expect(parseWorkspaceBackup(value).usage[0].status).toBe('started');
    value.usage[0].contentOptions = DEFAULT_CONTENT_OPTIONS;
    expect(() => parseWorkspaceBackup(value)).toThrow('一种');
  });
  it('rejects repeated request identifiers and unknown template snapshots', () => {
    const value = backup();
    const id = randomUUID();
    const record = {
      id,
      requestId: id,
      productId: 'test',
      createdAt: date,
      mode: 'mock' as const,
      status: 'succeeded' as const,
      options: DEFAULT_ANALYSIS_OPTIONS,
      fingerprint: 'f'.repeat(64),
    };
    value.usage.push(record, record);
    expect(() => parseWorkspaceBackup(value)).toThrow('重复');
    const contents = contentSnapshot();
    contents.contentPlans[0].templateSnapshot.id = randomUUID();
    expect(() => parseWorkspaceBackup(contents)).toThrow('未知');
  });
});
