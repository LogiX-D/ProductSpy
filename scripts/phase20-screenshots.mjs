import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

// Caller-owned production service only. No private/default library, DOM edits,
// intercepted responses, real AI requests or fabricated Amazon product captures.
const index = process.argv.indexOf('--data-root');
assert(index >= 0 && process.argv[index + 1], 'Pass owned --data-root inside .test-data.');
const dataRoot = resolve(process.argv[index + 1]);
const localPath = relative(resolve('.test-data'), dataRoot);
assert(localPath && !localPath.startsWith('..') && !isAbsolute(localPath));
const phaseIndex = process.argv.indexOf('--phase');
const phase = phaseIndex < 0 ? 20 : Number(process.argv[phaseIndex + 1]);
assert([20, 21].includes(phase), 'Screenshot evidence phase must be 20 or 21.');
const output = resolve(`docs/screenshots/phase${phase}`);
await mkdir(output, { recursive: true });
const capturePath = resolve('.test-data/phase17-amazon/acceptance/report.json');
const bundleManifestPath = resolve(
  'artifacts/ProductSpy-1.0.0-rc.1-windows-x64/bundle-manifest.json',
);
const bundleManifestBytes = await readFile(bundleManifestPath);
assert.equal(JSON.parse(bundleManifestBytes.toString('utf8')).version, '1.0.0-rc.1');
const captures = JSON.parse(await readFile(capturePath, 'utf8'));
assert(captures.realPages === true && captures.mock === false);
const productSources = ['Logitech C920', 'Hanes hoodie'].map((label) =>
  captures.reports.find((row) => row.label === label && row.outcome === 'captured'),
);
assert(
  productSources.every((row) => row?.draft),
  'Use retained actual captures, not invented products.',
);
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const report = {
  phase,
  version: '1.0.0-rc.1',
  capturedAt: new Date().toISOString(),
  verified: false,
  production: true,
  portablePackage: {
    path: 'artifacts/ProductSpy-1.0.0-rc.1-windows-x64',
    bundleManifestSha256: createHash('sha256').update(bundleManifestBytes).digest('hex'),
  },
  ai: 'mock',
  realAiCalls: 0,
  productSource: `Retained actual Phase17 Amazon captures; no new Phase${phase} Amazon accuracy acceptance claimed`,
  sourceEvidence: {
    phase: 17,
    captureStartedAt: captures.startedAt,
    file: '.test-data/phase17-amazon/acceptance/report.json',
    sha256: createHash('sha256')
      .update(await readFile(capturePath))
      .digest('hex'),
  },
  stableChromeManualAcceptance: false,
  interceptedResponses: false,
  screenshots: [],
  checks: [],
  browser: {
    distribution: 'Chrome for Testing; installed stable Chrome manual acceptance remains pending',
    version: browser.version(),
    headless: true,
  },
  pairingSmallWindowReproduced: false,
  pairingDialogGeometry: [],
  interactions: [],
};
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  return page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-ProductSpy-Client': 'web' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const envelope = await response.json();
      if (!response.ok || !envelope.ok) throw new Error(envelope.error ?? `HTTP${response.status}`);
      return envelope.data;
    },
    { path, body, method },
  );
}
async function shot(file, { width = 1440, height = 1000, anchor } = {}) {
  await page.setViewportSize({ width, height });
  await page.locator('.loading-state').waitFor({ state: 'hidden' });
  if (anchor) {
    await page
      .locator(anchor)
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.evaluate(() => window.scrollBy(0, -85));
  } else await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        Promise.race([
          image.decode().catch(() => {}),
          new Promise((done) => setTimeout(done, 2000)),
        ]),
      ),
    );
  });
  const geometry = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  assert(
    geometry.documentWidth <= geometry.viewport + 1,
    `${file}: unexpected horizontal overflow`,
  );
  const path = join(output, file);
  await page.screenshot({ path });
  report.screenshots.push({
    file,
    path: relative(resolve('.'), path).replaceAll('\\', '/'),
    width,
    height,
    geometry,
    sha256: createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    realRenderedInterface: true,
  });
}
try {
  await page.goto('http://127.0.0.1:3000');
  const status = await api('/api/status');
  assert(status.version === '1.0.0-rc.1' && status.mode === 'mock');
  await api('/api/session', {});
  assert.equal(
    (await api('/api/products')).length,
    0,
    'Requires fresh isolated screenshot library.',
  );
  await page.goto('http://127.0.0.1:3000/products');
  await expect(page.getByRole('heading', { name: '还没有采集商品', exact: true })).toBeVisible();
  await shot('first-use-empty-library-375.png', { width: 375, height: 900 });
  const products = [];
  for (const row of productSources) products.push(await api('/api/products', row.draft));
  const stored = JSON.parse(await readFile(join(dataRoot, 'data/products.json'), 'utf8'));
  assert.equal(stored.products.length, 2, 'API and specified portable disk root must agree.');
  assert.equal(stored.products[0].sourceId, products[0].sourceId);
  products[0] = (
    await api('/api/analyze-product', { product: products[0], requestId: randomUUID() })
  ).product;
  report.checks.push(
    'Production API writes actual retained public capture snapshots to the caller-owned portable data directory.',
  );
  const { templates } = await api('/api/templates');
  const builtin = templates.find((template) => template.origin === 'builtin');
  const definition = Object.fromEntries(
    [
      'name',
      'description',
      'scenario',
      'category',
      'tags',
      'favorite',
      'prompt',
      'outputFields',
      'outputRequirements',
    ].map((key) => [key, builtin[key]]),
  );
  const template = await api('/api/templates', {
    ...definition,
    name: '日常办公：商品演示内容包',
    category: '产品演示',
    tags: ['日常办公', '拍摄前'],
    prompt:
      '为 {{product_title}} 写 {{duration}} 秒的日常办公演示，市场 {{market}}，语言 {{language}}。页面卖点 {{bullet_points}}。未知资料不要编造。',
  });
  let comparison = await api('/api/comparisons', {
    name: '已保存的页面资料对比',
    productIds: products.map((product) => product.id),
  });
  comparison = (
    await api('/api/analyze-comparison', {
      comparisonId: comparison.id,
      expectedUpdatedAt: comparison.updatedAt,
      requestId: randomUUID(),
    })
  ).plan;
  let plan = await api('/api/content-plans', {
    name: 'C920 日常办公演示方案',
    productId: products[0].id,
    templateId: template.id,
    comparisonId: comparison.id,
    options: {
      duration: 45,
      language: 'zh-CN',
      market: 'US',
      platform: 'Shorts',
      style: 'casual',
      creativeDirection: '桌面办公与会议准备',
      customInstructions: '避免夸大画质，使用自己拍摄的桌面演示。',
    },
  });
  if (products[0].mainImage)
    plan = await api(
      `/api/content-plans/${plan.id}`,
      {
        expectedUpdatedAt: plan.updatedAt,
        selectedMedia: [{ kind: 'image', url: products[0].mainImage }],
      },
      'PATCH',
    );
  const first = await api('/api/generate-content', {
    planId: plan.id,
    expectedUpdatedAt: plan.updatedAt,
    options: plan.options,
    requestId: randomUUID(),
  });
  plan = first.plan;
  plan = await api(
    `/api/content-plans/${plan.id}`,
    {
      expectedUpdatedAt: plan.updatedAt,
      output: {
        ...first.version.output,
        sellingCopy: ['人工草稿：围绕日常办公准备做商品演示；页面宣传参数仍需核查。'],
      },
      status: 'needs-edit',
    },
    'PATCH',
  );
  const manualId = plan.currentVersionId;
  const candidate = await api('/api/generate-content', {
    planId: plan.id,
    expectedUpdatedAt: plan.updatedAt,
    options: { ...plan.options, creativeDirection: '另一种开场：从会议准备的问题切入' },
    selectedFields: ['hooks'],
    requestId: randomUUID(),
  });
  plan = candidate.plan;
  assert.equal(plan.currentVersionId, manualId);
  assert.equal(plan.versions.length, 3);
  report.checks.push(
    'Mock first generation, manual editing and partial regeneration create 3 saved versions while retaining manual current.',
  );
  const modules = [
    { name: 'dashboard', path: '/', title: '首页' },
    { name: 'library', path: '/products', title: '商品库' },
    { name: 'detail', path: `/products/${products[0].id}`, title: products[0].title },
    { name: 'media', path: `/products/${products[0].id}?tab=media`, title: products[0].title },
    {
      name: 'analysis',
      path: `/products/${products[0].id}?tab=analysis`,
      title: products[0].title,
    },
    { name: 'comparison', path: `/comparisons?plan=${comparison.id}`, title: '竞品对比' },
    { name: 'templates', path: `/templates?product=${products[0].id}`, title: 'AI 模板' },
    { name: 'content', path: `/content?plan=${plan.id}`, title: plan.name },
    { name: 'settings', path: '/settings', title: '设置与业务备份' },
  ];
  // All screenshot content comes from the running packaged application. evaluate calls
  // only inspect geometry/fonts, scroll, or call the authenticated production API.
  for (const module of modules) {
    await page.goto(`http://127.0.0.1:3000${module.path}`);
    if (module.name !== 'dashboard')
      await expect(
        page.getByRole('heading', { name: module.title, exact: true }).first(),
      ).toBeVisible();
    else await expect(page.locator('.ws-main-content')).toBeVisible();
    for (const width of [1280, 768, 375, 320]) {
      await shot(`module-${module.name}-${width}.png`, {
        width,
        height: width <= 375 ? 900 : 1000,
        ...(module.name === 'media'
          ? { anchor: '.ws-media' }
          : module.name === 'analysis'
            ? { anchor: '#analysis-summary' }
            : module.name === 'content'
              ? { anchor: '.creation-result' }
              : {}),
      });
    }
  }
  await page.goto(`http://127.0.0.1:3000/comparisons?plan=${comparison.id}`);
  for (const width of [1280, 768, 375, 320])
    await shot(`comparison-table-${width}.png`, { width, height: 900, anchor: 'table' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/content?plan=${plan.id}`);
  await page.getByText('选择创作参考素材', { exact: false }).click();
  await expect(page.getByRole('checkbox', { name: '创作参考图片 1', exact: true })).toBeVisible();
  await shot('integration-selected-media.png', {
    width: 1280,
    anchor: 'summary:has-text("选择创作参考素材")',
  });
  await page.getByText('历史容量管理', { exact: true }).click();
  await expect(page.getByRole('group', { name: '选择历史版本', exact: true })).toBeVisible();
  await shot('integration-history-capacity.png', { width: 1280, anchor: '.history-manager' });
  report.interactions.push({
    kind: 'saved-media-and-history',
    selectedMedia: plan.selectedMedia,
    historyVersions: plan.versions.length,
    verified: true,
  });
  await page.goto('http://127.0.0.1:3000/settings');
  for (const width of [1280, 768, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const opener = page.getByRole('button', { name: '查看安装与配对说明', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: '首次使用 ProductSpy', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '生成配对码', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '生成配对码', exact: true }).scrollIntoViewIfNeeded();
    await page.keyboard.press('Shift+Tab');
    assert(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      'Keyboard focus stays inside the pairing dialog.',
    );
    const rectangle = await dialog.boundingBox();
    assert(
      rectangle && rectangle.width > 200 && rectangle.height > 200 && rectangle.width <= width,
      'Pairing dialog is not a tiny blank window.',
    );
    report.pairingDialogGeometry.push({
      width,
      rectangle,
      browserGeometry: await page.evaluate(() => ({
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
        visualViewportScale: visualViewport?.scale ?? null,
      })),
      osDisplayScaling: 'not measured; viewport/devicePixelRatio is not Windows DPI acceptance',
      generatedCode: false,
      actualNativeWindowReproduced: false,
    });
    await shot(`pairing-dialog-${width}.png`, { width, height: 1000 });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
  }
  report.interactions.push({
    kind: 'pairing-dialog',
    generatedSecrets: false,
    keyboardEscapeAndFocusReturn: true,
    nativeTinyWindowRootCause: 'Not reproduced; manual acceptance remains pending',
  });
  await page.goto('http://127.0.0.1:3000/templates');
  await expect(page.getByRole('heading', { name: 'AI 模板', exact: true })).toBeVisible();
  await shot('01-templates-desktop.png');
  const card = page.locator('article').filter({ hasText: template.name });
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('模板 Prompt')).toBeVisible();
  await shot('02-template-editor-preview.png');
  await page.getByText('变量预览 · 不调用 AI', { exact: true }).click();
  await page.getByLabel('预览商品').selectOption(products[0].id);
  await shot('08-template-variable-preview.png', { anchor: 'summary:has-text("变量预览")' });
  await page.keyboard.press('Escape');
  await page.goto(`http://127.0.0.1:3000/content?plan=${plan.id}`);
  await expect(page.getByText('C920 日常办公演示方案', { exact: true }).first()).toBeVisible();
  await shot('03-content-desktop.png');
  await page.getByRole('button', { name: '编辑内容', exact: true }).click();
  await shot('04-content-edit.png', { anchor: '[aria-label="编辑商品卖点文案"]' });
  await page.getByRole('button', { name: '取消编辑', exact: true }).click();
  await page.getByText('历史版本与比较', { exact: true }).click();
  await page.getByLabel('比较内容版本').selectOption(candidate.version.id);
  await shot('05-content-history.png', { anchor: 'summary:has-text("历史版本与比较")' });
  await shot('06-content-mobile.png', { width: 375, height: 812, anchor: '.creation-result' });
  await page.goto('http://127.0.0.1:3000/templates');
  await shot('07-templates-mobile.png', { width: 375, height: 812 });
  const extensionPath = resolve('artifacts/ProductSpy-1.0.0-rc.1-windows-x64/extension');
  const extensionManifest = JSON.parse(
    await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
  );
  assert.equal(extensionManifest.version, '1.0.0');
  assert.equal(extensionManifest.version_name, '1.0.0-rc.1');
  const popupContext = await chromium.launchPersistentContext(
    join(dataRoot, '..', 'popup-chrome-profile'),
    {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      viewport: { width: 400, height: 700 },
    },
  );
  try {
    const worker =
      popupContext.serviceWorkers()[0] ??
      (await popupContext.waitForEvent('serviceworker', { timeout: 45000 }));
    const extensionId = new URL(worker.url()).hostname;
    const popup = await popupContext.newPage();
    popup.on('pageerror', (error) => errors.push(`Extension: ${error.message}`));
    const popupStarted = Date.now();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // A toolbar popup is foreground. Explicitly activate the standalone QA tab too.
    await popup.bringToFront();
    await expect(popup.getByRole('button', { name: '同意并开始采集', exact: true })).toBeVisible();
    report.popupInitialization = {
      consentVisibleMs: Date.now() - popupStarted,
      assertionTimeoutMs: 5000,
      storageSeeded: false,
      state: await popup.evaluate(() => ({
        visibility: document.visibilityState,
        focused: document.hasFocus(),
      })),
    };
    const popupFile = join(output, 'popup-first-use-400.png');
    await popup.screenshot({ path: popupFile });
    report.screenshots.push({
      file: 'popup-first-use-400.png',
      path: relative(resolve('.'), popupFile).replaceAll('\\', '/'),
      width: 400,
      height: 700,
      sha256: createHash('sha256')
        .update(await readFile(popupFile))
        .digest('hex'),
      realRenderedInterface: true,
      extensionState: 'actual packaged MV3 first-use consent; no Amazon capture attempted',
    });
    report.interactions.push({
      kind: 'packaged-extension',
      manifestVersion: extensionManifest.version,
      permissions: extensionManifest.permissions,
      collectionConsentRendered: true,
      stableChromeManualAcceptance: false,
    });
  } finally {
    await popupContext.close();
  }
  // Actual deletion in the owned public demo library, not a mocked missing-source response.
  await api(`/api/products/${encodeURIComponent(products[0].id)}`, undefined, 'DELETE');
  await page.goto(`http://127.0.0.1:3000/content?plan=${plan.id}`);
  await expect(
    page.getByText('来源已删除，本方案快照和历史仍保留', { exact: true }).first(),
  ).toBeVisible();
  await page.getByText('查看保存的来源快照', { exact: true }).click();
  await shot('integration-deleted-source-snapshot.png', {
    width: 1280,
    anchor: '.integration-references',
  });
  assert.equal((await api(`/api/content-plans/${plan.id}`)).versions.length, 3);
  report.interactions.push({
    kind: 'actual-owned-source-deletion',
    deletedProductId: products[0].id,
    retainedPlanId: plan.id,
    retainedAsin: plan.productSnapshot.sourceId,
    retainedVersions: 3,
  });
  assert.equal(errors.length, 0, errors.join('\n'));
  const privateContent = JSON.parse(
    await readFile(join(dataRoot, 'data/content-plans.json'), 'utf8'),
  );
  assert.equal(privateContent.plans[0].currentVersionId, manualId);
  assert.equal(privateContent.plans[0].versions.length, 3);
  report.checks.push(
    'Final disk JSON preserves current manual version and all 3 versions; no page errors or document-level overflow at320/375/768/1280/1440px.',
  );
  report.verified = true;
} finally {
  report.pageErrors = errors;
  await browser.close();
  await writeFile(join(output, 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify(
    {
      verified: report.verified,
      screenshots: report.screenshots.length,
      report: join(output, 'provenance.json'),
    },
    null,
    2,
  ),
);
