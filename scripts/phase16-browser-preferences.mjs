import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const analysisKey = 'productspy:analysis-preferences:v1';
const libraryKey = 'productspy:library-preferences:v1';
const expectedOptions = {
  market: 'JP',
  language: 'ja',
  platform: 'Shorts',
  style: 'professional',
  duration: 15,
  goal: 'consideration',
  customInstructions: 'Phase 16 preference fixture: show a tabletop demonstration.',
};
const expectedPricing = { inputUsdPerMillion: 1.25, outputUsdPerMillion: 3.75 };
const selectLabels = {
  market: '目标市场',
  language: '输出语言',
  platform: '内容平台',
  style: '内容风格',
  duration: '视频时长',
  goal: '营销目标',
};

/**
 * Run only against the caller's isolated old portable service. This helper owns
 * its browser, not any service process, product, user profile or AI settings.
 * All preference changes go through the actual UI; only two known-safe local
 * storage values are inspected. No cookies or other browser storage are read.
 */
export async function openUpgradePreferenceProbe(baseUrl, productId, evidenceRoot) {
  const base = new URL(baseUrl);
  assert(
    base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname),
    'The preference probe requires a local HTTP test service.',
  );
  assert(
    base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
    'The preference probe base URL must contain only a loopback origin.',
  );
  assert(typeof productId === 'string' && productId.length > 0 && productId.length < 500);
  const evidence = resolve(evidenceRoot);
  await mkdir(evidence, { recursive: true });
  const profile = await mkdtemp(join(evidence, 'isolated-preference-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  });
  let deniedMutations = 0;
  let blockedExternalRequests = 0;
  let closed = false;
  const stages = [];
  const selectorChecks = [];
  const preferenceMigrations = [];
  const reportPath = join(evidence, 'browser-preferences.json');
  let savedPreferences;
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);

  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base.origin) {
      blockedExternalRequests++;
      await route.abort('blockedbyclient');
      return;
    }
    const method = request.method();
    if (
      !['GET', 'HEAD'].includes(method) &&
      !(url.pathname === '/api/session' && method === 'POST')
    ) {
      deniedMutations++;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  async function preferences() {
    // Deliberately avoid enumerating storage or persisting storageState/cookies.
    return page.evaluate(
      ({ analysis, library }) => ({
        analysis: localStorage.getItem(analysis),
        library: localStorage.getItem(library),
      }),
      { analysis: analysisKey, library: libraryKey },
    );
  }

  async function openAnalysis() {
    await page.goto(`${base.origin}/products/${encodeURIComponent(productId)}?tab=analysis`);
    const options = page.locator('.analysis-options');
    await expect(options).toBeAttached();
    if ((await options.getAttribute('open')) === null)
      await options.locator(':scope > summary').click();
    await expect(page.getByLabel('目标市场', { exact: true })).toBeVisible();
  }

  async function openPricing() {
    const pricing = page.locator('.analysis-price-settings');
    if ((await pricing.getAttribute('open')) === null)
      await pricing.locator(':scope > summary').click();
  }

  async function sortControl(stage) {
    await expect(page.locator('.ws-library-toolbar')).toBeVisible();
    const current = page.getByLabel('商品排序', { exact: true });
    if ((await current.count()) === 1) {
      selectorChecks.push({ stage, selector: 'explicit accessible label' });
      return current;
    }
    // Frozen v0.4.0 (7a3c919) nests a select in this known label without an
    // aria-label. Its computed name includes option text, so an exact current
    // accessible name cannot find it. Do not fall back to a select index.
    const legacy = page
      .locator('label.ws-filter')
      .filter({ has: page.locator('span').filter({ hasText: /^商品排序$/ }) })
      .locator('select');
    await expect(legacy).toHaveCount(1);
    await expect(legacy).toBeVisible();
    selectorChecks.push({ stage, selector: 'verified v0.4.0 label-scoped select' });
    return legacy;
  }

  async function verifyStoredPreferences(stage) {
    const restored = await preferences();
    assert.equal(
      restored.analysis,
      savedPreferences.analysis,
      'Analysis preferences must remain byte-for-byte identical.',
    );
    assert(restored.library, 'Library preferences must remain saved.');
    const baseline = JSON.parse(savedPreferences.library);
    const current = JSON.parse(restored.library);
    for (const [key, value] of Object.entries(baseline))
      assert.deepEqual(current[key], value, `Library preference ${key} must retain its old value.`);
    const added = Object.keys(current).filter((key) => !Object.hasOwn(baseline, key));
    for (const key of added) {
      assert(
        ['group', 'tag'].includes(key),
        `Unexpected library preference migration field: ${key}`,
      );
      assert.equal(current[key], 'all', `New library ${key} filter must default to all.`);
    }
    preferenceMigrations.push({
      stage,
      libraryStoredBytesUnchanged: restored.library === savedPreferences.library,
      preservedFields: Object.keys(baseline),
      additiveDefaults: Object.fromEntries(added.map((key) => [key, current[key]])),
    });
  }

  async function captureFailure(stage, error) {
    const stem = stage.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    // Only this fresh synthetic-service browser is inspected. Never enumerate
    // cookies, other storage, input contents or the analysis text for diagnosis.
    const diagnostic = {
      stage,
      error: error.message,
      path: new URL(page.url()).pathname,
      libraryLabels: await page.locator('label.ws-filter').evaluateAll((labels) =>
        labels.map((label) => ({
          caption: label.querySelector('span')?.textContent?.trim(),
          selectAriaLabel: label.querySelector('select')?.getAttribute('aria-label'),
          selectCount: label.querySelectorAll('select').length,
        })),
      ),
    };
    await writeFile(
      join(evidence, `${stem}-diagnostic.json`),
      `${JSON.stringify(diagnostic, null, 2)}\n`,
    );
    await page.screenshot({ path: join(evidence, `${stem}.png`), fullPage: false });
  }

  async function saveReport() {
    await writeFile(
      reportPath,
      `${JSON.stringify(
        {
          kind: 'isolated-browser-preference-upgrade-test',
          browser: 'Playwright Chromium; not a manual Chrome stable acceptance',
          origin: base.origin,
          keys: [analysisKey, libraryKey],
          expectedPreferences: savedPreferences,
          stages,
          selectorChecks,
          preferenceMigrations,
          blockedExternalRequests,
          deniedMutations,
          aiRequestsAllowed: false,
          productWritesAllowed: false,
          cookiesInspected: false,
        },
        null,
        2,
      )}\n`,
    );
  }

  async function verify(stage) {
    assert(!closed, 'The owned preference browser is closed.');
    assert(typeof stage === 'string' && stage.length > 0 && stage.length <= 200);
    const stageFile = stage.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
    const record = { stage, checkedAt: new Date().toISOString(), passed: false };
    stages.push(record);
    try {
      await openAnalysis();
      for (const [key, label] of Object.entries(selectLabels))
        await expect(page.getByLabel(label, { exact: true })).toHaveValue(
          String(expectedOptions[key]),
        );
      await expect(page.getByLabel('自定义分析要求', { exact: true })).toHaveValue(
        expectedOptions.customInstructions,
      );
      await openPricing();
      await expect(page.getByLabel('输入单价', { exact: true })).toHaveValue('1.25');
      await expect(page.getByLabel('输出单价', { exact: true })).toHaveValue('3.75');
      await verifyStoredPreferences(`${stage}:analysis`);
      await page.screenshot({
        path: join(evidence, `${stageFile}-analysis-preferences.png`),
        fullPage: false,
      });
      await page.goto(`${base.origin}/products`);
      await expect(await sortControl(stage)).toHaveValue('title-asc');
      await expect(page.getByRole('button', { name: '列表视图', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await verifyStoredPreferences(`${stage}:library`);
      assert.equal(
        deniedMutations,
        0,
        'Preference-only UI must not try an AI or product mutation.',
      );
      await page.screenshot({
        path: join(evidence, `${stageFile}-library-preferences.png`),
        fullPage: false,
      });
      record.passed = true;
    } catch (error) {
      record.error = error.message;
      await captureFailure(`${stageFile}-failure`, error).catch((diagnosticError) => {
        record.diagnosticError = diagnosticError.message;
      });
      throw error;
    } finally {
      await saveReport();
    }
  }

  try {
    await openAnalysis();
    for (const [key, label] of Object.entries(selectLabels))
      await page.getByLabel(label, { exact: true }).selectOption(String(expectedOptions[key]));
    await page
      .getByLabel('自定义分析要求', { exact: true })
      .fill(expectedOptions.customInstructions);
    await openPricing();
    await page.getByLabel('输入单价', { exact: true }).fill('1.25');
    await page.getByLabel('输出单价', { exact: true }).fill('3.75');
    await page.getByRole('button', { name: '保存分析偏好', exact: true }).click();
    await expect(page.getByText('已保存到本浏览器。', { exact: true })).toBeVisible();
    await page.goto(`${base.origin}/products`);
    await (await sortControl('old-package-setup')).selectOption('title-asc');
    await page.getByRole('button', { name: '列表视图', exact: true }).click();
    savedPreferences = await preferences();
    assert(
      savedPreferences.analysis && savedPreferences.library,
      'Both preference keys must be saved by the old UI.',
    );
    assert.deepEqual(JSON.parse(savedPreferences.analysis), {
      version: 1,
      options: expectedOptions,
      pricing: expectedPricing,
    });
    assert.equal(JSON.parse(savedPreferences.library).layout, 'list');
    assert.equal(JSON.parse(savedPreferences.library).sort, 'title-asc');
    await verify('old-package-baseline');
  } catch (error) {
    await captureFailure('setup-failure', error).catch((diagnosticError) => {
      stages.push({
        stage: 'setup-failure-diagnostic',
        passed: false,
        error: diagnosticError.message,
      });
    });
    await saveReport();
    await context.close();
    throw error;
  }

  return {
    verifyAfterRestart: verify,
    async close() {
      if (closed) return;
      closed = true;
      await context.close();
      await saveReport();
      assert.equal(
        deniedMutations,
        0,
        'The preference probe must not attempt paid AI or product writes.',
      );
    },
  };
}
