import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';
/* global chrome */

// Bounded QA only: untouched public pages, frozen production files, an isolated profile,
// no library writes, no media requests, no AI calls, no navigation retries or CAPTCHA bypass.
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const hash = (value) => createHash('sha256').update(value).digest('hex');
const startedAt = new Date().toISOString();
const evidence = resolve(
  argument('--evidence', `.test-data/final-video-timing/${startedAt.replace(/[:.]/g, '-')}`),
);
const output = resolve(argument('--output', 'docs/phase21/video-timing-final.json'));
const bundle = resolve('artifacts/ProductSpy-1.0.0-rc.1-windows-x64');
const extension = resolve(bundle, 'extension');
const bundleManifestBytes = await readFile(resolve(bundle, 'bundle-manifest.json'));
const bundleManifest = JSON.parse(bundleManifestBytes.toString('utf8'));
const verifiedFiles = [];
for (const item of bundleManifest.files.filter((file) => file.path.startsWith('extension/'))) {
  const bytes = await readFile(resolve(bundle, item.path));
  if (hash(bytes) !== item.sha256 || bytes.length !== item.bytes)
    throw new Error(`Frozen extension integrity failed: ${item.path}`);
  verifiedFiles.push({ path: item.path, sha256: item.sha256, bytes: item.bytes });
}
if (verifiedFiles.length < 3) throw new Error('Frozen extension file manifest missing');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
const contentBytes = await readFile(resolve(extension, 'content.js'));
const contentSource = contentBytes.toString('utf8');
const samples = [
  { category: 'beauty', name: 'CeraVe', asin: 'B00TTD9BRC' },
  { category: 'kitchen', name: 'OXO', asin: 'B0000CCY1E' },
];
await mkdir(evidence, { recursive: true });
await mkdir(dirname(output), { recursive: true });
const report = {
  schemaVersion: 1,
  phase: 21,
  purpose: 'Final bounded follow-up of the two previously unclassified video timing differences',
  startedAt,
  release: manifest.version_name ?? manifest.version,
  realPages: true,
  mock: false,
  browser: { distribution: 'Chrome for Testing', stableChromeManualAcceptance: false },
  method: {
    normalPrimaryNavigations: 2,
    capturesPerSuccessfullyLoadedPage: 3,
    settlingMilliseconds: [1800, 3000, 5000],
    captureInteraction: 'First consent button, then existing production Popup re-identify button',
    popupPresentation:
      'Frozen popup.html opened in a browser tab; not a Stable Chrome toolbar Popup or native window-size acceptance.',
    observation:
      'Read-only HTML/DOM sampling brackets the actual capture request. Brackets are not an atomic DOM snapshot; differing brackets remain ambiguous.',
    offline:
      'Only SHA-verified frozen ProductSpy content.js is evaluated, in JSDOM outside-only. Amazon page scripts are never evaluated and no resources are loaded.',
    feesAndPersistence:
      'Zero AI calls, zero library saves, zero explicit media download/API checks',
    challengePolicy: 'Stop this host after the first verification page; never retry navigation',
  },
  frozen: {
    bundleManifestSha256: hash(bundleManifestBytes),
    contentSha256: hash(contentBytes),
    extensionFilesVerified: verifiedFiles.length,
  },
  samples: [],
};
let context;
let page;
let popup;
let session;
let extensionId;
let activeSample;
let activeCapture;
const captures = new Map();
const blockedHosts = new Set();
const save = async () => {
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
};
const errorInfo = (error) => ({ name: error?.name ?? 'Error', messageSha256: hash(String(error)) });
const mediaSummary = (videos) =>
  videos.map((video) => ({
    urlSha256: hash(video.url),
    type: video.url.match(/\.(mp4|webm|m3u8)(?:[?#]|$)/i)?.[1]?.toLowerCase() ?? 'unknown',
    playback: 'not-requested',
  }));

function replay(html, url) {
  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  let listener;
  dom.window.chrome = {
    runtime: {
      id: 'productspy-frozen-qa',
      onMessage: {
        addListener(callback) {
          listener = callback;
        },
      },
    },
  };
  let result;
  try {
    const currentAsin = dom.window.document.querySelector('input#ASIN,input[name="ASIN"]')?.value;
    const records = (value, depth = 0) =>
      depth > 20 || !value || typeof value !== 'object'
        ? []
        : Array.isArray(value)
          ? value.flatMap((entry) => records(entry, depth + 1))
          : [value, ...Object.values(value).flatMap((entry) => records(entry, depth + 1))];
    const independentlyBoundStateMedia = new Map();
    for (const element of dom.window.document.querySelectorAll('script[type="a-state"]')) {
      try {
        const text = element.textContent ?? '';
        if (text.length > 2_000_000) continue;
        for (const record of records(JSON.parse(text))) {
          const videoUrl = record.videoUrl ?? record.url;
          if (typeof videoUrl !== 'string' || !/\.(?:mp4|webm|m3u8)(?:[?#]|$)/i.test(videoUrl))
            continue;
          const direct = [record.productAsin, record.asin, record.videoAsin].filter(
            (value) => typeof value === 'string' && /^[A-Z0-9]{10}$/i.test(value),
          );
          const asins = direct.length
            ? direct
            : records(record)
                .map((entry) => entry.pageAsin)
                .filter((value) => typeof value === 'string' && /^[A-Z0-9]{10}$/i.test(value));
          if (
            !currentAsin ||
            !asins.some((asin) => asin.toUpperCase() === currentAsin.toUpperCase())
          )
            continue;
          const absolute = new URL(videoUrl.replaceAll('&amp;', '&'), url);
          if (absolute.protocol !== 'https:' && absolute.protocol !== 'http:') continue;
          independentlyBoundStateMedia.set(absolute.href, { url: absolute.href });
        }
      } catch {
        // Malformed a-state is counted by the retained source, never evaluated as JavaScript.
      }
    }
    // This is our own verified release artifact, never JavaScript read from Amazon HTML.
    dom.window.eval(contentSource);
    if (!listener) throw new Error('Frozen content listener was not installed');
    listener({ type: 'PRODUCTSPY_EXTRACT' }, { id: 'productspy-frozen-qa' }, (value) => {
      result = value;
    });
    return {
      status: result?.status ?? 'no-response',
      asin: result?.draft?.sourceId ?? null,
      videoCount: result?.draft?.videos?.length ?? null,
      videos: mediaSummary(result?.draft?.videos ?? []),
      independentlyBoundStateMedia: mediaSummary([...independentlyBoundStateMedia.values()]),
    };
  } finally {
    dom.window.close();
  }
}

async function bracket(label) {
  const raw = await page.evaluate(() => {
    const stateScripts = [...document.querySelectorAll('script[type="a-state"]')];
    const videoNodes = [...document.querySelectorAll('video,video source')];
    const productNodes = [
      ...document.querySelectorAll(
        '#imageBlock video,#imageBlock source,#video-player video,#video-player source,#imageBlock [data-video-url],#video-player [data-video-url]',
      ),
    ];
    return {
      timestamp: new Date().toISOString(),
      monotonicMilliseconds: performance.now(),
      readyState: document.readyState,
      asin: document.querySelector('input#ASIN,input[name="ASIN"]')?.value ?? null,
      titlePresent: !!document.querySelector('#productTitle')?.textContent?.trim(),
      challenge:
        !!document.querySelector('form[action*="validateCaptcha" i],#captchacharacters') ||
        /Robot Check|Enter the characters you see below|Type the characters you see in this image|Sorry, we just need to make sure you're not a robot/i.test(
          document.body?.innerText ?? '',
        ),
      stateScripts: stateScripts.map((element) => element.textContent ?? ''),
      inlineVideoData: [...document.querySelectorAll('script:not([src])')]
        .map((element) => element.textContent ?? '')
        .filter((text) => /videos|videoData|videoGalleryData/.test(text)),
      videoNodes: videoNodes.map((element) => ({
        src: element.getAttribute('src'),
        currentSrc: element.currentSrc ?? null,
        readyState: element.readyState ?? null,
        networkState: element.networkState ?? null,
      })),
      productVideoNodes: productNodes.map((element) => ({
        src: element.getAttribute('src') ?? element.getAttribute('data-video-url'),
        readyState: element.readyState ?? null,
      })),
      html: document.documentElement.outerHTML,
      url: location.href,
    };
  });
  const prefix = `${activeSample.asin}-${activeCapture.ordinal}-${label}`;
  const html = raw.html;
  const sourceUrl = raw.url;
  await writeFile(resolve(evidence, `${prefix}.html`), html);
  await writeFile(resolve(evidence, `${prefix}-raw.json`), JSON.stringify(raw, null, 2));
  const replayed = replay(html, sourceUrl);
  return {
    timestamp: raw.timestamp,
    monotonicMilliseconds: raw.monotonicMilliseconds,
    readyState: raw.readyState,
    asin: raw.asin,
    titlePresent: raw.titlePresent,
    challenge: raw.challenge,
    htmlSha256: hash(html),
    rawJsonSha256: hash(await readFile(resolve(evidence, `${prefix}-raw.json`))),
    stateScripts: raw.stateScripts.map((text) => ({
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    })),
    inlineVideoData: raw.inlineVideoData.map((text) => ({
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    })),
    videoNodeCount: raw.videoNodes.length,
    productVideoNodeCount: raw.productVideoNodes.length,
    videoNodeStates: raw.videoNodes.map((node) => ({
      srcSha256: node.src ? hash(node.src) : null,
      currentSrcSha256: node.currentSrc ? hash(node.currentSrc) : null,
      readyState: node.readyState,
      networkState: node.networkState,
    })),
    frozenExtractorReplay: replayed,
  };
}

async function challenge() {
  return page.evaluate(
    () =>
      !!document.querySelector('form[action*="validateCaptcha" i],#captchacharacters') ||
      /Robot Check|Enter the characters you see below|Type the characters you see in this image|Sorry, we just need to make sure you're not a robot/i.test(
        document.body?.innerText ?? '',
      ),
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
  const active = await popup.evaluate(async (expected) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url === expected;
  }, page.url());
  if (!active) throw new Error('activeTab grant was not visible to the isolated Popup');
}

try {
  context = await chromium.launchPersistentContext(resolve(evidence, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1365, height: 900 },
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  report.browser = {
    ...report.browser,
    version: context.browser().version(),
    headless: true,
    viewport: { width: 1365, height: 900 },
  };
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).hostname;
  session = await context.browser().newBrowserCDPSession();
  page = context.pages()[0];
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).waitFor();
  // The initial consent screen is left untouched until the first planned Amazon capture.
  // Reading the Popup UI does not call save, pair, download, or an AI endpoint.
  for (const sample of samples) {
    activeSample = {
      ...sample,
      requestedUrl: `https://www.amazon.com/dp/${sample.asin}`,
      captures: [],
    };
    report.samples.push(activeSample);
    if (blockedHosts.has('www.amazon.com')) {
      activeSample.outcome = 'not-attempted-after-host-challenge';
      await save();
      continue;
    }
    try {
      activeSample.navigationStartedAt = new Date().toISOString();
      const response = await page.goto(activeSample.requestedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 35000,
      });
      activeSample.httpStatus = response?.status() ?? null;
      await page
        .locator('#productTitle,form[action*="validateCaptcha" i]')
        .first()
        .waitFor({ state: 'attached', timeout: 8000 });
      activeSample.titleOrChallengeAttachedAt = new Date().toISOString();
      if (await challenge()) {
        blockedHosts.add('www.amazon.com');
        activeSample.outcome = 'challenge';
        await save();
        continue;
      }
      if (report.samples.length === 1) await grantActiveTab();
      else await page.bringToFront();
      for (const [index, settle] of [1800, 3000, 5000].entries()) {
        await page.waitForTimeout(settle);
        activeCapture = {
          ordinal: index + 1,
          settledMillisecondsSincePrevious: settle,
          interaction:
            report.samples.length === 1 && index === 0
              ? 'existing-consent-button'
              : 'existing-reidentify-button',
        };
        activeSample.captures.push(activeCapture);
        activeCapture.before = await bracket('before');
        if (activeCapture.before.challenge) {
          blockedHosts.add('www.amazon.com');
          activeCapture.outcome = 'challenge';
          break;
        }
        activeCapture.requestedAt = new Date().toISOString();
        const button = popup.getByRole('button', {
          name:
            activeCapture.interaction === 'existing-consent-button' ? '同意并开始采集' : '重新识别',
          exact: true,
        });
        await button.click();
        await popup
          .getByText('正在读取 Amazon 商品…', { exact: true })
          .waitFor({ state: 'hidden', timeout: 15000 });
        await popup
          .getByRole('button', { name: '重新识别', exact: true })
          .waitFor({ state: 'visible', timeout: 15000 });
        activeCapture.completedAt = new Date().toISOString();
        activeCapture.after = await bracket('after');
        const ui = await popup.locator('main').innerText();
        await writeFile(resolve(evidence, `${sample.asin}-${index + 1}-popup.txt`), ui);
        const screenshot = await popup.screenshot({ fullPage: true });
        await writeFile(resolve(evidence, `${sample.asin}-${index + 1}-popup.png`), screenshot);
        const videoCount = ui.match(/视频\s*\n\s*(\d+)/)?.[1];
        const displayedAsin = ui.match(/ASIN\s*[:：]?\s*([A-Z0-9]{10})/)?.[1] ?? null;
        activeCapture.popup = {
          outcome: ui.includes('商品已采集')
            ? 'captured'
            : ui.includes('暂时无法识别商品')
              ? 'error'
              : 'unsupported',
          asin: displayedAsin,
          videoCount: videoCount === undefined ? null : Number(videoCount),
          textSha256: hash(ui),
          screenshotSha256: hash(screenshot),
        };
        const beforeReplay = activeCapture.before.frozenExtractorReplay;
        const afterReplay = activeCapture.after.frozenExtractorReplay;
        activeCapture.asinMatched =
          displayedAsin === activeCapture.before.asin &&
          displayedAsin === activeCapture.after.asin &&
          displayedAsin === sample.asin;
        activeCapture.bracketStableVideoSet =
          JSON.stringify(beforeReplay.videos) === JSON.stringify(afterReplay.videos);
        activeCapture.bracketMilliseconds =
          Date.parse(activeCapture.after.timestamp) - Date.parse(activeCapture.before.timestamp);
        activeCapture.independentBoundMediaMissingFromReplay = [
          ...new Set(
            [
              ...beforeReplay.independentlyBoundStateMedia,
              ...afterReplay.independentlyBoundStateMedia,
            ].map((item) => item.urlSha256),
          ),
        ].filter(
          (sha) =>
            !beforeReplay.videos.some((item) => item.urlSha256 === sha) &&
            !afterReplay.videos.some((item) => item.urlSha256 === sha),
        );
        activeCapture.uiMatchesBothBracketCounts =
          activeCapture.popup.videoCount === beforeReplay.videoCount &&
          activeCapture.popup.videoCount === afterReplay.videoCount;
        activeCapture.outcome = !activeCapture.asinMatched
          ? 'requires-asin-review'
          : !activeCapture.bracketStableVideoSet
            ? 'changed-during-bracket'
            : activeCapture.uiMatchesBothBracketCounts
              ? 'consistent-at-both-brackets'
              : 'requires-parser-or-timing-review';
        activeCapture.actualCaptureResponseUrlsObserved = false;
        activeCapture.note =
          'Actual Popup output verifies ASIN and video count. Per-URL hashes belong to frozen-extractor replay of retained bracket HTML; no live response instrumentation was used.';
        captures.set(`${sample.asin}-${index + 1}`, activeCapture);
        await save();
        console.log(
          JSON.stringify({
            asin: sample.asin,
            ordinal: index + 1,
            outcome: activeCapture.outcome,
            uiVideoCount: activeCapture.popup.videoCount,
            before: beforeReplay.videoCount,
            after: afterReplay.videoCount,
          }),
        );
      }
      activeSample.outcome = activeSample.captures.some((item) => item.outcome === 'challenge')
        ? 'challenge'
        : activeSample.captures.length === 3
          ? 'completed-three-bounded-captures'
          : 'incomplete';
      const counts = activeSample.captures.map((item) => item.popup?.videoCount);
      activeSample.laterVideoCountIncreaseObserved = counts.some(
        (value, index) =>
          index > 0 &&
          typeof value === 'number' &&
          typeof counts[0] === 'number' &&
          value > counts[0],
      );
      activeSample.conclusion = activeSample.laterVideoCountIncreaseObserved
        ? 'Later bounded capture exposed more videos; retained brackets must be reviewed for delayed source data.'
        : 'No later count increase was observed in this run. This does not prove the historical timing difference cannot recur.';
    } catch (error) {
      activeSample.outcome = 'navigation-or-capture-error';
      activeSample.error = errorInfo(error);
      activeSample.noRetry = true;
      await writeFile(resolve(evidence, `${sample.asin}-error.txt`), String(error));
      if (await challenge().catch(() => false)) blockedHosts.add('www.amazon.com');
    }
    await save();
  }
} catch (error) {
  report.fatalError = errorInfo(error);
  await writeFile(resolve(evidence, 'fatal-error.txt'), String(error));
  process.exitCode = 1;
} finally {
  await context?.close();
  report.completedAt = new Date().toISOString();
  report.evidenceDirectory = relative(process.cwd(), evidence).replaceAll('\\', '/');
  report.counts = {
    primaryNavigationsAttempted: report.samples.filter((sample) => sample.navigationStartedAt)
      .length,
    capturesCompleted: captures.size,
    bridgeSaves: 0,
    aiCalls: 0,
    explicitMediaChecks: 0,
  };
  await save();
  console.log(
    JSON.stringify({
      output: relative(process.cwd(), output),
      evidence: report.evidenceDirectory,
      ...report.counts,
    }),
  );
}
