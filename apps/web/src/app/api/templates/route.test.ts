import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  builtinTemplates,
  templateDefinition,
  type AITemplate,
  type ApiResult,
} from '@productspy/shared';
import { webHeaders } from '../../../lib/server/test-auth';
import { generatePairCode, pairExtension } from '../../../lib/server/auth';
import { GET, POST, OPTIONS } from './route';
import { DELETE, PATCH, GET as getTemplate } from './[id]/route';
import { GET as getBackup, POST as importBackup } from './backup/route';

describe('protected templates API', () => {
  let directory: string;
  let headers: Record<string, string>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'productspy-template-api-'));
    vi.stubEnv('PRODUCTSPY_DATA_DIR', directory);
    headers = webHeaders();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function request(
    path = '',
    method = 'GET',
    body?: unknown,
    overrides: Record<string, string> = {},
  ): Request {
    return new Request(`http://localhost:3000/api/templates${path}`, {
      method,
      headers: { ...headers, ...overrides },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function data<T>(response: Response): Promise<T> {
    const parsed = (await response.json()) as ApiResult<T>;
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.data;
  }
  const definition = () => ({ ...templateDefinition(builtinTemplates[0]!), name: 'User template' });
  it('allows authenticated CRUD, retains histories, and requires confirmed deletion', async () => {
    const created = await data<AITemplate>(await POST(request('', 'POST', definition())));
    const context = { params: Promise.resolve({ id: created.id }) };
    expect((await data<AITemplate>(await getTemplate(request(`/${created.id}`), context))).id).toBe(
      created.id,
    );
    const edited = await data<AITemplate>(
      await PATCH(
        request(`/${created.id}`, 'PATCH', {
          expectedUpdatedAt: created.updatedAt,
          definition: { ...definition(), prompt: 'Updated {{product_title}}' },
        }),
        context,
      ),
    );
    expect(edited.versions).toHaveLength(2);
    expect(
      (
        await DELETE(
          request(`/${created.id}`, 'DELETE', { expectedUpdatedAt: edited.updatedAt }),
          context,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await DELETE(
          request(`/${created.id}`, 'DELETE', {
            expectedUpdatedAt: edited.updatedAt,
            confirmed: true,
          }),
          context,
        )
      ).status,
    ).toBe(200);
  });
  it('rejects anonymous reads, cross-origin writes, missing CSRF headers and paired extension access', async () => {
    expect((await GET(request('', 'GET', undefined, { cookie: '' }))).status).toBe(401);
    expect(
      (await POST(request('', 'POST', definition(), { origin: 'https://evil.example' }))).status,
    ).toBe(403);
    expect((await POST(request('', 'POST', definition(), { origin: '' }))).status).toBe(403);
    expect(
      (await POST(request('', 'POST', definition(), { 'x-productspy-client': '' }))).status,
    ).toBe(403);
    const origin = `chrome-extension://${'d'.repeat(32)}`;
    const { token } = await pairExtension(origin, generatePairCode().code);
    const extensionHeaders = {
      origin,
      cookie: '',
      'x-productspy-client': 'extension',
      authorization: `Bearer ${token}`,
    };
    expect((await GET(request('', 'GET', undefined, extensionHeaders))).status).toBe(403);
    expect((await POST(request('', 'POST', definition(), extensionHeaders))).status).toBe(403);
    expect((await getBackup(request('/backup', 'GET', undefined, extensionHeaders))).status).toBe(
      403,
    );
    expect(
      (await importBackup(request('/backup', 'POST', { backup: {} }, extensionHeaders))).status,
    ).toBe(403);
    expect(
      (
        await OPTIONS(
          request('', 'OPTIONS', undefined, { origin, 'access-control-request-method': 'POST' }),
        )
      ).status,
    ).toBe(403);
  });
  it('validates variables, denies builtin deletion and refuses history-plus-edit ambiguous requests', async () => {
    expect(
      (await POST(request('', 'POST', { ...definition(), prompt: '{{api_key}}' }))).status,
    ).toBe(400);
    const builtin = builtinTemplates[0]!;
    expect(
      (
        await DELETE(
          request(`/${builtin.id}`, 'DELETE', {
            expectedUpdatedAt: builtin.updatedAt,
            confirmed: true,
          }),
          { params: Promise.resolve({ id: builtin.id }) },
        )
      ).status,
    ).toBe(403);
    const created = await data<AITemplate>(await POST(request('', 'POST', definition())));
    expect(
      (
        await PATCH(
          request(`/${created.id}`, 'PATCH', {
            expectedUpdatedAt: created.updatedAt,
            definition: definition(),
            restoreVersionId: created.versions[0]!.id,
          }),
          { params: Promise.resolve({ id: created.id }) },
        )
      ).status,
    ).toBe(400);
  });
  it('requires import preview revision and never overwrites existing template histories', async () => {
    const created = await data<AITemplate>(await POST(request('', 'POST', definition())));
    const backup = await data<unknown>(await getBackup(request('/backup')));
    const preview = await data<{ revision: string; skipped: number }>(
      await importBackup(request('/backup', 'POST', { backup })),
    );
    expect(preview.skipped).toBe(1);
    expect(
      (await importBackup(request('/backup', 'POST', { backup, commit: true, policy: 'skip' })))
        .status,
    ).toBe(409);
    expect(
      (
        await importBackup(
          request('/backup', 'POST', {
            backup,
            commit: true,
            expectedRevision: preview.revision,
            policy: 'skip',
          }),
        )
      ).status,
    ).toBe(200);
    const reloaded = await data<AITemplate>(
      await getTemplate(request(`/${created.id}`), { params: Promise.resolve({ id: created.id }) }),
    );
    expect(reloaded).toEqual(created);
  });
});
