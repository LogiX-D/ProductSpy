import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPTURE_CONSENT_KEY, hasCaptureConsent, rememberCaptureConsent } from './capture-consent';

afterEach(() => vi.unstubAllGlobals());

describe('versioned capture consent storage', () => {
  it('requires acceptance for missing, malformed or older-version records', async () => {
    const get = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { get } } });
    for (const record of [undefined, true, { version: 0 }, { version: '1' }]) {
      get.mockResolvedValue({ [CAPTURE_CONSENT_KEY]: record });
      expect(await hasCaptureConsent()).toBe(false);
    }
    get.mockResolvedValue({ [CAPTURE_CONSENT_KEY]: { version: 1 } });
    expect(await hasCaptureConsent()).toBe(true);
  });

  it('writes only the consent key and preserves existing product queues and tokens', async () => {
    const records: Record<string, unknown> = {
      products: ['saved'],
      'productspy.bridge-token.v1': 'existing-token',
    };
    const set = vi.fn(async (value: Record<string, unknown>) => Object.assign(records, value));
    vi.stubGlobal('chrome', { storage: { local: { set } } });
    await rememberCaptureConsent();
    expect(Object.keys(set.mock.calls[0][0])).toEqual([CAPTURE_CONSENT_KEY]);
    expect(records.products).toEqual(['saved']);
    expect(records['productspy.bridge-token.v1']).toBe('existing-token');
  });
});
