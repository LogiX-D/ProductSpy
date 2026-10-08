export const CAPTURE_CONSENT_KEY = 'productspy.capture-consent.v1';
export const CAPTURE_CONSENT_VERSION = 1;

export async function hasCaptureConsent(): Promise<boolean> {
  const data: Record<string, unknown> = await chrome.storage.local.get(CAPTURE_CONSENT_KEY);
  const record = data[CAPTURE_CONSENT_KEY];
  return Boolean(
    record &&
    typeof record === 'object' &&
    'version' in record &&
    record.version === CAPTURE_CONSENT_VERSION,
  );
}

export async function rememberCaptureConsent(): Promise<void> {
  await chrome.storage.local.set({
    [CAPTURE_CONSENT_KEY]: {
      version: CAPTURE_CONSENT_VERSION,
      acceptedAt: new Date().toISOString(),
    },
  });
}
