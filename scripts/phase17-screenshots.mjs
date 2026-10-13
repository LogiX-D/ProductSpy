import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

// The caller must start an owned, isolated 0.6.0 production service. This script
// never starts/stops services, reads private libraries, changes AI configuration,
// calls real AI, intercepts responses or edits the rendered DOM.
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const base = 'http://127.0.0.1:3000';
const testRoot = resolve('.test-data');
const suppliedRoot = argument('--data-root');
assert(
  suppliedRoot,
  'Pass --data-root for the caller-owned isolated service. Never use a default user library.',
);
const dataRoot = resolve(suppliedRoot);
const relativeData = relative(testRoot, dataRoot);
assert(
  relativeData && !relativeData.startsWith('..') && !isAbsolute(relativeData),
  'The owned data root must be a child of .test-data.',
);
const evidencePath = resolve(
  argument('--amazon-report') ?? '.test-data/phase17-amazon/acceptance/report.json',
);
const output = resolve('docs/screenshots/phase17');
const source = JSON.parse(await readFile(evidencePath, 'utf8'));
assert(
  source.phase === 17 &&
    source.realPages === true &&
    source.mock === false &&
    source.extensionVersion === '0.6.0',
  'Use actual Phase 17 Amazon capture evidence, not synthetic fixtures.',
);
const captures = source.reports.filter((row) => row.outcome === 'captured' && row.draft);
const mediaSource = captures.find((row) => row.label === 'Logitech C920');
const comparisonSources = [
  captures.find((row) => row.label === 'Hanes hoodie'),
  captures.find((row) => row.label === 'Hanes hoodie visible variant'),
];
assert(
  mediaSource && comparisonSources.every(Boolean),
  'Current captures must include C920 and two real Hanes variants.',
);
assert(
  new Set(comparisonSources.map((row) => row.draft.sourceId)).size === 2,
  'Comparison sources require two distinct real ASINs.',
);
await mkdir(output, { recursive: true });
const digest = async (path) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
const report = {
  phase: 17,
  version: '0.6.0',
  source: 'Caller-owned isolated production workspace using actual Phase 17 Amazon captures',
  capturedAt: new Date().toISOString(),
  verified: false,
  realProductCaptures: true,
  fixture: false,
  ai: 'mock',
  realAiCalls: 0,
  stableChromeManualAcceptance: false,
  nativeFolderPickerManualAcceptance: false,
  isolatedDataRoot: relative(resolve('.'), dataRoot).replaceAll('\\', '/'),
  originalCaptureReport: relative(resolve('.'), evidencePath).replaceAll('\\', '/'),
  originalCaptureReportSha256: await digest(evidencePath),
  products: [mediaSource, ...comparisonSources].map((row) => ({
    asin: row.draft.sourceId,
    title: row.draft.title,
    pageUrl: row.pageUrl,
    originalCapturedAt: row.capturedAt,
    category: row.category,
    kind: row.kind,
    imageCount: row.draft.images.length,
    videoCount: row.draft.videos.length,
  })),
  screenshots: [],
  checks: [],
  consoleErrors: [],
};
const browser = await chromium.launch({ channel: 'chromium', headless: true });
report.browser = {
  distribution: 'Chrome for Testing (Playwright Chromium channel), not installed Chrome stable',
  version: browser.version(),
  headless: true,
};
const context = await browser.newContext({ viewport: { width: 1440, height: 940 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(40_000);
page.on('pageerror', (error) => report.consoleErrors.push(error.message));

async function request(path, method = 'GET', body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-ProductSpy-Client': 'web' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      return result.data;
    },
    { path, method, body },
  );
}
async function screenshot(file, { width = 1440, height = 940, anchor, fullPage = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.locator('.loading-state').waitFor({ state: 'hidden' });
  if (anchor) {
    await page
      .locator(anchor)
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -92));
  } else await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        Promise.race([
          image.decode().catch(() => undefined),
          new Promise((complete) => setTimeout(complete, 2500)),
        ]),
      ),
    );
  });
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    bodyWidth: document.documentElement.scrollWidth,
    tableViewport: document.querySelector('.comparison-table-wrap')?.clientWidth ?? null,
    tableContent: document.querySelector('.comparison-table-wrap')?.scrollWidth ?? null,
  }));
  assert(
    geometry.bodyWidth <= geometry.viewport + 1,
    `${file}: unintended page-level horizontal overflow`,
  );
  const path = join(output, file);
  await page.screenshot({ path, fullPage });
  report.screenshots.push({
    file,
    width,
    height,
    fullPage,
    path: relative(resolve('.'), path).replaceAll('\\', '/'),
    sha256: await digest(path),
    geometry,
    realRenderedInterface: true,
    interceptedResponses: false,
  });
}
try {
  await page.goto(base);
  const status = await request('/api/status');
  assert(
    status.version === '0.6.0' && status.mode === 'mock',
    'The owned service must run production v0.6.0 with explicit Mock mode.',
  );
  await request('/api/session', 'POST', {});
  const originalProducts = await request('/api/products');
  assert(
    originalProducts.length === 0,
    'Screenshot service must have a fresh, empty isolated library. Do not reuse a user or E2E library.',
  );
  const saved = [];
  for (const row of [mediaSource, ...comparisonSources])
    saved.push(await request('/api/products', 'POST', row.draft));
  let stored;
  for (const candidate of [join(dataRoot, 'products.json'), join(dataRoot, 'data/products.json')]) {
    try {
      stored = JSON.parse(await readFile(candidate, 'utf8'));
      break;
    } catch {
      /* Try the source data directory or portable user root. */
    }
  }
  const storedProducts = Array.isArray(stored) ? stored : stored?.products;
  assert(
    storedProducts?.length === 3 &&
      saved.every((product) =>
        storedProducts.some((row) => row.id === product.id && row.sourceId === product.sourceId),
      ),
    'Actual saved products must exist in the caller-owned isolated data root.',
  );
  const comparisonIds = saved.slice(1).map((product) => product.id);
  await page.goto(`${base}/comparisons?products=${encodeURIComponent(comparisonIds.join(','))}`);
  await page.getByRole('heading', { name: '竞品对比', exact: true }).waitFor();
  await expect(page.locator('.comparison-product-title')).toHaveCount(2);
  await page.getByLabel('对比方案名称', { exact: true }).fill('Hanes 连帽衫 · 页面变体对比');
  await page.getByRole('button', { name: '保存方案', exact: true }).click();
  await page.getByRole('button', { name: '开始 AI 对比分析', exact: true }).waitFor();
  await page.locator('.comparison-picker > summary').click();
  const savedPlan = (await request('/api/comparisons')).plans.find(
    (plan) => plan.name === 'Hanes 连帽衫 · 页面变体对比',
  );
  assert(savedPlan && savedPlan.products.length === 2);
  report.comparisonId = savedPlan.id;
  await screenshot('01-comparison-desktop.png', { anchor: '.comparison-table-toolbar' });
  await page.getByRole('button', { name: '开始 AI 对比分析', exact: true }).click();
  await page.getByRole('heading', { name: '核心差异', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '核心差异', exact: true }).waitFor();
  await expect(page.getByText('Mock · 本机演示', { exact: true })).toBeVisible();
  await page.locator('.analysis-options > summary').click();
  await screenshot('02-comparison-mock-analysis.png', { anchor: '.comparison-analysis' });
  await page.getByRole('button', { name: '编辑结果', exact: true }).click();
  await page.getByLabel('编辑核心差异', { exact: true }).waitFor();
  await screenshot('03-comparison-editor.png', { anchor: '.comparison-result-toolbar' });
  // Capture the actual editor without inventing product data or changing the generated result.
  await page.getByRole('button', { name: '结束编辑', exact: true }).click();
  await page.getByRole('button', { name: '保留草稿并结束', exact: true }).click();
  await page.goto(`${base}/products/${encodeURIComponent(saved[0].id)}?tab=media`);
  await page.getByRole('heading', { name: '商品素材', exact: true }).waitFor();
  await expect(page.locator('.ws-media-card, .ws-video-card')).toHaveCount(
    mediaSource.draft.images.length + mediaSource.draft.videos.length,
  );
  const sourceSelector = page.getByRole('combobox', { name: '图片 1 来源', exact: true });
  await expect(sourceSelector).toBeVisible();
  const originalSource = await sourceSelector.inputValue();
  assert(
    originalSource === mediaSource.draft.mainImage,
    'The actual captured preferred image must not be downgraded to a measured thumbnail.',
  );
  const sourceChoices = await sourceSelector.locator('option').count();
  assert(sourceChoices >= 2, 'Actual captured source variants must be available to the user.');
  await sourceSelector.selectOption({ index: sourceChoices - 1 });
  const alternateSource = await sourceSelector.inputValue();
  assert(alternateSource !== originalSource);
  assert(mediaSource.draft.mediaMetadata.some((asset) => asset.url === alternateSource));
  await expect(page.locator('.ws-media-card').first().locator('img')).toHaveAttribute(
    'src',
    alternateSource,
  );
  await sourceSelector.selectOption(originalSource);
  await expect(page.locator('.ws-media-card').first().locator('img')).toHaveAttribute(
    'src',
    originalSource,
  );
  report.checks.push({
    name: 'actual image metadata renders a source selector and switches preview to a captured variant',
    passed: true,
    sourceChoices,
  });
  report.mediaSourceSelection = {
    passed: true,
    sourceChoices,
    preservesCapturedPreferred: true,
    previewSwitchVerified: true,
  };
  await screenshot('04-media-images-desktop.png', { anchor: '.ws-media' });
  const videoSection = page.getByRole('heading', { name: /^商品视频/ });
  if (await videoSection.count()) {
    await videoSection.first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -92));
    await screenshot('05-media-videos-desktop.png', { anchor: '.ws-media-videos' });
  }
  await page.goto(`${base}/comparisons?plan=${encodeURIComponent(savedPlan.id)}`);
  await page.getByRole('heading', { name: '核心差异', exact: true }).waitFor();
  await page.locator('.comparison-picker > summary').click();
  await screenshot('06-comparison-mobile.png', {
    width: 375,
    height: 812,
    anchor: '.comparison-table-toolbar',
  });
  await page.locator('.analysis-options > summary').click();
  await screenshot('07-comparison-analysis-mobile.png', {
    width: 375,
    height: 812,
    anchor: '.comparison-analysis',
  });
  await page.goto(`${base}/products/${encodeURIComponent(saved[0].id)}?tab=media`);
  await page.getByRole('heading', { name: '商品素材', exact: true }).waitFor();
  await screenshot('08-media-mobile.png', { width: 375, height: 812, anchor: '.ws-media' });
  const usage = await request('/api/analysis-usage');
  assert(
    usage.totals.realRequests === 0,
    'No authorized real AI was provided; zero real requests required.',
  );
  const generated = await request(`/api/comparisons/${encodeURIComponent(savedPlan.id)}`);
  assert(
    generated.analysisMetadata?.mode === 'mock' &&
      generated.analysisHistory?.length >= 1 &&
      generated.products.length === 2,
    'Mock analysis, saved snapshots and history must remain after reload.',
  );
  assert(report.consoleErrors.length === 0, 'Rendered application produced page errors.');
  report.checks = [
    'Fresh caller-owned isolated library verified in local data directory',
    'Three real Amazon captures reused with original extraction timestamps and ASINs',
    'Two distinct Hanes clothing variants selected via actual UI',
    'Comparison saved and reloaded with two independent product snapshots',
    'Actual Mock analysis generated through UI; zero real AI requests',
    'Actual edit UI rendered without fabricating output',
    'Images and videos rendered separately using real extracted links',
    'Desktop and 375px layouts have no page-level horizontal overflow',
    'No DOM rewriting, no network response mocks, no stable Chrome or native Windows dialog claims',
  ];
  report.verified = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await browser.close();
  report.completedAt = new Date().toISOString();
  await writeFile(join(output, 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        verified: report.verified,
        screenshots: report.screenshots.length,
        output,
        error: report.error,
      },
      null,
      2,
    ),
  );
}
