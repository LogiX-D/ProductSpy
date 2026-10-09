import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webHeaders } from '../../../lib/server/test-auth';
import { GET } from './route';

describe('analysis-usage API', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-usage-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  it('requires the workspace session and returns local empty usage rather than exposing configuration', async () => {
    const headers = webHeaders('http://127.0.0.1:3000');
    const unauthorized = await GET(
      new Request('http://127.0.0.1:3000/api/analysis-usage', {
        headers: { ...headers, cookie: '' },
      }),
    );
    expect(unauthorized.status).toBe(401);
    const response = await GET(
      new Request('http://127.0.0.1:3000/api/analysis-usage', { headers }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { records: unknown[]; totals: { requests: number } };
    };
    expect(body.data.records).toEqual([]);
    expect(body.data.totals.requests).toBe(0);
    expect(JSON.stringify(body)).not.toContain('AI_API_KEY');
  });
});
