import { draftSchema, errorMessage, isAmazonProductUrl } from '@productspy/shared';
import { ExtensionLocalStorageAdapter, LocalhostProductSyncAdapter } from '../storage';
import { LEGACY_MODE } from '../config';
import { CLOUD_SYNC_ALARM, CloudSyncController } from './cloud-sync';
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
const cloud = new CloudSyncController();

// Credentials and queued products stay in extension-owned contexts, never content scripts.
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {
  console.warn('[ProductSpy] Unable to restrict local storage access; please update Chrome.');
});

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
  if (!LEGACY_MODE) return cloud.save(draft);
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
    case 'PRODUCTSPY_BRIDGE_STATE':
      if (!LEGACY_MODE) return cloud.state();
      return { status: 'bridge-state', paired: await sync.isPaired() };
    case 'PRODUCTSPY_PAIR':
      if (typeof request.code !== 'string') return { status: 'error', error: '请输入有效配对码。' };
      if (!LEGACY_MODE)
        return { status: 'error', error: '请登录 SaaS 网页，插件会自动连接，无需配对码。' };
      await sync.pair(request.code);
      return { status: 'paired' };
    case 'PRODUCTSPY_CONNECT':
      if (!LEGACY_MODE) return cloud.connect();
      return { status: 'error', error: '本地兼容模式请使用工作台配对码。' };
    case 'PRODUCTSPY_SAVE':
      return save(request);
    case 'PRODUCTSPY_PENDING_COUNT':
      if (!LEGACY_MODE) return cloud.count();
      return { status: 'pending-count', count: (await local.pendingDrafts()).length };
    case 'PRODUCTSPY_LOGOUT':
      if (!LEGACY_MODE) return cloud.logout();
      return { status: 'error', error: '本地兼容模式请在工作台撤销配对。' };
    case 'PRODUCTSPY_SYNC_PENDING': {
      if (!LEGACY_MODE) return { status: 'synced', count: await cloud.syncPending(true) };
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
        'PRODUCTSPY_BRIDGE_STATE',
        'PRODUCTSPY_CONNECT',
        'PRODUCTSPY_PAIR',
        'PRODUCTSPY_LOGOUT',
      ].includes(request.type)
    )
      return;
    // Page content scripts may only extract; all account, queue and save operations are popup-owned.
    if (sender.url !== chrome.runtime.getURL('popup.html')) return;
    void handleRequest(request)
      .then(respond)
      .catch((error: unknown) => {
        console.error('[ProductSpy] Background operation failed', error);
        respond({ status: 'error', error: errorMessage(error, '操作失败，请重试。') });
      });
    return true;
  },
);

if (!LEGACY_MODE) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CLOUD_SYNC_ALARM) void cloud.syncPending(false).catch(() => undefined);
  });
  const resume = () => {
    void cloud.connect(false).catch(() => undefined);
  };
  chrome.runtime.onStartup.addListener(resume);
  chrome.runtime.onInstalled.addListener(resume);
  resume();
}
