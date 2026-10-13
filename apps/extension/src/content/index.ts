import { AmazonProductExtractor } from '../extractors';
import type { ContentRequest, ContentResponse } from '../background/messages';
import { isAmazonVerificationPage } from '../extractors/access-state';

declare global {
  interface Window {
    __productspyExtractorInstalled?: boolean;
  }
}

// Injection may repeat every time the popup opens. Keep exactly one listener per document.
if (!window.__productspyExtractorInstalled) {
  window.__productspyExtractorInstalled = true;
  chrome.runtime.onMessage.addListener(
    (request: ContentRequest, sender, respond: (result: ContentResponse) => void) => {
      if (sender.id !== chrome.runtime.id || request.type !== 'PRODUCTSPY_EXTRACT') return;
      try {
        if (isAmazonVerificationPage(document)) {
          respond({
            status: 'error',
            error:
              'Amazon 当前显示访问验证页面，暂时无法采集。请在浏览器自行确认访问状态后再使用插件；ProductSpy 不绕过验证。',
          });
          return;
        }
        const draft = new AmazonProductExtractor(document, location.href).extract();
        respond(
          draft
            ? { status: 'captured', draft }
            : {
                status: 'error',
                error:
                  '未能识别商品信息。请等待商品页面加载完成后重试；验证页或缺少标题的页面暂不支持。',
              },
        );
      } catch (error: unknown) {
        console.error('[ProductSpy] Capture failed', error);
        respond({
          status: 'error',
          error: '商品页面读取失败，请刷新 Amazon 页面后重试。',
        });
      }
    },
  );
}
