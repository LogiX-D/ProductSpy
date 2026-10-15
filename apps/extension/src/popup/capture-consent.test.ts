import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_CONSENT_KEY,
  CAPTURE_CONSENT_TIMEOUT_MS,
  hasCaptureConsent,
  rememberCaptureConsent,
} from './capture-consent';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it.each(['read', 'write'] as const)(
    'bounds a never-settling %s and ignores a late success without retrying storage',
    async (operation) => {
      let complete!: (value: Record<string, unknown>) => void;
      const pending = new Promise<Record<string, unknown>>((resolve) => {
        complete = resolve;
      });
      const request = vi.fn(() => pending);
      vi.stubGlobal('chrome', { storage: { local: { get: request, set: request } } });
      const success = vi.fn();
      const failure = vi.fn();
      const result = (operation === 'read' ? hasCaptureConsent() : rememberCaptureConsent()).then(
        success,
        failure,
      );
      await vi.advanceTimersByTimeAsync(CAPTURE_CONSENT_TIMEOUT_MS - 1);
      expect(failure).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(failure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: 'Capture consent storage timed out' }),
      );
      complete({ [CAPTURE_CONSENT_KEY]: { version: 1 } });
      await vi.advanceTimersByTimeAsync(CAPTURE_CONSENT_TIMEOUT_MS);
      expect(success).not.toHaveBeenCalled();
      expect(failure).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['read', 'write'] as const)('cleans up a pending %s on abort', async (operation) => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('chrome', { storage: { local: { get: request, set: request } } });
    const controller = new AbortController();
    const result =
      operation === 'read'
        ? hasCaptureConsent(controller.signal)
        : rememberCaptureConsent(controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not start a storage operation after its owner has unmounted', async () => {
    const request = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: { get: request, set: request } } });
    const controller = new AbortController();
    controller.abort();
    await expect(hasCaptureConsent(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(rememberCaptureConsent(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves storage failures and releases the timeout after a settled request', async () => {
    const failure = new Error('local storage unavailable');
    const get = vi.fn().mockRejectedValue(failure);
    const set = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal('chrome', { storage: { local: { get, set } } });
    await expect(hasCaptureConsent()).rejects.toBe(failure);
    await expect(rememberCaptureConsent()).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
