import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runPendingAIJobsOnce } from './job-worker';

const mocks = vi.hoisted(() => ({
  query:
    vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(),
  handler: vi.fn<(request: Request) => Promise<Response>>(),
}));
vi.mock('./database', () => ({
  query: mocks.query,
  dbTransaction: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock('./context', () => ({
  withTenant: (_userId: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock('../../app/api/analyze-product/route', () => ({ POST: mocks.handler }));
vi.mock('../../app/api/analyze-comparison/route', () => ({ POST: mocks.handler }));
vi.mock('../../app/api/generate-content/route', () => ({ POST: mocks.handler }));

beforeEach(() => {
  vi.stubEnv('PRODUCTSPY_APP_URL', 'https://worker-test.invalid');
  vi.stubEnv('PRODUCTSPY_WORKER_CONCURRENCY', undefined);
  mocks.query.mockImplementation(async (sql, params) => {
    let rows: unknown[] = [];
    if (sql.startsWith('SELECT user_id,id FROM job_dispatch')) {
      rows = Array.from({ length: Number(params?.[0]) }, (_, index) => ({
        user_id: `owner-${index}`,
        id: `job-${index}`,
      }));
    } else if (sql.startsWith('SELECT payload,status')) {
      rows = [{ status: 'queued', payload: { endpoint: '/api/analyze-product', input: {} } }];
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
