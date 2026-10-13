import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
/* global chrome */

// Direct public pages, isolated profile, actual installed extension and normal visible interactions.
// Never intercept responses, alter page HTML, solve a challenge, log in, or save to a user library.
const samples = [
  ['electronics', 'Logitech C920', 'https://www.amazon.com/dp/B006JH8T3S'],
  ['home', 'upsimples frame', 'https://www.amazon.com/dp/B0BQR2BQYZ'],
  ['beauty', 'CeraVe moisturizer', 'https://www.amazon.com/dp/B00TTD9BRC'],
  ['clothing', 'Hanes hoodie', 'https://www.amazon.com/dp/B00JUM2V4W'],
  ['kitchen', 'OXO cookie scoop', 'https://www.amazon.com/dp/B0000CCY1E'],
  ['books', 'Atomic Habits', 'https://www.amazon.com/dp/0735211299'],
  ['clothing', 'Crocs Classic variant', 'https://www.amazon.com/dp/B0014C5S7S'],
  ['electronics', 'Logitech DE', 'https://www.amazon.de/dp/B006JH8T3S'],
  ['kitchen', 'OXO UK', 'https://www.amazon.co.uk/dp/B0000CCY1E'],
  ['electronics', 'Logitech JP', 'https://www.amazon.co.jp/dp/B006JH8T3S'],
];
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const selectedSamples = argument('--url')
  ? samples.filter((sample) => sample[2] === argument('--url'))
  : samples;
if (!selectedSamples.length) throw new Error('Choose one of the listed public sample URLs');
const output = resolve(
  argument('--output') ??
    `.test-data/phase16-amazon/${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
await mkdir(output, { recursive: true });
const extension = resolve('apps/extension/dist');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1365, height: 900 },
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
  ],
});
const reports = [];
const blockedHosts = new Set();
const startedAt = new Date().toISOString();
const metadata = {
  schemaVersion: 1,
  phase: 16,
  extensionVersion: manifest.version,
  realPages: true,
  mock: false,
  startedAt,
  browser: {
    distribution: 'Chrome for Testing (Playwright chromium channel)',
    version: context.browser().version(),
    headless: true,
    stableChromeManualAcceptance: false,
  },
  requestBudget: {
    primaryNavigations: selectedSamples.length,
    normalVariantClicks: 2,
    mediaChecksPerPage: 4,
  },
  bridgeSaves: 0,
  aiCalls: 0,
};
const saveReport = async () => {
  await writeFile(
    resolve(output, 'report.json'),
    JSON.stringify({ ...metadata, reports }, null, 2),
  );
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
let popup;
let page;
let session;
let extensionId;

async function pageChallenge() {
  const body = await page.locator('body').innerText({ timeout: 8000 });
  return (
    /validateCaptcha|\/errors\/validateCaptcha/.test(page.url()) ||
    /Robot Check|Enter the characters you see below|Type the characters you see in this image|Sorry, we just need to make sure you're not a robot/i.test(
      body,
    )
  );
}

async function grantActiveTab() {
  await page.bringToFront();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === page.url());
  if (!target) throw new Error('Amazon tab target missing');
  await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  await page.bringToFront();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const active = await popup.evaluate(async (expectedUrl) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.url === expectedUrl;
    }, page.url());
    if (active) return;
    await page.waitForTimeout(100);
  }
  throw new Error('Chrome has not granted activeTab to the current Amazon tab');
}

async function observeDom() {
  return page.evaluate(() => {
    const clean = (text) => text?.replace(/\s+/g, ' ').trim() ?? '';
    const text = (selector) => clean(document.querySelector(selector)?.textContent);
    const visibleText = (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement ? clean(element.innerText) : '';
    };
    const image = document.querySelector('#landingImage, #imgBlkFront, #ebooksImgBlkFront');
    const descriptions = ['#productDescription', '#bookDescription_feature_div', '#aplus .aplus-v2']
      .flatMap((selector) =>
        [...document.querySelectorAll(selector)].map((element) => ({
          selector,
          visibleText: element instanceof HTMLElement ? clean(element.innerText) : '',
          contentVisibleText:
            element.querySelector('.a-expander-content') instanceof HTMLElement
              ? clean(element.querySelector('.a-expander-content').innerText)
              : undefined,
        })),
      )
      .filter((item) => item.visibleText);
    return {
      asin: document.querySelector('input#ASIN, input[name="ASIN"]')?.value ?? '',
      title: text('#productTitle'),
      brand: text('.po-brand .po-break-word') || text('#bylineInfo') || text('#brand'),
      prices: [
        '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
        '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
        '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
        '#priceblock_ourprice',
        '#priceblock_dealprice',
        '#price_inside_buybox',
        '#newBuyBoxPrice',
        '#tp_price_block_total_price_ww .a-offscreen',
      ]
        .map((selector) => ({ selector, text: text(selector) }))
        .filter((item) => item.text),
      mainImage: image?.getAttribute('data-old-hires') || image?.getAttribute('src'),
      imageWidth: image?.naturalWidth,
      imageHeight: image?.naturalHeight,
      mainDynamicImage: image?.getAttribute('data-a-dynamic-image'),
      bulletPoints: [...document.querySelectorAll('#feature-bullets li .a-list-item')]
        .map((element) => clean(element.textContent))
        .filter(Boolean),
      facts: [...document.querySelectorAll('#productFactsDesktopExpander li')]
        .map((element) => clean(element.textContent))
        .filter(Boolean),
      rating: text('#acrPopover'),
      reviewCount: text('#acrCustomerReviewText'),
      bylineVisibleText: visibleText('#bylineInfo'),
      descriptions,
      variations: [
        ...document.querySelectorAll(
          '[id^="variation_"] li[data-defaultasin], [id^="variation_"] li[data-asin], #twister-plus-inline-twister li[data-asin]',
        ),
      ]
        .map((element) => ({
          asin: element.getAttribute('data-defaultasin') || element.getAttribute('data-asin'),
          selected: element.className.includes('swatchSelect'),
          title: element.getAttribute('title'),
          elementId: element.id,
          inlineTwister: !!element.closest('#twister-plus-inline-twister'),
          available: element.getAttribute('data-initiallyunavailable') !== 'true',
          displayed:
            element instanceof HTMLElement && element.offsetWidth > 0 && element.offsetHeight > 0,
        }))
        .slice(0, 40),
      publicVideoElements: [
        ...document.querySelectorAll(
          '#imageBlock video,#imageBlock video source,#video-player video,#video-player video source',
        ),
      ]
        .map((element) => element.getAttribute('src'))
        .filter(Boolean),
    };
  });
}

async function snapshot(category, label, requestedUrl, kind, options = {}) {
  const report = {
    category,
    label,
    requestedUrl,
    kind,
    capturedAt: new Date().toISOString(),
    ...options,
  };
  const key = `${String(reports.length + 1).padStart(2, '0')}-${new URL(requestedUrl).hostname}-${requestedUrl.split('/dp/')[1]}`;
  report.pageUrl = page.url();
  report.pageTitle = await page.title();
  report.challenge = await pageChallenge();
  if (report.challenge) {
    report.outcome = 'challenge';
    blockedHosts.add(new URL(requestedUrl).hostname);
  } else {
    report.dom = await observeDom();
    await grantActiveTab();
    const result = await popup.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
    );
    report.outcome = result.status;
    if (result.status === 'captured') {
      report.draft = result.draft;
      const repeated = await popup.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
      );
      const afterDom = await observeDom();
      report.repeatCapture = {
        status: repeated.status,
        sourceIdUnchanged: repeated.draft?.sourceId === result.draft.sourceId,
        titleUnchanged: repeated.draft?.title === result.draft.title,
        priceUnchanged: repeated.draft?.price === result.draft.price,
        imagesUnchanged:
          JSON.stringify(repeated.draft?.images) === JSON.stringify(result.draft.images),
        priceMatchesCurrentDom: repeated.draft?.price === afterDom.prices[0]?.text,
        currentAsinMatches: repeated.draft?.sourceId === afterDom.asin,
        noLibrarySave: true,
      };
      if (result.draft.mainImage) {
        try {
          const media = await context.request.get(result.draft.mainImage, { timeout: 12000 });
          report.mainImageHttp = {
            status: media.status(),
            contentType: media.headers()['content-type'],
          };
        } catch (error) {
          report.mainImageHttp = { error: String(error).slice(0, 240) };
        }
      }
      report.videoNetwork = [];
      for (const { url } of result.draft.videos.slice(0, 3)) {
        try {
          const media = await context.request.head(url, { timeout: 12000 });
          report.videoNetwork.push({
            url,
            status: media.status(),
            contentType: media.headers()['content-type'],
            playback: 'not-performed',
          });
        } catch (error) {
          report.videoNetwork.push({
            url,
            error: String(error).slice(0, 240),
            playback: 'not-performed',
          });
        }
      }
    } else {
      report.error = result.error;
    }
  }
  const html = await page.content();
  await writeFile(resolve(output, `${key}.html`), html);
  report.htmlSha256 = sha256(html);
  try {
    const screenshot = await page.screenshot({
      path: resolve(output, `${key}.png`),
      timeout: 8000,
      animations: 'disabled',
    });
    report.screenshotSha256 = sha256(screenshot);
  } catch (error) {
    report.screenshotError = String(error).slice(0, 260);
  }
  await writeFile(resolve(output, `${key}.json`), JSON.stringify(report, null, 2));
  reports.push(report);
  await saveReport();
  console.log(
    JSON.stringify({
      index: reports.length,
      category,
      label,
      kind,
      outcome: report.outcome,
      asin: report.draft?.sourceId,
      price: report.draft?.price,
      images: report.draft?.images.length,
      videos: report.draft?.videos.length,
      screenshot: !!report.screenshotSha256,
    }),
  );
  return report;
}

async function normalVariantClick(parent) {
  const before = parent.dom?.asin;
  const candidate = parent.dom?.variations.find(
    (item) =>
      item.asin &&
      item.asin !== before &&
      !item.selected &&
      item.displayed &&
      (item.elementId || item.inlineTwister) &&
      item.available &&
      !/unavailable/i.test(item.title ?? ''),
  );
  parent.variationInteraction = {
    status: 'not-performed',
    reason: 'No visible unselected, identified variant tile',
  };
  if (!candidate) return;
  parent.variationInteraction = {
    status: 'attempted',
    originalAsin: before,
    tileAsin: candidate.asin,
    tileId: candidate.elementId,
  };
  await writeFile(
    resolve(output, 'variant-attempt.json'),
    JSON.stringify(parent.variationInteraction, null, 2),
  );
  try {
    // Locator click must pass Playwright's ordinary visibility / stability checks, never force.
    const tile = candidate.elementId
      ? page.locator(`[id="${candidate.elementId}"]`)
      : page.locator(`#twister-plus-inline-twister li[data-asin="${candidate.asin}"]`).first();
    await tile.click({ timeout: 12000 });
    await page.waitForFunction(
      (asin) => {
        const input = document.querySelector('input#ASIN, input[name="ASIN"]');
        return input && input.value !== asin && /^[A-Z0-9]{10}$/i.test(input.value);
      },
      before,
      { timeout: 18000 },
    );
    await page.waitForTimeout(1800);
    const activeAsin = await page.locator('input#ASIN, input[name="ASIN"]').first().inputValue();
    const requestedUrl = new URL(`/dp/${activeAsin}`, parent.requestedUrl).href;
    const variant = await snapshot(
      parent.category,
      `${parent.label} visible variant`,
      requestedUrl,
      'visible-variant',
      { parentRequestedUrl: parent.requestedUrl },
    );
    parent.variationInteraction.status =
      variant.outcome === 'captured' ? 'captured' : variant.outcome;
    parent.variationInteraction.activeAsin = activeAsin;
    parent.variationInteraction.capturedAsinMatches = variant.draft?.sourceId === activeAsin;
    parent.variationInteraction.tileAsinMatches = activeAsin === candidate.asin;
    parent.variationInteraction.imageChanged = variant.draft?.mainImage !== parent.draft?.mainImage;
    parent.variationInteraction.priceChanged = variant.draft?.price !== parent.draft?.price;
  } catch (error) {
    parent.variationInteraction.status = 'interaction-error';
    parent.variationInteraction.error = String(error).slice(0, 350);
    // A challenge ends all further requests to this host, with no retry.
    if (await pageChallenge().catch(() => false))
      blockedHosts.add(new URL(parent.requestedUrl).hostname);
  }
  await saveReport();
}

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  session = await context.browser().newBrowserCDPSession();
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  page = context.pages()[0];
  for (const [category, label, requestedUrl] of selectedSamples) {
    const host = new URL(requestedUrl).hostname;
    if (blockedHosts.has(host)) {
      reports.push({
        category,
        label,
        requestedUrl,
        kind: 'primary',
        capturedAt: new Date().toISOString(),
        outcome: 'not-attempted-after-challenge',
      });
      await saveReport();
      continue;
    }
    try {
      const response = await page.goto(requestedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000,
      });
      await page
        .locator('#productTitle, form[action*="validateCaptcha"]')
        .first()
        .waitFor({ state: 'attached', timeout: 8000 })
        .catch(() => {});
      await page.waitForTimeout(1800);
      const row = await snapshot(category, label, requestedUrl, 'primary', {
        httpStatus: response?.status(),
      });
      if (row.outcome === 'captured' && category === 'clothing' && !blockedHosts.has(host))
        await normalVariantClick(row);
    } catch (error) {
      reports.push({
        category,
        label,
        requestedUrl,
        kind: 'primary',
        capturedAt: new Date().toISOString(),
        outcome: 'navigation-or-capture-error',
        error: String(error).slice(0, 450),
        noRetry: true,
      });
      await saveReport();
      console.log(
        JSON.stringify({
          category,
          label,
          outcome: 'navigation-or-capture-error',
          error: String(error).slice(0, 180),
        }),
      );
    }
    await page.waitForTimeout(1200);
  }
} finally {
  await context.close();
}
metadata.completedAt = new Date().toISOString();
await saveReport();
console.log(
  JSON.stringify({
    evidenceDirectory: output,
    primaryAttempted: reports.filter(
      (row) => row.kind === 'primary' && !row.outcome.startsWith('not-attempted'),
    ).length,
    primaryCaptured: reports.filter((row) => row.kind === 'primary' && row.outcome === 'captured')
      .length,
    variantsCaptured: reports.filter(
      (row) => row.kind === 'visible-variant' && row.outcome === 'captured',
    ).length,
  }),
);
