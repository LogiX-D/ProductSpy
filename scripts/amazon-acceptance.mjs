import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/* global chrome */

// Public product pages only. No account, proxy rotation, CAPTCHA solving, or request interception.
const samples = [
  ['electronics', 'Echo Dot', 'https://www.amazon.com/dp/B09B8V1LZ3'],
  ['electronics', 'Logitech C920', 'https://www.amazon.com/dp/B006JH8T3S'],
  ['beauty', 'CeraVe moisturizer', 'https://www.amazon.com/dp/B00TTD9BRC'],
  ['beauty', 'CeraVe cream', 'https://www.amazon.com/dp/B07HQDXKW2'],
  ['beauty', 'CeraVe lotion multipack', 'https://www.amazon.com/dp/B018MR63HG'],
  ['clothing', 'Crocs Classic', 'https://www.amazon.com/dp/B0014C5S7S'],
  ['home', 'Home bestseller 1', 'https://www.amazon.com/dp/B0BQR2BQYZ'],
  ['home', 'Home bestseller 2', 'https://www.amazon.com/dp/B07FPQZG6V'],
  ['home', 'Multi-variant home bestseller', 'https://www.amazon.com/dp/B0DZFGTCLR'],
  ['clothing', 'Hanes bestseller 1', 'https://www.amazon.com/dp/B00JUM2V4W'],
  ['clothing', 'Hanes bestseller 2', 'https://www.amazon.com/dp/B00JUM4DKC'],
  ['kitchen', 'OXO cookie scoop', 'https://www.amazon.com/dp/B0000CCY1E'],
  ['kitchen', 'Capresso coffee grinder', 'https://www.amazon.com/dp/B001QTVXCS'],
  ['electronics', 'Logitech DE', 'https://www.amazon.de/dp/B006JH8T3S'],
  ['kitchen', 'OXO UK', 'https://www.amazon.co.uk/dp/B0000CCY1E'],
  ['electronics', 'Logitech JP', 'https://www.amazon.co.jp/dp/B006JH8T3S'],
];
const outputArgument = process.argv.indexOf('--output');
const output = resolve(
  outputArgument >= 0 ? process.argv[outputArgument + 1] : '.test-data/phase9-evidence',
);
await mkdir(output, { recursive: true });
const dist = resolve('apps/extension/dist');
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  channel: 'chromium',
  headless: true,
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});
const reports = [];
const challengedHosts = new Map();
const urlArgument = process.argv.indexOf('--url');
const selectedSamples =
  urlArgument >= 0 ? samples.filter((item) => item[2] === process.argv[urlArgument + 1]) : samples;
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).hostname;
  const session = await context.browser().newBrowserCDPSession();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const page = context.pages()[0];
  for (const [index, [category, label, requestedUrl]] of selectedSamples.entries()) {
    const key = `${String(index + 1).padStart(2, '0')}-${new URL(requestedUrl).hostname}-${requestedUrl.split('/').at(-1)}`;
    const report = { category, label, requestedUrl, capturedAt: new Date().toISOString() };
    const host = new URL(requestedUrl).hostname;
    if ((challengedHosts.get(host) ?? 0) >= 2) {
      report.outcome = 'not-attempted-after-repeated-challenge';
      reports.push(report);
      continue;
    }
    try {
      const response = await page.goto(requestedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000,
      });
      report.httpStatus = response?.status();
      await page
        .locator('#productTitle, #title, form[action*="validateCaptcha"]')
        .first()
        .waitFor({ state: 'attached', timeout: 8000 })
        .catch(() => {});
      // A bounded DOM settling interval is observation, not retrying a protected request.
      await page.waitForTimeout(1800);
      report.pageUrl = page.url();
      report.pageTitle = await page.title();
      const bodyText = await page.locator('body').innerText();
      report.challenge =
        /validateCaptcha/.test(page.url()) ||
        /Robot Check|Enter the characters you see below|Type the characters you see in this image/i.test(
          bodyText,
        );
      try {
        await page.screenshot({ path: resolve(output, `${key}.png`), timeout: 10000 });
      } catch (error) {
        report.screenshotError = String(error);
      }
      if (report.challenge) {
        report.outcome = 'challenge';
        challengedHosts.set(host, (challengedHosts.get(host) ?? 0) + 1);
      } else {
        report.dom = await page.evaluate(() => {
          const text = (selector) =>
            document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          const image = document.querySelector('#landingImage, #imgBlkFront');
          return {
            asin: document.querySelector('input#ASIN, input[name="ASIN"]')?.value ?? '',
            title: text('#productTitle'),
            ogTitle: document.querySelector('meta[property="og:title"]')?.content ?? '',
            brand: text('#bylineInfo'),
            prices: [
              '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
              '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
              '#apex .a-price:not(.a-text-price) .a-offscreen',
              '#priceblock_ourprice',
              '#priceblock_dealprice',
            ]
              .map((selector) => ({ selector, text: text(selector) }))
              .filter((item) => item.text),
            mainImage: image?.getAttribute('data-old-hires') || image?.getAttribute('src'),
            imageWidth: image?.naturalWidth,
            imageHeight: image?.naturalHeight,
            bulletPoints: [...document.querySelectorAll('#feature-bullets li .a-list-item')]
              .map((item) => item.textContent.replace(/\s+/g, ' ').trim())
              .filter(Boolean),
            rating: text('#acrPopover'),
            reviewCount: text('#acrCustomerReviewText'),
            variations: [
              ...document.querySelectorAll(
                '[id^="variation_"] li[data-defaultasin], [id^="variation_"] li[data-asin]',
              ),
            ]
              .map((item) => ({
                asin: item.getAttribute('data-defaultasin') || item.getAttribute('data-asin'),
                selected: item.className.includes('swatchSelect'),
                title: item.getAttribute('title'),
              }))
              .slice(0, 30),
            unavailable:
              /Currently unavailable|cannot be shipped|cannot be delivered|does not ship|not available|Derzeit nicht verfügbar|現在在庫切れ/i.test(
                document.body.innerText,
              ),
            publicVideoElements: [...document.querySelectorAll('video, video source')]
              .map((item) => item.getAttribute('src'))
              .filter(Boolean),
          };
        });
        await page.bringToFront();
        const targets = await session.send('Target.getTargets', {
          filter: [{ type: 'tab', exclude: false }],
        });
        const target = targets.targetInfos.find((item) => item.url === page.url());
        if (!target) throw new Error('Amazon tab target missing');
        await session.send('Extensions.triggerAction', {
          id: extensionId,
          targetId: target.targetId,
        });
        await page.bringToFront();
        let activated = false;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          activated = await popup.evaluate(async (expectedUrl) => {
            const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
            return active?.url === expectedUrl;
          }, page.url());
          if (activated) break;
          await page.waitForTimeout(100);
        }
        if (!activated) throw new Error('Chrome has not granted activeTab to the product page');
        const result = await popup.evaluate(() =>
          chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
        );
        report.outcome = result.status;
        if (result.status === 'captured') {
          report.draft = result.draft;
          if (result.draft.mainImage) {
            try {
              const media = await context.request.get(result.draft.mainImage, { timeout: 15000 });
              report.mainImageHttp = {
                status: media.status(),
                contentType: media.headers()['content-type'],
              };
            } catch (error) {
              report.mainImageHttp = { error: String(error) };
            }
          }
        } else {
          report.error = result.error;
        }
        // Raw HTML is local ignored evidence only; never publish a page's session/CSRF fields.
        await writeFile(resolve(output, `${key}.html`), await page.content());
      }
    } catch (error) {
      report.outcome = 'navigation-or-capture-error';
      report.error = String(error);
    }
    reports.push(report);
    await writeFile(resolve(output, `${key}.json`), JSON.stringify(report, null, 2));
    await writeFile(
      resolve(output, 'report.json'),
      JSON.stringify({ version: 1, realPages: true, reports }, null, 2),
    );
    console.log(
      JSON.stringify({
        index: index + 1,
        category,
        outcome: report.outcome,
        asin: report.draft?.sourceId,
        title: report.draft?.title?.slice(0, 110),
        price: report.draft?.price,
        currency: report.draft?.currency,
        images: report.draft?.images?.length,
        videos: report.draft?.videos?.length,
        bullets: report.draft?.bulletPoints?.length,
        error: report.error,
      }),
    );
    await page.waitForTimeout(1200);
  }
} finally {
  await context.close();
}
await writeFile(
  resolve(output, 'report.json'),
  JSON.stringify({ version: 1, realPages: true, reports }, null, 2),
);
console.log(
  JSON.stringify({
    attempted: reports.filter((item) => !item.outcome.startsWith('not-attempted')).length,
    captured: reports.filter((item) => item.outcome === 'captured').length,
    evidence: output,
  }),
);
