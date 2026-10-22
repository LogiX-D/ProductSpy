import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAIJob, runPendingAIJobsOnce } from './job-worker';
import { AppError } from '../server/errors';
import type { ResolvedAIExecution } from '../ai/channels';

const execution: ResolvedAIExecution = {
  version: 1,
  channelId: 'chosen',
  channelLabel: 'Owned test channel',
  provider: 'openai',
  model: 'synthetic-model',
  mode: 'real',
  configurationFingerprint: 'a'.repeat(64),
};

const mocks = vi.hoisted(() => ({
  query:
    vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
  handler: vi.fn<(request: Request) => Promise<Response>>(),
  verify: vi.fn<(execution: ResolvedAIExecution) => Promise<void>>(),
  withExecution: vi.fn((_: ResolvedAIExecution, operation: () => Promise<unknown>) => operation()),
}));
vi.mock('./database', () => ({
  query: mocks.query,
  dbTransaction: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('./context', () => ({
  withTenant: (_userId: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../ai/channels', () => ({
  verifyAIExecution: mocks.verify,
  withAIExecution: mocks.withExecution,
}));
vi.mock('../../app/api/analyze-product/route', () => ({ POST: mocks.handler }));
vi.mock('../../app/api/analyze-comparison/route', () => ({ POST: mocks.handler }));
vi.mock('../../app/api/generate-content/route', () => ({ POST: mocks.handler }));

beforeEach(() => {
  vi.stubEnv('PRODUCTSPY_APP_URL', 'https://worker-test.invalid');
  vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', undefined);
  mocks.verify.mockResolvedValue(undefined);
  mocks.withExecution.mockImplementation((_, operation) => operation());
  mocks.query.mockImplementation(async (sql, params) => {
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT user_id,id FROM job_dispatch')) {
      rows = Array.from({ length: Number(params?.[0]) }, (_, index) => ({
        user_id: `owner-${index}`,
        id: `job-${index}`,
      }));
    } else if (sql.startsWith('SELECT payload,status')) {
      rows = [
        { status: 'queued', payload: { endpoint: '/api/analyze-product', input: {}, execution } },
      ];
    } else if (sql.startsWith('SELECT id,email,name,created_at')) {
      rows = [
        {
          id: params?.[0],
          email: 'synthetic@example.invalid',
          name: 'Test',
          created_at: new Date(),
        },
      ];
    }
    return { rows, rowCount: rows.length };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('Worker claim and execution concurrency', () => {
  it('uses only the persisted, verified server execution when running a handler', async () => {
    mocks.handler.mockResolvedValue(Response.json({ ok: true }));
    expect(await runAIJob('owner', 'job')).toBe(true);
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(execution);
    expect(mocks.withExecution).toHaveBeenCalledWith(execution, expect.any(Function));
    expect(mocks.handler).toHaveBeenCalledTimes(1);
    const request = mocks.handler.mock.calls[0]![0];
    expect(request.headers.has('x-productspy-ai-execution')).toBe(false);
    expect(await request.json()).not.toHaveProperty('execution');
  });
  it('fails a historical job without an execution snapshot instead of choosing the current default', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{ status: 'queued', payload: { endpoint: '/api/analyze-product', input: {} } }],
      rowCount: 1,
    });
    expect(await runAIJob('owner', 'job')).toBe(true);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE jobs SET status='failed'"),
      [expect.stringContaining('缺少历史执行快照'), 'owner', 'job'],
    );
  });
  it('does not call a provider or another channel after persisted configuration changes', async () => {
    mocks.verify.mockRejectedValue(new AppError(503, 'Synthetic channel configuration changed'));
    expect(await runAIJob('owner', 'job')).toBe(true);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
    expect(mocks.withExecution).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });
  it.each([
    { configured: '1', requested: 10, expected: 1 },
    { configured: '2', requested: undefined, expected: 2 },
    { configured: '2', requested: 1, expected: 1 },
  ])(
    'limits claimed and simultaneously running jobs: %j',
    async ({ configured, requested, expected }) => {
      vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', configured);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let active = 0;
      let peak = 0;
      mocks.handler.mockImplementation(async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
        return Response.json({ ok: true });
      });
      const running = runPendingAIJobsOnce(requested);
      try {
        await vi.waitFor(() => expect(mocks.handler).toHaveBeenCalledTimes(expected));
        expect(mocks.query.mock.calls[0][1]).toEqual([expected]);
        expect(peak).toBe(expected);
      } finally {
        release();
      }
      expect(await running).toBe(expected);
      expect(active).toBe(0);
    },
  );
  it('refuses invalid concurrency before claiming any job', async () => {
    vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', '0');
    await expect(runPendingAIJobsOnce()).rejects.toThrow('PRODUCTSPY_WORKER_CONCURRENCY');
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, 11, NaN])('refuses invalid caller limits: %j', async (limit) => {
    await expect(runPendingAIJobsOnce(limit)).rejects.toThrow('Worker batch limit');
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
