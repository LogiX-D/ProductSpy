import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTSPY_VERSION } from '@productspy/shared';
import { GET } from './route';

describe('workspace status API', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to complete mock mode without a key', async () => {
    vi.stubEnv('AI_API_KEY', '');
    vi.stubEnv('AI_MODE', '');
    const response = await GET(new Request('http://localhost:3000/api/status'));
    expect(await response.json()).toEqual({
      ok: true,
      data: { mode: 'mock', version: PRODUCTSPY_VERSION },
    });
  });

  it('treats a whitespace-only key consistently with the AI provider factory', async () => {
    vi.stubEnv('AI_API_KEY', ' \t\n');
    vi.stubEnv('AI_MODE', 'auto');
    const response = await GET(new Request('http://localhost:3000/api/status'));
    expect(await response.json()).toEqual({
      ok: true,
      data: { mode: 'mock', version: PRODUCTSPY_VERSION },
    });
  });

  it('respects explicit mode and does not expose the API key', async () => {
    vi.stubEnv('AI_API_KEY', 'test-secret');
    vi.stubEnv('AI_MODE', 'mock');
    expect(await (await GET(new Request('http://localhost:3000/api/status'))).json()).toEqual({
      ok: true,
      data: { mode: 'mock', version: PRODUCTSPY_VERSION },
    });
    vi.stubEnv('AI_API_KEY', '');
    vi.stubEnv('AI_MODE', 'real');
    expect(await (await GET(new Request('http://localhost:3000/api/status'))).json()).toEqual({
      ok: true,
      data: { mode: 'real', version: PRODUCTSPY_VERSION },
    });
  });
});
