import { LEGACY_MODE } from '../config';
export const CAPTURE_CONSENT_KEY = LEGACY_MODE
  ? 'productspy.capture-consent.v1'
  : 'productspy.capture-consent.cloud.v2';
export const CAPTURE_CONSENT_VERSION = LEGACY_MODE ? 1 : 2;
export const CAPTURE_CONSENT_TIMEOUT_MS = 3000;

function consentStorageRequest<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Consent request cancelled', 'AbortError'));
      return;
    }
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      complete();
    };
    const abort = () =>
      finish(() => reject(new DOMException('Consent request cancelled', 'AbortError')));
    const timer = setTimeout(
      () => finish(() => reject(new Error('Capture consent storage timed out'))),
      CAPTURE_CONSENT_TIMEOUT_MS,
    );
    signal?.addEventListener('abort', abort, { once: true });
    // Chrome storage cannot be cancelled. A late result must not change this request's outcome.
    try {
      void request().then(
        (value) => finish(() => resolve(value)),
        (failure: unknown) => finish(() => reject(failure)),
      );
    } catch (failure: unknown) {
      finish(() => reject(failure));
    }
  });
}

export async function hasCaptureConsent(signal?: AbortSignal): Promise<boolean> {
  const data: Record<string, unknown> = await consentStorageRequest(
    () => chrome.storage.local.get(CAPTURE_CONSENT_KEY),
    signal,
  );
  const record = data[CAPTURE_CONSENT_KEY];
  return Boolean(
    record &&
    typeof record === 'object' &&
    'version' in record &&
    record.version === CAPTURE_CONSENT_VERSION,
  );
}

export async function rememberCaptureConsent(signal?: AbortSignal): Promise<void> {
  await consentStorageRequest(
    () =>
      chrome.storage.local.set({
        [CAPTURE_CONSENT_KEY]: {
          version: CAPTURE_CONSENT_VERSION,
          acceptedAt: new Date().toISOString(),
        },
      }),
    signal,
  );
}
