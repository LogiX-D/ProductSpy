import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_CONTENT_OPTIONS,
  builtinTemplates,
  templateDefinition,
  estimateContentDuration,
  type WorkspaceBackup,
} from '@productspy/shared';
import { WorkspaceBackupService } from './business-backup';
import {
  BUSINESS_FILES,
  commitBusinessFiles,
  withBusinessExclusive,
  withBusinessOperation,
  type BusinessFile,
} from './business-lock';
import { publishAtomicFile } from './atomic-file';
import { LocalJsonProductRepository } from './product-repository';
import { LocalTemplateRepository } from './template-repository';
import { LocalContentRepository } from './content-repository';
import { LocalComparisonRepository } from './comparison-repository';
import { AnalysisUsageLedger } from './analysis-usage';
import { MockAIProvider } from '../ai/mock-provider';
import { mockComparison } from '../ai/comparison-mock';
import { mockContent } from '../ai/content-generation';
import { GET, POST } from '../../app/api/workspace-backup/route';
import { webHeaders } from './test-auth';

const date = '2026-10-14T00:00:00.000Z';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
function seed(): WorkspaceBackup {
  const source = {
    id: randomUUID(),
    source: 'amazon' as const,
    sourceId: 'B012345678',
    url: 'https://www.amazon.com/dp/B012345678',
    title: 'Synthetic workspace backup fixture',
    images: [],
    videos: [],
    bulletPoints: [],
    createdAt: date,
    updatedAt: date,
  };
  return {
    format: 'productspy-workspace',
    schemaVersion: 1,
    exportedAt: date,
    library: { products: [source], groups: [], tags: [] },
    comparisons: [],
    templates: [],
    contentPlans: [
      {
        id: randomUUID(),
        name: 'Synthetic preserved content snapshot',
        productId: source.id,
        productSnapshot: source,
        templateSnapshot: structuredClone(builtinTemplates[0]),
        options: DEFAULT_CONTENT_OPTIONS,
        status: 'draft',
        favorite: false,
        createdAt: date,
        updatedAt: date,
        versions: [],
      },
    ],
    usage: [],
  };
}
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-workspace-backup-'));
  vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
describe('business restore non-destructive consistency', () => {
  it('retains the original snapshot ID and warns when duplicate ASIN uses another live product ID', async () => {
    const service = new WorkspaceBackupService(directory);
    const first = seed();
    const originalView = await service.restore(first, {});
    await service.restore(first, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: originalView.preview.revision,
    });
    const incoming = seed();
    expect(incoming.library.products[0].id).not.toBe(first.library.products[0].id);
    const view = await service.restore(incoming, {});
    expect(view.preview.warnings.some((warning) => warning.includes('同 ASIN 使用不同 ID'))).toBe(
      true,
    );
    await service.restore(incoming, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: view.preview.revision,
    });
    const restored = await service.export();
    expect(restored.library.products).toEqual(first.library.products);
    expect(
      restored.contentPlans.find((plan) => plan.id === incoming.contentPlans[0].id)?.productId,
    ).toBe(incoming.library.products[0].id);
  });
  it('validates combined entity capacity during preview before requesting any restore confirmation', async () => {
    const service = new WorkspaceBackupService(directory);
    const first = seed();
    first.templates = Array.from({ length: 200 }, (_, index) => ({
      ...structuredClone(builtinTemplates[0]),
      id: randomUUID(),
      origin: 'custom' as const,
      name: `Synthetic capacity ${index}`,
      versions: [
        {
          id: randomUUID(),
          createdAt: date,
          kind: 'created' as const,
          snapshot: {
            ...templateDefinition(builtinTemplates[0]),
            name: `Synthetic capacity ${index}`,
          },
        },
      ],
    }));
    const initial = await service.restore(first, {});
    await service.restore(first, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: initial.preview.revision,
    });
    const before = await readFile(join(directory, 'templates.json'), 'utf8');
    const next: WorkspaceBackup = {
      ...seed(),
      library: { products: [], groups: [], tags: [] },
      contentPlans: [],
      templates: [{ ...first.templates[0], id: randomUUID() }],
    };
    await expect(service.restore(next, {})).rejects.toThrow('结构');
    expect(await readFile(join(directory, 'templates.json'), 'utf8')).toBe(before);
  });
  it('reports imported and retained grouping definitions accurately without changing existing colors', async () => {
    const value = seed();
    const groupId = randomUUID();
    const tagId = randomUUID();
    value.library.groups.push({
      id: groupId,
      name: 'Synthetic group',
      color: '#336655',
      createdAt: date,
      updatedAt: date,
    });
    value.library.tags.push({
      id: tagId,
      name: 'Synthetic tag',
      color: '#778899',
      createdAt: date,
      updatedAt: date,
    });
    value.library.products[0] = {
      ...value.library.products[0],
      groupIds: [groupId],
      tagIds: [tagId],
    };
    const service = new WorkspaceBackupService(directory);
    const preview = await service.restore(value, {});
    const result = await service.restore(value, {
      commit: true,
      confirmed: true,
      policy: 'preserve',
      expectedRevision: preview.preview.revision,
    });
    expect(result.imported).toBe(4);
    const second = structuredClone(value);
    second.library.groups[0].color = '#123456';
    const view = await service.restore(second, {});
    const repeated = await service.restore(second, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: view.preview.revision,
    });
    expect(repeated.imported).toBe(0);
    expect(repeated.skipped).toBe(4);
    expect((await service.export()).library.groups[0].color).toBe('#336655');
  });
  it('round-trips all four real repository histories, snapshots and usage across an independent data root', async () => {
    const products = new LocalJsonProductRepository(directory);
    const templates = new LocalTemplateRepository(directory);
    const comparisons = new LocalComparisonRepository(directory);
    const contents = new LocalContentRepository(directory);
    let first = await products.upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Synthetic preserved history fixture',
      images: [],
      videos: [],
      bulletPoints: ['Merchant claim: reusable'],
    });
    const second = await products.upsert({
      source: 'amazon',
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
      title: 'Synthetic comparison fixture',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    const analysis = await new MockAIProvider().analyze(first);
    first = await products.saveAnalysis(first.id, analysis, first.updatedAt);
    first = await products.saveAnalysis(
      first.id,
      { ...analysis, summary: 'Human summary kept intact' },
      first.updatedAt,
    );
    let template = await templates.create({
      ...templateDefinition(builtinTemplates[0]),
      name: 'Human template',
    });
    template = await templates.update(template.id, {
      expectedUpdatedAt: template.updatedAt,
      definition: { ...templateDefinition(template), prompt: 'Human prompt for {{product_title}}' },
    });
    let comparison = await comparisons.create('Source comparison', [first, second]);
    const comparisonOutput = mockComparison(comparison.products, DEFAULT_ANALYSIS_OPTIONS);
    comparison = await comparisons.saveAnalysis(
      comparison.id,
      comparisonOutput.analysis,
      comparison.updatedAt,
      { kind: 'generated' },
    );
    comparison = await comparisons.saveAnalysis(
      comparison.id,
      { ...comparisonOutput.analysis, opportunities: ['Preserved human comparison note'] },
      comparison.updatedAt,
    );
    let content = await contents.create(
      'Human creative plan',
      first,
      template,
      DEFAULT_CONTENT_OPTIONS,
      comparison,
    );
    const generated = mockContent(content, content.options);
    const saved = await contents.saveGenerated(content.id, generated.output, content.updatedAt, {
      mode: 'mock',
      options: content.options,
      generatedAt: new Date().toISOString(),
      sourceUpdatedAt: first.updatedAt,
      templateId: template.id,
      templateVersionId: template.versions.at(-1)?.id,
      evidence: generated.evidence,
      textDurationEstimate: estimateContentDuration(generated.output, content.options),
    });
    content = await contents.update(content.id, {
      expectedUpdatedAt: saved.plan.updatedAt,
      output: { ...generated.output, voiceover: ['Human voiceover retained'] },
    });
    const requestId = randomUUID();
    await new AnalysisUsageLedger(directory).begin({
      requestId,
      productId: first.id,
      fingerprint: 'b'.repeat(64),
      mode: 'mock',
      options: DEFAULT_ANALYSIS_OPTIONS,
    });
    await new AnalysisUsageLedger(directory).finish(requestId, {
      versionId: first.analysisHistory?.at(-1)?.id,
      usage: { inputTokens: 3, outputTokens: 8, costEstimated: false },
    });
    const exported = await new WorkspaceBackupService(directory).export();
    const target = join(directory, 'independent-restored-data');
    const restore = new WorkspaceBackupService(target);
    const preview = await restore.restore(exported, {});
    expect(preview.preview.counts.histories).toBe(8);
    await restore.restore(exported, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: preview.preview.revision,
    });
    expect(await new LocalJsonProductRepository(target).get(first.id)).toEqual(first);
    expect(await new LocalTemplateRepository(target).get(template.id)).toEqual(template);
    expect(await new LocalComparisonRepository(target).get(comparison.id)).toEqual(comparison);
    expect(await new LocalContentRepository(target).get(content.id)).toEqual(content);
    const ledger = new AnalysisUsageLedger(target);
    expect((await ledger.get(requestId))?.fingerprint).toBe('b'.repeat(64));
    await expect(
      ledger.begin({
        requestId,
        productId: first.id,
        fingerprint: 'b'.repeat(64),
        mode: 'mock',
        options: DEFAULT_ANALYSIS_OPTIONS,
      }),
    ).rejects.toThrow('不会自动再次请求');
  });
  it('requires preview, revision and second confirmation then survives a new service instance', async () => {
    const service = new WorkspaceBackupService(directory);
    const value = seed();
    const view = await service.restore(value, {});
    expect(view.committed).toBe(false);
    expect((await readdir(directory)).length).toBe(0);
    await expect(
      service.restore(value, {
        commit: true,
        policy: 'skip',
        expectedRevision: view.preview.revision,
      }),
    ).rejects.toThrow('再次确认');
    const restored = await service.restore(value, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: view.preview.revision,
    });
    expect(restored.imported).toBe(2);
    const reopened = await new WorkspaceBackupService(directory).export();
    expect(reopened.library.products).toEqual(value.library.products);
    expect(reopened.contentPlans).toEqual(value.contentPlans);
  });
  it('preserves duplicate product edits, complete content history and all existing request reservations', async () => {
    const service = new WorkspaceBackupService(directory);
    const value = seed();
    const id = randomUUID();
    value.usage.push({
      id,
      requestId: id,
      productId: value.library.products[0].id,
      createdAt: date,
      mode: 'real',
      status: 'started',
      options: DEFAULT_ANALYSIS_OPTIONS,
      fingerprint: 'a'.repeat(64),
    });
    const first = await service.restore(value, {});
    await service.restore(value, {
      commit: true,
      confirmed: true,
      policy: 'preserve',
      expectedRevision: first.preview.revision,
    });
    const incoming = structuredClone(value);
    incoming.library.products[0].title = 'Must not overwrite';
    incoming.contentPlans[0].name = 'Must not overwrite';
    incoming.usage[0].status = 'succeeded';
    const view = await service.restore(incoming, {});
    expect(view.preview.conflicts).toHaveLength(3);
    const result = await service.restore(incoming, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: view.preview.revision,
    });
    expect(result.skipped).toBe(3);
    const restored = await service.export();
    expect(restored.library.products[0].title).toBe(value.library.products[0].title);
    expect(restored.contentPlans).toEqual(value.contentPlans);
    expect(restored.usage[0].status).toBe('started');
  });
  it('rejects a changed revision and mismatched request fingerprint before any publishing', async () => {
    const service = new WorkspaceBackupService(directory);
    const first = seed();
    const view = await service.restore(first, {});
    await new LocalJsonProductRepository(directory).upsert({
      source: 'amazon',
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
      title: 'Concurrent collection',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    const before = await readFile(join(directory, 'products.json'), 'utf8');
    await expect(
      service.restore(first, {
        commit: true,
        confirmed: true,
        policy: 'skip',
        expectedRevision: view.preview.revision,
      }),
    ).rejects.toThrow('变化');
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe(before);
  });
  it('does not include config/auth files and blocks hostile nested import data', async () => {
    for (const name of ['bridge-auth.json', 'settings.json', '.env'])
      await writeFile(join(directory, name), 'synthetic excluded private fixture');
    const value = await new WorkspaceBackupService(directory).export();
    expect(JSON.stringify(value)).not.toContain('synthetic excluded');
    const incoming = seed();
    incoming.contentPlans[0].productSnapshot.images = ['http://localhost/private'];
    await expect(new WorkspaceBackupService(directory).restore(incoming, {})).rejects.toThrow(
      '公开',
    );
    expect(await readFile(join(directory, 'bridge-auth.json'), 'utf8')).toBe(
      'synthetic excluded private fixture',
    );
  });
});
describe('atomic five-file publishing and crash recovery gate', () => {
  it('recovers a crash during staging copy without touching original files or trusting unknown files', async () => {
    const stage = join(directory, '.workspace-restore');
    await mkdir(stage);
    await writeFile(join(directory, 'products.json'), 'original');
    const entries = BUSINESS_FILES.map((name) => ({
      name,
      oldHash: name === 'products.json' ? hash('original') : null,
      newHash: hash(`new-${name}`),
    }));
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'staging', entries }),
    );
    await writeFile(join(stage, 'new-products.json'), 'partially written stage bytes');
    await withBusinessOperation(directory, async () => undefined);
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['products.json']);
    await mkdir(stage);
    await withBusinessOperation(directory, async () => undefined);
    expect(await readdir(directory)).toEqual(['products.json']);
  });
  it('refuses publishing from a shared gate without creating any stage or file', async () => {
    const files = Object.fromEntries(BUSINESS_FILES.map((name) => [name, '{}'])) as Record<
      BusinessFile,
      string
    >;
    await expect(
      withBusinessOperation(directory, () => commitBusinessFiles(directory, files)),
    ).rejects.toThrow('requires business gate');
    expect(await readdir(directory)).toEqual([]);
  });
  it('rolls back every original byte on a partial publish failure and removes only new files', async () => {
    await writeFile(join(directory, 'products.json'), 'old-products');
    await writeFile(join(directory, 'analysis-usage.json'), 'old-usage');
    const files = Object.fromEntries(BUSINESS_FILES.map((name) => [name, `new-${name}`])) as Record<
      BusinessFile,
      string
    >;
    let count = 0;
    await expect(
      withBusinessExclusive(directory, () =>
        commitBusinessFiles(directory, files, async (source, destination) => {
          if (++count === 3) throw new Error('Synthetic full disk');
          await publishAtomicFile(source, destination);
        }),
      ),
    ).rejects.toThrow('Synthetic');
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe('old-products');
    expect(await readFile(join(directory, 'analysis-usage.json'), 'utf8')).toBe('old-usage');
    expect((await readdir(directory)).sort()).toEqual(['analysis-usage.json', 'products.json']);
  });
  it('recovers prepared crash state before an ordinary repository read exposes any partial import', async () => {
    const original = seed();
    const service = new WorkspaceBackupService(directory);
    const preview = await service.restore(original, {});
    await service.restore(original, {
      commit: true,
      confirmed: true,
      policy: 'skip',
      expectedRevision: preview.preview.revision,
    });
    const stage = join(directory, '.workspace-restore');
    await mkdir(stage);
    const entries = [];
    for (const name of BUSINESS_FILES) {
      const old = await readFile(join(directory, name), 'utf8');
      const next =
        name === 'products.json'
          ? old.replace('Synthetic workspace backup fixture', 'Partial crash import')
          : old;
      await writeFile(join(stage, `old-${name}`), old);
      await writeFile(join(stage, `new-${name}`), next);
      entries.push({ name, oldHash: hash(old), newHash: hash(next) });
      if (name === 'products.json') await writeFile(join(directory, name), next);
    }
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'prepared', entries }),
    );
    expect((await new LocalJsonProductRepository(directory).list())[0].title).toBe(
      'Synthetic workspace backup fixture',
    );
    expect(await readdir(directory)).not.toContain('.workspace-restore');
  });
  it('keeps committed data through interrupted cleanup and refuses corrupted or hostile journal paths', async () => {
    const stage = join(directory, '.workspace-restore');
    await mkdir(stage);
    const entries = [];
    for (const name of BUSINESS_FILES) {
      const next = `new-${name}`;
      await writeFile(join(directory, name), next);
      entries.push({ name, oldHash: null, newHash: hash(next) });
    }
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({ schemaVersion: 1, phase: 'committed', entries }),
    );
    await withBusinessOperation(directory, async () => undefined);
    expect(await readdir(directory)).not.toContain('.workspace-restore');
    await mkdir(stage);
    await writeFile(
      join(stage, 'journal.json'),
      JSON.stringify({
        schemaVersion: 1,
        phase: 'prepared',
        entries: [{ name: '../bridge-auth.json' }],
      }),
    );
    await expect(withBusinessOperation(directory, async () => undefined)).rejects.toThrow(
      '日志损坏',
    );
    expect(await readFile(join(directory, 'products.json'), 'utf8')).toBe('new-products.json');
    expect(await readFile(join(stage, 'journal.json'), 'utf8')).toContain('../bridge-auth');
  });
  it('holds restore until shared writes finish and permits nested operations without deadlock', async () => {
    const order: string[] = [];
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const wait = new Promise<void>((done) => {
      finish = done;
    });
    const normal = withBusinessOperation(directory, async () => {
      order.push('read');
      entered?.();
      await withBusinessOperation(directory, async () => order.push('nested'));
      await wait;
      order.push('saved');
    });
    await started;
    const restore = withBusinessExclusive(directory, async () => {
      order.push('restore');
    });
    await Promise.resolve();
    expect(order).toEqual(['read', 'nested']);
    finish?.();
    await Promise.all([normal, restore]);
    expect(order).toEqual(['read', 'nested', 'saved', 'restore']);
  });
});
describe('complete backup local API security', () => {
  const request = (headers: HeadersInit, value?: unknown): Request =>
    new Request('http://localhost:3000/api/workspace-backup', {
      method: value === undefined ? 'GET' : 'POST',
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    });
  it('requires authenticated web context and blocks extension or foreign-origin backup access', async () => {
    expect(
      (
        await GET(
          request({
            origin: 'http://localhost:3000',
            'sec-fetch-site': 'same-origin',
            'x-productspy-client': 'web',
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await GET(
          request({
            origin: `chrome-extension://${'a'.repeat(32)}`,
            'x-productspy-client': 'extension',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await POST(request({ ...webHeaders(), origin: 'https://evil.example' }, { backup: seed() })))
        .status,
    ).toBe(403);
    expect((await GET(request(webHeaders()))).status).toBe(200);
  });
  it('rejects undeclared secret fields, oversized declared bodies, and implicit restore commits', async () => {
    const headers = webHeaders();
    expect((await POST(request(headers, { backup: { ...seed(), apiKey: 'test' } }))).status).toBe(
      400,
    );
    expect(
      (
        await POST(
          request({ ...headers, 'content-length': String(101 * 1024 * 1024) }, { backup: seed() }),
        )
      ).status,
    ).toBe(413);
    expect((await POST(request(headers, { backup: seed(), commit: true }))).status).toBe(400);
  });
});
