import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiChannelInputSchema,
  type AIChannelCatalog,
  type AIChannelInput,
  type AIAdminChannelSettings,
} from '@productspy/shared';
import { POST as register } from '../../app/api/auth/register/route';
import { GET as catalog } from '../../app/api/ai/channels/route';
import { GET as adminGet, PUT as adminPut } from '../../app/api/admin/ai-channels/route';
import { closeDatabase, dbTransaction, ensureDatabase, query } from '../saas/database';
import { withTenant } from '../saas/context';
import {
  getAIAdminChannelSettings,
  loadAIChannelSettings,
  saveAIChannelSettings,
} from './channel-store';
import {
  createAIProviderForExecution,
  getAIChannelCatalog,
  resolveAIExecution,
  verifyAIExecution,
  withAIExecution,
} from './channels';

const origin = 'http://127.0.0.1:3000';
const master = 'synthetic-ai-channel-master-key-2026-for-local-tests';
const runId = randomUUID();
interface Account {
  id: string;
  cookie: string;
}
let directory: string;
let administrator: Account, customer: Account;
function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  extra: Record<string, string> = {},
): Request {
  return new Request(origin + path, {
    method,
    headers: {
      host: '127.0.0.1:3000',
      origin,
      'x-productspy-client': 'web',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function data<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!body.ok) throw new Error(String(response.status) + ': ' + body.error);
  return body.data as T;
}
async function account(label: string): Promise<Account> {
  const response = await register(
    request('/api/auth/register', 'POST', {
      email: 'ai-channels-' + label + '-' + runId + '@example.invalid',
      password: 'Synthetic-test-password-2026',
      name: label,
    }),
  );
  expect(response.status).toBe(200);
  return {
    id: (await data<{ user: { id: string } }>(response)).user.id,
    cookie: response.headers.get('set-cookie')!.split(';')[0],
  };
}
function channel(id = 'first', changes: Partial<AIChannelInput> = {}): AIChannelInput {
  return aiChannelInputSchema.parse({
    id,
    label: 'Synthetic ' + id,
    provider: 'openai',
    baseUrl: 'https://' + id + '.example.invalid/v1',
    models: [
      { id: 'model-one', label: 'Model one' },
      { id: 'model-two', label: 'Model two' },
    ],
    defaultModel: 'model-one',
    enabled: true,
    apiKey: 'synthetic-provider-key-' + id,
    ...changes,
  });
}
async function cleanupSettings(): Promise<void> {
  await withTenant(administrator.id, () =>
    dbTransaction(async () => {
      await query("SELECT set_config('app.ai_configuration_access','trusted-server',true)");
      await query("DELETE FROM ai_channel_settings WHERE id='global' AND updated_by=$1", [
        administrator.id,
      ]);
    }),
  );
}
async function save(
  channels = [channel(), channel('second', { provider: 'deepseek' })],
  revision = 0,
  defaultChannelId = 'first',
) {
  return withTenant(administrator.id, () =>
    saveAIChannelSettings({ channels, revision, defaultChannelId }),
  );
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'productspy-ai-channels-'));
  vi.stubEnv('PRODUCTSPY_MODE', 'saas');
  vi.stubEnv('PRODUCTSPY_APP_URL', origin);
  if (process.env.PRODUCTSPY_TEST_DATABASE_URL) {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pg');
    vi.stubEnv('DATABASE_URL', process.env.PRODUCTSPY_TEST_DATABASE_URL);
    vi.stubEnv('PRODUCTSPY_AUTO_MIGRATE', process.env.PRODUCTSPY_TEST_AUTO_MIGRATE ?? '0');
  } else {
    vi.stubEnv('PRODUCTSPY_DB_DRIVER', 'pglite');
    vi.stubEnv('PRODUCTSPY_PGLITE_DIR', join(directory, 'database'));
  }
  await ensureDatabase();
  administrator = await account('administrator');
  customer = await account('customer');
}, 30000);
beforeEach(async () => {
  vi.stubEnv('AI_MODE', 'auto');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('PRODUCTSPY_AI_ADMIN_IDS', administrator.id);
  vi.stubEnv('PRODUCTSPY_AI_CHANNEL_SECRET', master);
  await cleanupSettings();
  vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('This configuration test must never call a real provider');
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await cleanupSettings();
  await query('DELETE FROM users WHERE id=ANY($1::text[])', [[administrator.id, customer.id]]);
  await closeDatabase();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('platform AI configuration and execution with actual database routes', () => {
  it('requires write Origin, JSON and the web client even for a designated administrator', async () => {
    const input = { revision: 0, defaultChannelId: 'first', channels: [channel()] };
    const missingOrigin = request('/api/admin/ai-channels', 'PUT', input, administrator.cookie);
    missingOrigin.headers.delete('origin');
    expect((await adminPut(missingOrigin)).status).toBe(403);
    const invalidClient = request('/api/admin/ai-channels', 'PUT', input, administrator.cookie);
    invalidClient.headers.delete('x-productspy-client');
    expect((await adminPut(invalidClient)).status).toBe(403);
    const invalidType = request('/api/admin/ai-channels', 'PUT', input, administrator.cookie, {
      'content-type': 'text/plain',
    });
    expect((await adminPut(invalidType)).status).toBe(415);
    expect(
      (
        await adminPut(
          request('/api/admin/ai-channels', 'PUT', input, administrator.cookie, {
            origin: 'https://attacker.example.invalid',
          }),
        )
      ).status,
    ).toBe(403);
    expect(await withTenant(administrator.id, () => loadAIChannelSettings())).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a website account and server-designated administrator ID', async () => {
    expect((await catalog(request('/api/ai/channels'))).status).toBe(401);
    expect((await adminGet(request('/api/admin/ai-channels'))).status).toBe(401);
    expect(
      (await adminGet(request('/api/admin/ai-channels', 'GET', undefined, customer.cookie))).status,
    ).toBe(403);
    expect(
      (await adminPut(request('/api/admin/ai-channels', 'PUT', {}, customer.cookie))).status,
    ).toBe(403);
    expect(
      (
        await adminGet(
          request('/api/admin/ai-channels', 'GET', undefined, administrator.cookie, {
            origin: 'chrome-extension://' + 'a'.repeat(32),
            'x-productspy-client': 'extension',
            'sec-fetch-site': 'none',
          }),
        )
      ).status,
    ).toBe(403);
    vi.stubEnv('PRODUCTSPY_AI_ADMIN_IDS', 'administrator@example.invalid');
    await expect(withTenant(administrator.id, () => getAIAdminChannelSettings())).rejects.toThrow(
      '账号 ID',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports missing master-key setup without accepting a new configuration', async () => {
    vi.stubEnv('PRODUCTSPY_AI_CHANNEL_SECRET', '');
    const view = await data<AIAdminChannelSettings>(
      await adminGet(request('/api/admin/ai-channels', 'GET', undefined, administrator.cookie)),
    );
    expect(view.editable).toBe(false);
    expect(view.presets).toHaveLength(14);
    await expect(save()).rejects.toThrow('加密主密钥');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves encrypted settings, returns only redacted admin keys and a safe user catalog', async () => {
    const response = await adminPut(
      request(
        '/api/admin/ai-channels',
        'PUT',
        {
          revision: 0,
          defaultChannelId: 'first',
          channels: [channel(), channel('second')],
        },
        administrator.cookie,
      ),
    );
    expect(response.status).toBe(200);
    const view = await data<AIAdminChannelSettings>(response);
    expect(view.revision).toBe(1);
    expect(view.channels[0].apiKeyConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('synthetic-provider-key');
    const stored = await withTenant(administrator.id, () =>
      dbTransaction(async () => {
        await query("SELECT set_config('app.ai_configuration_access','trusted-server',true)");
        return query<{ encrypted_payload: string }>(
          "SELECT encrypted_payload FROM ai_channel_settings WHERE id='global'",
        );
      }),
    );
    expect(stored.rows[0].encrypted_payload).toMatch(/^v1:/);
    expect(stored.rows[0].encrypted_payload).not.toMatch(
      /synthetic-provider-key|example\.invalid|model-one/,
    );
    const userView = await data<AIChannelCatalog>(
      await catalog(request('/api/ai/channels', 'GET', undefined, customer.cookie)),
    );
    expect(userView.defaultChannelId).toBe('first');
    expect(userView.canManage).toBe(false);
    expect(userView.channels.map((item) => item.id)).toEqual(['mock', 'first', 'second']);
    expect(JSON.stringify(userView)).not.toMatch(
      /apiKey|baseUrl|example\.invalid|configurationFingerprint|SECRET/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows only administrator-approved models and channels, never client credentials', async () => {
    await save();
    await withTenant(customer.id, async () => {
      expect((await resolveAIExecution({ channelId: 'second', model: 'model-two' })).model).toBe(
        'model-two',
      );
      await expect(
        resolveAIExecution({ channelId: 'first', model: 'unapproved-model' }),
      ).rejects.toThrow('许可列表');
      await expect(resolveAIExecution({ channelId: 'unknown' })).rejects.toThrow('不可用');
      await expect(
        resolveAIExecution({ channelId: 'first', apiKey: 'injected' } as never),
      ).rejects.toThrow();
      await expect(
        resolveAIExecution({ channelId: 'first', baseUrl: 'https://attacker.invalid' } as never),
      ).rejects.toThrow();
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps existing keys when omitted and rejects stale administrator writes', async () => {
    await save();
    const first = channel();
    delete first.apiKey;
    const second = channel('second', { provider: 'deepseek' });
    delete second.apiKey;
    const result = await save([first, second], 1, 'second');
    expect(result.revision).toBe(2);
    const stored = await withTenant(administrator.id, () => loadAIChannelSettings());
    expect(stored?.channels[0].apiKey).toBe('synthetic-provider-key-first');
    await expect(save([first, second], 1)).rejects.toThrow('其他管理员更新');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires the key again when changing a destination, and never probes during save', async () => {
    await save();
    const first = channel('first', { baseUrl: 'https://replacement.example.invalid/v1' });
    delete first.apiKey;
    await expect(save([first], 1)).rejects.toThrow('必须重新填写');
    const invalid = channel('new');
    delete invalid.apiKey;
    await expect(save([invalid], 1, 'new')).rejects.toThrow('API 密钥');
    await expect(
      save([channel('first', { baseUrl: 'http://remote.example.invalid' })], 1),
    ).rejects.toThrow('HTTPS');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('freezes a chosen channel across default changes and rejects key or model drift before any call', async () => {
    await save();
    const execution = await withTenant(customer.id, () => resolveAIExecution());
    expect(execution.channelId).toBe('first');
    await save([channel(), channel('second')], 1, 'second');
    await withTenant(customer.id, async () => {
      await expect(verifyAIExecution(execution)).resolves.toBeUndefined();
      await withAIExecution(execution, async () => {
        expect((await resolveAIExecution()).channelId).toBe('first');
        await expect(resolveAIExecution({ channelId: 'second' })).rejects.toThrow('已绑定');
      });
    });
    await save(
      [channel('first', { apiKey: 'synthetic-replacement-key' }), channel('second')],
      2,
      'second',
    );
    await expect(
      withTenant(customer.id, () => createAIProviderForExecution(execution)),
    ).rejects.toThrow('配置已变化');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('stops when a queued channel is disabled and honors the global mock switch', async () => {
    await save();
    const execution = await withTenant(customer.id, () =>
      resolveAIExecution({ channelId: 'first' }),
    );
    await save([channel('first', { enabled: false }), channel('second')], 1, 'second');
    await expect(withTenant(customer.id, () => verifyAIExecution(execution))).rejects.toThrow(
      '已停用',
    );
    vi.stubEnv('AI_MODE', 'mock');
    await withTenant(customer.id, async () => {
      const view = await getAIChannelCatalog();
      expect(view.channels.map((item) => item.id)).toEqual(['mock']);
      expect((await resolveAIExecution()).mode).toBe('mock');
      await expect(resolveAIExecution({ channelId: 'second' })).rejects.toThrow('不可用');
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed after key loss or ciphertext corruption instead of reverting to another provider', async () => {
    await save();
    vi.stubEnv('PRODUCTSPY_AI_CHANNEL_SECRET', 'synthetic-wrong-master-key-that-is-long-enough');
    await expect(withTenant(customer.id, () => resolveAIExecution())).rejects.toThrow('无法解密');
    vi.stubEnv('PRODUCTSPY_AI_CHANNEL_SECRET', master);
    await withTenant(administrator.id, () =>
      dbTransaction(async () => {
        await query("SELECT set_config('app.ai_configuration_access','trusted-server',true)");
        await query(
          "UPDATE ai_channel_settings SET encrypted_payload='v1:corrupted' WHERE id='global' AND updated_by=$1",
          [administrator.id],
        );
      }),
    );
    await expect(withTenant(customer.id, () => getAIChannelCatalog())).rejects.toThrow('无法解密');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.skipIf(!process.env.PRODUCTSPY_TEST_DATABASE_URL)(
    'RLS denies direct configuration reads outside the narrow server scope',
    async () => {
      await save();
      await withTenant(customer.id, async () => {
        expect((await query("SELECT id FROM ai_channel_settings WHERE id='global'")).rows).toEqual(
          [],
        );
        expect((await getAIChannelCatalog()).channels).toHaveLength(3);
        const setting = await query<{ value: string | null }>(
          "SELECT current_setting('app.ai_configuration_access',true) AS value",
        );
        expect(setting.rows[0].value).not.toBe('trusted-server');
        expect((await query("SELECT id FROM ai_channel_settings WHERE id='global'")).rows).toEqual(
          [],
        );
      });
    },
  );
});
