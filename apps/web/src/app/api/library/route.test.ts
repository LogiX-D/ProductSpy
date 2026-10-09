import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ApiResult, type LibrarySnapshot } from '@productspy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProductRepository } from '../../../lib/server/product-repository';
import { webHeaders } from '../../../lib/server/test-auth';
import { generatePairCode, pairExtension } from '../../../lib/server/auth';
import { GET, POST, OPTIONS } from './route';
import { POST as batch } from './batch/route';

describe('protected library API', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-library-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function request(
    path = '',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return new Request(`http://localhost:3000/api/library${path}`, {
      method,
      headers: { ...webHeaders(), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function data(response: Response): Promise<LibrarySnapshot> {
    const result = (await response.json()) as ApiResult<LibrarySnapshot>;
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }

  it('provides snapshots and creates/renames/deletes definitions only with authenticated confirmation', async () => {
    expect((await GET(request('', 'GET', undefined, { cookie: '' }))).status).toBe(401);
    const created = await POST(
      request('', 'POST', { kind: 'tag', action: 'create', name: 'Priority', color: '#AABBCC' }),
    );
    expect(created.status).toBe(200);
    const tag = (await data(created)).tags[0]!;
    expect(tag).toMatchObject({ name: 'Priority', color: '#AABBCC' });
    const renamed = await POST(
      request('', 'POST', { kind: 'tag', action: 'rename', id: tag.id, name: 'Chosen' }),
    );
    expect((await data(renamed)).tags[0]?.name).toBe('Chosen');
    expect(
      (await POST(request('', 'POST', { kind: 'tag', action: 'delete', id: tag.id }))).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request('', 'POST', { kind: 'tag', action: 'delete', id: tag.id, confirmed: true }),
        )
      ).status,
    ).toBe(200);
    expect((await data(await GET(request()))).tags).toEqual([]);
  });

  it('preserves strict same-origin/CSRF checks and never accepts even a paired extension token', async () => {
    expect(
      (
        await POST(
          request(
            '',
            'POST',
            { kind: 'group', action: 'create', name: 'Blocked' },
            { origin: 'https://evil.example' },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await POST(
          request('', 'POST', { kind: 'group', action: 'create', name: 'Blocked' }, { origin: '' }),
        )
      ).status,
    ).toBe(403);
    const origin = `chrome-extension://${'c'.repeat(32)}`;
    const { token } = await pairExtension(origin, generatePairCode().code);
    const headers = {
      origin,
      'x-productspy-client': 'extension',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
    const extensionRead = new Request('http://localhost:3000/api/library', { headers });
    expect((await GET(extensionRead)).status).toBe(403);
    const extensionWrite = new Request('http://localhost:3000/api/library', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'group', action: 'create', name: 'Blocked' }),
    });
    expect((await POST(extensionWrite)).status).toBe(403);
    const extensionBatch = new Request('http://localhost:3000/api/library/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['missing'], operation: 'delete', confirmed: true }),
    });
    expect((await batch(extensionBatch)).status).toBe(403);
    const preflight = await OPTIONS(
      new Request('http://localhost:3000/api/library', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      }),
    );
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*');
    expect((await data(await GET(request()))).groups).toEqual([]);
  });

  it('returns explicit batch success/failure counts and rejects destructive operations without confirmation', async () => {
    const product = await getProductRepository().upsert({
      source: 'amazon',
      sourceId: 'B012345678',
      url: 'https://www.amazon.com/dp/B012345678',
      title: 'Synthetic bottle',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    const snapshot = await data(
      await POST(request('', 'POST', { kind: 'group', action: 'create', name: 'Kitchen' })),
    );
    const groupId = snapshot.groups[0]!.id;
    const result = await batch(
      request('/batch', 'POST', {
        ids: [product.id, 'missing'],
        operation: 'add-groups',
        groupIds: [groupId],
        expectedUpdatedAt: { [product.id]: product.updatedAt, missing: product.updatedAt },
      }),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({
      ok: true,
      data: { succeededIds: [product.id], failures: [{ id: 'missing' }] },
    });
    const before = await getProductRepository().get(product.id);
    expect(
      (await batch(request('/batch', 'POST', { ids: [product.id], operation: 'delete' }))).status,
    ).toBe(400);
    expect(await getProductRepository().get(product.id)).toEqual(before);
  });

  it('rejects malformed JSON, schema fields, media-like colors and duplicate names without partial writes', async () => {
    expect(
      (
        await POST(
          new Request('http://localhost:3000/api/library', {
            method: 'POST',
            headers: webHeaders(),
            body: '{bad',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request('', 'POST', {
            kind: 'tag',
            action: 'create',
            name: 'Test',
            color: 'url(javascript:alert(1))',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request('', 'POST', { kind: 'tag', action: 'create', name: 'Test', admin: true }),
        )
      ).status,
    ).toBe(400);
    await POST(request('', 'POST', { kind: 'tag', action: 'create', name: 'Test' }));
    expect(
      (await POST(request('', 'POST', { kind: 'tag', action: 'create', name: 'test' }))).status,
    ).toBe(409);
    expect((await data(await GET(request()))).tags).toHaveLength(1);
  });
});
