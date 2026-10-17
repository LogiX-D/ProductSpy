/// <reference types="vite/client" />
import { extensionConfig } from './deployment-config';

const config = extensionConfig(
  import.meta.env.VITE_PRODUCTSPY_APP_URL,
  import.meta.env.VITE_PRODUCTSPY_MODE,
  import.meta.env.VITE_PRODUCTSPY_ENV,
);
export const APP_URL = config.appUrl;
export const LEGACY_MODE = config.legacy;

export function extensionLoginUrl(): string {
  return `${APP_URL}/settings?extensionId=${encodeURIComponent(chrome.runtime.id)}`;
}
