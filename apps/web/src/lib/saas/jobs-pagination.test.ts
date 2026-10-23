import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as jobs } from '../../app/api/jobs/route';
import { closeDatabase, ensureDatabase, query } from './database';
import { withTenant } from './context';
import { issueSession } from './accounts';
import type { AccountJobsPage } from '../saas-types';

const origin = 'http://127.0.0.1:3000';
const alice = randomUUID();
const bob = randomUUID();
const newer = '2026-10-17T00:00:00.123456Z';
const older = '2026-10-17T00:00:00.123123Z';
const ownIds = Array.from(
  { length: 241 },
  (_, index) => `legacy-job-${String(index).padStart(4, '0')}`,
);
const expected = [...ownIds.slice(0, 215).reverse(), ...ownIds.slice(215).reverse()];
let aliceCookie: string;
let bobCookie: string;
const createdUsers: string[] = [];

function request(search = '', cookie = aliceCookie) {
  return jobs(
    new Request(`${origin}/api/jobs${search}`, {
      headers: {
        host: '127.0.0.1:3000',
        origin,
        'sec-fetch-site': 'same-origin',
        'x-productspy-client': 'web',
        cookie,
      },
    }),
  );
}
async function page(search = '', cookie = aliceCookie): Promise<AccountJobsPage> {
  const response = await request(search, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: AccountJobsPage }).data;
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const validAnchor = () => ({ version: 1, userId: alice, createdAt: newer, id: ownIds[0] });

beforeAll(async () => {
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_JOB_RUNNER', 'external');
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pg');
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', '0');
  } else {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
    vi.stubEnv('PRODUCTSPY_PGLITE_DIR', 'memory://');
  }
  vi.stubEnv('PRODUCTSPY_APP_URL', origin);
  await ensureDatabase();
  for (const id of [alice, bob]) {
    await query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      id,
      `${id}@example.invalid`,
      'synthetic-hash',
    ]);
    createdUsers.push(id);
    await withTenant(id, () =>
      query(
        `INSERT INTO jobs(user_id,id,kind,status,created_at,updated_at)
       SELECT $1,entry.id,'analysis','succeeded',entry.stamp::timestamptz,entry.stamp::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS entry(id text,stamp text)`,
        [
          id,
          JSON.stringify(
            (id === alice ? ownIds : ownIds.slice(0, 31)).map((jobId, index) => ({
              id: jobId,
              stamp: index < 215 ? newer : older,
            })),
          ),
        ],
      ),
    );
  }
  aliceCookie = `productspy_account=${(await issueSession(alice, 'web')).token}`;
  bobCookie = `productspy_account=${(await issueSession(bob, 'web')).token}`;
}, 30_000);
afterAll(async () => {
  try {
    if (createdUsers.length)
      await query('DELETE FROM users WHERE id=ANY($1::text[])', [createdUsers]);
  } finally {
    await closeDatabase();
    vi.unstubAllEnvs();
  }
});

describe('Task history route with real PostgreSQL SQL and tenant scopes', () => {
  it('preserves the default jobs array and exposes history beyond the previous 200-row ceiling', async () => {
    const first = await page();
    expect(first.jobs).toHaveLength(200);
    expect(first.jobs.map((job) => job.id)).toEqual(expected.slice(0, 200));
    expect(first.jobs[0]).toMatchObject({
      kind: 'analysis',
      status: 'succeeded',
      createdAt: '2026-10-17T00:00:00.123Z',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await page(`?cursor=${first.nextCursor}`);
    expect(second.jobs.map((job) => job.id)).toEqual(expected.slice(200));
    expect(second.nextCursor).toBeNull();
  });

  it('does not skip or duplicate equal timestamps, including distinct PostgreSQL microseconds within one millisecond', async () => {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await page(`?limit=23${cursor ? `&cursor=${cursor}` : ''}`);
      expect(result.jobs.length).toBeLessThanOrEqual(23);
      ids.push(...result.jobs.map((job) => job.id));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(241);
  });

  it('keeps users isolated even when their stored task IDs and timestamps are identical', async () => {
    const alicePage = await page('?limit=20');
    const bobPage = await page('?limit=20', bobCookie);
    expect(bobPage.jobs.map((job) => job.id)).toEqual(
      [...ownIds.slice(0, 31)].reverse().slice(0, 20),
    );
    expect((await request(`?cursor=${alicePage.nextCursor}`, bobCookie)).status).toBe(400);
    expect((await request(`?cursor=${bobPage.nextCursor}`)).status).toBe(400);
    expect((await request('', '')).status).toBe(401);
  });

  it.each([
    '',
    '***',
    'a'.repeat(1025),
    encode({}),
    encode({ ...validAnchor(), version: 2 }),
    encode({ ...validAnchor(), createdAt: '2026-10-40T00:00:00.123456Z' }),
    encode({ ...validAnchor(), createdAt: '2026-10-17T00:00:00.123Z' }),
    encode({ ...validAnchor(), id: 'a'.repeat(201) }),
    encode({ ...validAnchor(), id: '\0' }),
    encode({ ...validAnchor(), owner: bob }),
  ])('rejects invalid cursor input (%#)', async (cursor) => {
    expect((await request(`?cursor=${encodeURIComponent(cursor)}`)).status).toBe(400);
  });

  it.each(['0', '201', '-1', '1.5', 'NaN', '1e2', '', '01', '10&limit=20'])(
    'rejects invalid or ambiguous page sizes (%s)',
    async (limit) => {
      expect((await request(`?limit=${limit}`)).status).toBe(400);
    },
  );

  it('does not shift older pages when a newer task arrives between page requests', async () => {
    const first = await page('?limit=200');
    const inserted = 'new-arrival-after-page-one';
    await withTenant(alice, () =>
      query(
        `INSERT INTO jobs(user_id,id,kind,status,created_at,updated_at) VALUES($1,$2,'analysis','succeeded','2026-10-18T00:00:00Z',now())`,
        [alice, inserted],
      ),
    );
    try {
      const second = await page(`?cursor=${first.nextCursor}`);
      expect(second.jobs.map((job) => job.id)).toEqual(expected.slice(200));
      expect((await page('?limit=1')).jobs[0].id).toBe(inserted);
    } finally {
      await withTenant(alice, () =>
        query('DELETE FROM jobs WHERE user_id=$1 AND id=$2', [alice, inserted]),
      );
    }
  });
});
