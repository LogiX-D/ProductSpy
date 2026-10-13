import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const contentKey = 'productspy:content-preferences:v1';
const favoritesKey = 'productspy:builtin-template-favorites:v1';
const expectedOptions = {
  market: 'UK',
  language: 'en',
  platform: 'Reels',
  style: 'humorous',
  duration: 45,
  goal: 'awareness',
  creativeDirection: 'Tabletop scene, no unverified claims.',
  customInstructions: 'Preserve saved source identifiers and avoid invented reviews.',
  customPrompt: 'Show five concrete shots and label unknown specifications.',
};
const expectedPricing = { inputUsdPerMillion: 0.75, outputUsdPerMillion: 2.25 };
const selectLabels = {
  market: '目标市场',
  language: '输出语言',
  platform: '内容平台',
  style: '内容风格',
  goal: '营销目标',
};

/** Real old/new UI, known-safe preference keys only; no business writes or AI calls permitted. */
export async function openContentUpgradePreferenceProbe(baseUrl, productId, evidenceRoot) {
  const origin = new URL(baseUrl);
  assert(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname));
  assert(
    origin.pathname === '/' &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
  );
  const evidence = resolve(evidenceRoot);
  await mkdir(evidence, { recursive: true });
  const profile = await mkdtemp(join(evidence, 'isolated-content-preferences-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  let deniedMutations = 0,
    blockedExternalRequests = 0,
    closed = false;
  let baseline, favoriteName;
  const stages = [];
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin.origin) {
      blockedExternalRequests++;
      await route.abort('blockedbyclient');
      return;
    }
    if (
      !['GET', 'HEAD'].includes(request.method()) &&
      !(url.pathname === '/api/session' && request.method() === 'POST')
    ) {
      deniedMutations++;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  async function preferences() {
    return page.evaluate(
      ({ content, favorites }) => ({
        content: localStorage.getItem(content),
        favorites: localStorage.getItem(favorites),
      }),
      { content: contentKey, favorites: favoritesKey },
    );
  }
  async function openOptions() {
    await page.goto(`${origin.origin}/content?product=${encodeURIComponent(productId)}`);
    const panel = page
      .locator('details.creation-panel')
      .filter({ has: page.getByText('创作参数与请求设置', { exact: true }) });
    await expect(panel).toHaveCount(1);
    if ((await panel.getAttribute('open')) === null)
      await panel.locator(':scope > summary').click();
    await expect(page.getByLabel('视频时长（秒）', { exact: true })).toBeVisible();
  }
  async function openPricing() {
    const panel = page
      .locator('details')
      .filter({ has: page.locator('summary').filter({ hasText: /^可选：自填费用估算单价$/ }) })
      .last();
    if ((await panel.getAttribute('open')) === null)
      await panel.locator(':scope > summary').click();
  }
  async function report() {
    await writeFile(
      join(evidence, 'content-browser-preferences.json'),
      JSON.stringify(
        {
          kind: 'isolated-v0.7-content-preference-upgrade',
          browser: 'Playwright Chromium, not manual Chrome stable acceptance',
          keys: [contentKey, favoritesKey],
          expectedOptions,
          expectedPricing,
          favoriteName,
          stages,
          deniedMutations,
          blockedExternalRequests,
          aiRequestsAllowed: false,
          businessWritesAllowed: false,
          cookiesInspected: false,
        },
        null,
        2,
      ),
    );
  }
  async function verify(stage) {
    assert(!closed);
    const record = { stage, passed: false, checkedAt: new Date().toISOString() };
    stages.push(record);
    try {
      await openOptions();
      for (const [field, label] of Object.entries(selectLabels))
        await expect(page.getByLabel(label, { exact: true })).toHaveValue(expectedOptions[field]);
      await expect(page.getByLabel('视频时长（秒）', { exact: true })).toHaveValue('45');
      for (const [field, label] of [
        ['creativeDirection', '本次创意方向'],
        ['customInstructions', '自定义内容要求'],
        ['customPrompt', '追加 Prompt'],
      ])
        await expect(page.getByLabel(label, { exact: true })).toHaveValue(expectedOptions[field]);
      await openPricing();
      await expect(page.getByLabel('输入单价', { exact: true })).toHaveValue('0.75');
      await expect(page.getByLabel('输出单价', { exact: true })).toHaveValue('2.25');
      assert.deepEqual(
        await preferences(),
        baseline,
        'Content preferences and favorites must remain byte-identical.',
      );
      await page.screenshot({
        path: join(evidence, `${stage}-content-preferences.png`),
        fullPage: false,
      });
      await page.goto(`${origin.origin}/templates`);
      await expect(
        page.getByRole('button', { name: `取消收藏 ${favoriteName}`, exact: true }),
      ).toBeVisible();
      assert.deepEqual(await preferences(), baseline);
      assert.equal(
        deniedMutations,
        0,
        'Preference UI must never attempt business mutations or paid AI.',
      );
      record.passed = true;
    } catch (error) {
      record.error = error.message;
      await page
        .screenshot({
          path: join(evidence, `${stage}-content-preferences-failure.png`),
          fullPage: false,
        })
        .catch(() => undefined);
      throw error;
    } finally {
      await report();
    }
  }
  try {
    await openOptions();
    for (const [field, label] of Object.entries(selectLabels))
      await page.getByLabel(label, { exact: true }).selectOption(expectedOptions[field]);
    await page.getByLabel('视频时长（秒）', { exact: true }).fill('45');
    for (const [field, label] of [
      ['creativeDirection', '本次创意方向'],
      ['customInstructions', '自定义内容要求'],
      ['customPrompt', '追加 Prompt'],
    ])
      await page.getByLabel(label, { exact: true }).fill(expectedOptions[field]);
    await openPricing();
    await page.getByLabel('输入单价', { exact: true }).fill('0.75');
    await page.getByLabel('输出单价', { exact: true }).fill('2.25');
    await page.getByRole('button', { name: '保存创作偏好', exact: true }).click();
    await expect(page.getByText('创作偏好已保存到本浏览器。', { exact: true })).toBeVisible();
    await page.goto(`${origin.origin}/templates`);
    const card = page
      .locator('.template-card')
      .filter({ has: page.getByText('内置模板', { exact: true }) })
      .first();
    const favorite = card.getByRole('button', { name: /^收藏 / });
    await expect(favorite).toBeVisible();
    favoriteName = (await favorite.getAttribute('aria-label')).replace(/^收藏 /, '');
    await favorite.click();
    await expect(
      page.getByRole('button', { name: `取消收藏 ${favoriteName}`, exact: true }),
    ).toBeVisible();
    baseline = await preferences();
    assert.deepEqual(JSON.parse(baseline.content), {
      version: 1,
      options: expectedOptions,
      pricing: expectedPricing,
    });
    assert.equal(JSON.parse(baseline.favorites).length, 1);
    await verify('old-package-baseline');
  } catch (error) {
    await report();
    await context.close();
    throw error;
  }
  return {
    verifyAfterRestart: verify,
    async close() {
      if (closed) return;
      closed = true;
      await context.close();
      await report();
      assert.equal(deniedMutations, 0);
    },
  };
}
