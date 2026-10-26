import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AISelection } from '@productspy/shared';
import { enqueueAIJob } from './jobs';
import type { ResolvedAIExecution } from '../ai/channels';
import { AppError } from '../server/errors';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  consume: vi.fn(),
  resolve: vi.fn<(selection: AISelection) => Promise<ResolvedAIExecution>>(),
}));
vi.mock('./database', () => ({
  query: mocks.query,
  dbTransaction: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('./context', () => ({ currentUserId: () => 'test-owner' }));
vi.mock('./entitlements', () => ({ consumeAIAllowance: mocks.consume }));
vi.mock('../ai/channels', () => ({ resolveAIExecution: mocks.resolve }));

const chosen: ResolvedAIExecution = {
  version: 1,
  channelId: 'deepseek-test',
  channelLabel: 'Synthetic test channel',
  provider: 'deepseek',
  model: 'allowed-model',
  mode: 'real',
  configurationFingerprint: 'b'.repeat(64),
};
let persisted: Map<string, { payload: unknown; status: string }>;
beforeEach(() => {
  persisted = new Map();
  mocks.consume.mockResolvedValue(undefined);
  mocks.resolve.mockResolvedValue(chosen);
  mocks.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith('SELECT payload,status')) {
      const job = persisted.get(String(params[1]));
      return { rows: job ? [job] : [], rowCount: job ? 1 : 0 };
    }
    if (sql.startsWith('INSERT INTO jobs'))
      persisted.set(String(params[1]), {
        payload: JSON.parse(String(params[3])),
        status: 'queued',
      });
    return { rows: [], rowCount: 1 };
  });
});
afterEach(() => vi.resetAllMocks());

function task(input: Record<string, unknown> = {}) {
  return {
    endpoint: '/api/analyze-comparison',
    input: {
      comparisonId: randomUUID(),
      expectedUpdatedAt: '2026-10-23T00:00:00.000Z',
      requestId: randomUUID(),
      channelId: chosen.channelId,
      model: chosen.model,
      authorizeReal: true,
      ...input,
    },
  };
}

describe('AI queue immutable channel selection and acceptance', () => {
  it('persists the verified selection before dispatch and reserves once across a lost response', async () => {
    const body = task();
    expect(await enqueueAIJob(body)).toMatchObject({ status: 'queued', replayed: false });
    expect(persisted.get(String(body.input.requestId))?.payload).toMatchObject({
      input: { channelId: chosen.channelId, model: chosen.model },
      execution: chosen,
    });
    expect(mocks.consume).toHaveBeenCalledExactlyOnceWith(body.input.requestId);
    // The channel is later disabled/replaced. Retrying the original accepted POST
    // only returns its status and must not resolve a new channel or spend again.
    mocks.resolve.mockRejectedValue(new AppError(503, 'Synthetic channel disabled'));
    expect(await enqueueAIJob(body)).toMatchObject({ replayed: true });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(mocks.consume).toHaveBeenCalledTimes(1);
    await expect(
      enqueueAIJob({ ...body, input: { ...body.input, model: 'another-model' } }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      enqueueAIJob({ ...body, input: { ...body.input, channelId: 'another-channel' } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
  });

  it('does not reinterpret an accepted default when the administrator changes it', async () => {
    const body = task({ channelId: undefined, model: undefined });
    await enqueueAIJob(body);
    mocks.resolve.mockResolvedValue({
      ...chosen,
      channelId: 'changed-default',
      model: 'new-model',
    });
    expect(await enqueueAIJob(body)).toMatchObject({ replayed: true });
    expect(mocks.resolve).toHaveBeenCalledTimes(1);
    expect(persisted.get(String(body.input.requestId))?.payload).toMatchObject({
      execution: chosen,
    });
  });

  it('requires consent for the resolved real channel before consuming quota', async () => {
    await expect(enqueueAIJob(task({ authorizeReal: false }))).rejects.toMatchObject({
      status: 428,
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(persisted.size).toBe(0);
  });

  it('does not charge quota for an unknown or disallowed model', async () => {
    mocks.resolve.mockRejectedValue(new AppError(400, 'Synthetic unavailable model'));
    await expect(enqueueAIJob(task({ model: 'not-allowed' }))).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.consume).not.toHaveBeenCalled();
    expect(persisted.size).toBe(0);
  });

  it.each([
    { apiKey: 'synthetic-never-use-this-key' },
    { baseUrl: 'https://untrusted.invalid/v1' },
    { execution: chosen },
    { comparisonId: 'invalid-id' },
    { options: { language: 'invalid-language' } },
  ])('rejects invalid or client-controlled provider data before quota: %j', async (extra) => {
    await expect(enqueueAIJob(task(extra))).rejects.toMatchObject({ status: 400 });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
