import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANALYSIS_OPTIONS,
  DEFAULT_CONTENT_OPTIONS,
  builtinTemplates,
  type AISelection,
  type Product,
} from '@productspy/shared';
import { POST as analyzeProduct } from '../../app/api/analyze-product/route';
import { POST as analyzeComparison } from '../../app/api/analyze-comparison/route';
import { POST as generateContent } from '../../app/api/generate-content/route';
import { MockAIProvider } from '../ai/mock-provider';
import type { ResolvedAIExecution } from '../ai/channels';
import { getAnalysisUsageLedger } from './analysis-usage';
import { getComparisonRepository } from './comparison-repository';
import { getContentRepository } from './content-repository';
import { getProductRepository } from './product-repository';
import { webHeaders } from './test-auth';
import { AppError } from './errors';

// These are route-control tests with synthetic provider output. They do not validate
// real model quality, real credentials, or external provider availability.
const mocks = vi.hoisted(() => ({
  resolve: vi.fn<(selection: AISelection) => Promise<ResolvedAIExecution>>(),
  create: vi.fn(),
  current: vi.fn<() => ResolvedAIExecution | undefined>(),
}));
vi.mock('../ai/channels', () => ({
  resolveAIExecution: mocks.resolve,
  createAIProviderForExecution: mocks.create,
  currentAIExecution: mocks.current,
}));

const chosen: ResolvedAIExecution = {
  version: 1,
  channelId: 'selected-channel',
  channelLabel: 'Synthetic selected channel',
  provider: 'deepseek',
  model: 'allowed-model',
  mode: 'real',
  configurationFingerprint: 'c'.repeat(64),
};

describe('analysis, comparison and content route channel selection', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-channel-routes-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    mocks.resolve.mockResolvedValue(chosen);
    mocks.current.mockReturnValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it.each(['product', 'comparison', 'content'] as const)(
    '%s binds one server decision to consent, provider, result metadata, usage and replay',
    async (kind) => {
      const products: Product[] = [];
      for (const asin of ['B023AI0001', 'B023AI0002'])
        products.push(
          await getProductRepository().upsert({
            source: 'amazon',
            sourceId: asin,
            url: `https://www.amazon.com/dp/${asin}`,
            title: `Synthetic channel route ${asin}`,
            images: [],
            videos: [],
            bulletPoints: ['Unverified merchant test claim'],
          }),
        );
      const product = products[0]!;
      const comparison = await getComparisonRepository().create('Synthetic comparison', products);
      const content = await getContentRepository().create(
        'Synthetic content',
        product,
        builtinTemplates[0]!,
        DEFAULT_CONTENT_OPTIONS,
      );
      const mock = new MockAIProvider();
      const generated = vi.fn().mockImplementation(() => mock.generate(product));
      const compare = vi.fn().mockImplementation(() => mock.compare(products));
      const createContent = vi.fn().mockImplementation(() => mock.createContent(content));
      mocks.create.mockResolvedValue({
        analyze: mock.analyze.bind(mock),
        generate: generated,
        compare,
        createContent,
      });
      const endpoint =
        kind === 'product'
          ? 'analyze-product'
          : kind === 'comparison'
            ? 'analyze-comparison'
            : 'generate-content';
      const handler =
        kind === 'product'
          ? analyzeProduct
          : kind === 'comparison'
            ? analyzeComparison
            : generateContent;
      const send = (input: unknown) =>
        handler(
          new Request(`http://127.0.0.1:3000/api/${endpoint}`, {
            method: 'POST',
            headers: webHeaders('http://127.0.0.1:3000'),
            body: JSON.stringify(input),
          }),
        );
      const body = {
        ...(kind === 'product'
          ? { product, options: DEFAULT_ANALYSIS_OPTIONS }
          : kind === 'comparison'
            ? {
                comparisonId: comparison.id,
                expectedUpdatedAt: comparison.updatedAt,
                options: DEFAULT_ANALYSIS_OPTIONS,
              }
            : {
                planId: content.id,
                expectedUpdatedAt: content.updatedAt,
                options: DEFAULT_CONTENT_OPTIONS,
              }),
        requestId: randomUUID(),
        channelId: chosen.channelId,
        model: chosen.model,
      };
      for (const injected of [
        { apiKey: 'synthetic-do-not-send' },
        { baseUrl: 'https://untrusted.invalid/v1' },
        { execution: chosen },
      ])
        expect((await send({ ...body, ...injected, authorizeReal: true })).status).toBe(400);
      expect(mocks.resolve).not.toHaveBeenCalled();
      expect((await send(body)).status).toBe(428);
      expect(mocks.create).not.toHaveBeenCalled();
      expect((await getAnalysisUsageLedger().report()).records).toHaveLength(0);
      mocks.resolve.mockClear();
      const response = await send({ ...body, authorizeReal: true });
      expect(response.status).toBe(200);
      const saved = (await response.json()) as {
        data: { metadata?: unknown; version?: { metadata?: unknown } };
      };
      expect(saved.data.metadata ?? saved.data.version?.metadata).toMatchObject({
        channelId: chosen.channelId,
        channelLabel: chosen.channelLabel,
        provider: chosen.provider,
        model: chosen.model,
        mode: chosen.mode,
      });
      expect(JSON.stringify(saved)).not.toContain('configurationFingerprint');
      expect(mocks.create).toHaveBeenCalledExactlyOnceWith(chosen);
      const record = await getAnalysisUsageLedger().get(body.requestId);
      expect(record?.execution).toEqual(chosen);
      const publicUsage = (await getAnalysisUsageLedger().report()).records[0];
      expect(publicUsage).toMatchObject({
        channelId: chosen.channelId,
        provider: chosen.provider,
        model: chosen.model,
      });
      expect(publicUsage).not.toHaveProperty('execution');
      expect(publicUsage).not.toHaveProperty('fingerprint');

      // A completed request remains replayable after a configuration change.
      mocks.resolve.mockRejectedValue(new AppError(503, 'Synthetic channel disabled'));
      const replay = await send({ ...body, authorizeReal: true });
      expect(replay.status).toBe(200);
      expect((await replay.json()) as unknown).toMatchObject({ data: { replayed: true } });
      expect(mocks.resolve).toHaveBeenCalledTimes(1);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect((await send({ ...body, authorizeReal: true, model: 'changed-model' })).status).toBe(
        409,
      );
      expect(
        (await send({ ...body, authorizeReal: true, channelId: 'changed-channel' })).status,
      ).toBe(409);
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(
        generated.mock.calls.length + compare.mock.calls.length + createContent.mock.calls.length,
      ).toBe(1);
    },
  );
});
