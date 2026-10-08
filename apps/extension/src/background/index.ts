import { draftSchema, errorMessage, isAmazonProductUrl } from '@productspy/shared';
import { ExtensionLocalStorageAdapter, LocalhostProductSyncAdapter } from '../storage';
import type {
  CaptureResult,
  ContentRequest,
  ContentResponse,
  ExtensionRequest,
  ExtensionResponse,
  SaveResult,
} from './messages';

const local = new ExtensionLocalStorageAdapter();
const sync = new LocalhostProductSyncAdapter();

async function capture(): Promise<CaptureResult> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !isAmazonProductUrl(tab.url)) return { status: 'unsupported' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return await chrome.tabs.sendMessage<ContentRequest, ContentResponse>(tab.id, {
      type: 'PRODUCTSPY_EXTRACT',
    });
  } catch (error: unknown) {
    console.error('[ProductSpy] Content injection failed', error);
    return {
      status: 'error',
      error: '无法读取此商品页面。请刷新 Amazon 页面，等待加载完成后重试。',
    };
  }
}

async function save(
  request: Extract<ExtensionRequest, { type: 'PRODUCTSPY_SAVE' }>,
): Promise<SaveResult> {
  const parsed = draftSchema.safeParse(request.draft);
  if (!parsed.success) {
    console.warn('[ProductSpy] Invalid draft', parsed.error);
    return { status: 'error', error: '商品资料不完整或格式有误，请刷新 Amazon 页面后重新采集。' };
  }
  const draft = parsed.data;
  try {
    const product = await sync.save(draft);
    try {
      await local.remember(product);
    } catch (error: unknown) {
      console.warn('[ProductSpy] Local cache update failed after successful workspace save', error);
    }
    return { status: 'saved', product };
  } catch (error: unknown) {
    try {
      const product = await local.enqueue(draft);
      return { status: 'pending', product, error: errorMessage(error) };
    } catch (localError: unknown) {
      console.error('[ProductSpy] Offline draft could not be cached', localError);
      return {
        status: 'error',
        error: '工作台连接失败，插件暂存也未成功。请启动工作台后重试保存。',
      };
    }
  }
}

export async function handleRequest(request: ExtensionRequest): Promise<ExtensionResponse> {
  switch (request.type) {
    case 'PRODUCTSPY_CAPTURE':
      return capture();
    case 'PRODUCTSPY_SAVE':
      return save(request);
    case 'PRODUCTSPY_PENDING_COUNT':
      return { status: 'pending-count', count: (await local.pendingDrafts()).length };
    case 'PRODUCTSPY_SYNC_PENDING': {
      const drafts = await local.pendingDrafts();
      let count = 0;
      for (const draft of drafts) {
        const product = await sync.save(draft);
        await local.remember(product);
        count += 1;
      }
      return { status: 'synced', count };
    }
  }
}

chrome.runtime.onMessage.addListener(
  (request: ExtensionRequest, sender, respond: (result: ExtensionResponse) => void) => {
    if (sender.id !== chrome.runtime.id || !request || typeof request !== 'object') return;
    if (
      ![
        'PRODUCTSPY_CAPTURE',
        'PRODUCTSPY_SAVE',
        'PRODUCTSPY_PENDING_COUNT',
        'PRODUCTSPY_SYNC_PENDING',
      ].includes(request.type)
    )
      return;
    void handleRequest(request)
      .then(respond)
      .catch((error: unknown) => {
        console.error('[ProductSpy] Background operation failed', error);
        respond({ status: 'error', error: errorMessage(error, '操作失败，请重试。') });
      });
    return true;
  },
);
