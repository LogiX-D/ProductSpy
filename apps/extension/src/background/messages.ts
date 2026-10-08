import type { Product, ProductDraft } from '@productspy/shared';

export const WORKSPACE_URL = 'http://127.0.0.1:3000';

export type ExtensionRequest =
  | { type: 'PRODUCTSPY_CAPTURE' }
  | { type: 'PRODUCTSPY_SAVE'; draft: ProductDraft }
  | { type: 'PRODUCTSPY_PENDING_COUNT' }
  | { type: 'PRODUCTSPY_SYNC_PENDING' }
  | { type: 'PRODUCTSPY_BRIDGE_STATE' }
  | { type: 'PRODUCTSPY_PAIR'; code: string };

export type CaptureResult =
  | { status: 'captured'; draft: ProductDraft }
  | { status: 'unsupported' }
  | { status: 'error'; error: string };

export type SaveResult =
  | { status: 'saved'; product: Product }
  | { status: 'pending'; product: Product; error: string }
  | { status: 'error'; error: string };

export type ExtensionResponse =
  | CaptureResult
  | SaveResult
  | { status: 'pending-count'; count: number }
  | { status: 'synced'; count: number }
  | { status: 'bridge-state'; paired: boolean }
  | { status: 'paired' };

export interface ContentRequest {
  type: 'PRODUCTSPY_EXTRACT';
}
export type ContentResponse = CaptureResult;

export async function extensionRequest(request: ExtensionRequest): Promise<ExtensionResponse> {
  return chrome.runtime.sendMessage<ExtensionRequest, ExtensionResponse>(request);
}
