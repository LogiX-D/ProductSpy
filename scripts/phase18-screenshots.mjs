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
const output = resolve('docs/screenshots/phase18');
await mkdir(output, { recursive: true });
const capturePath = resolve('.test-data/phase17-amazon/acceptance/report.json');
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
  phase: 18,
  version: '0.7.0',
  capturedAt: new Date().toISOString(),
  verified: false,
  production: true,
  ai: 'mock',
  realAiCalls: 0,
  productSource:
    'Retained actual Phase17 Amazon captures; no new Phase18 Amazon accuracy acceptance claimed',
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
  assert(status.version === '0.7.0' && status.mode === 'mock');
  await api('/api/session', {});
  assert.equal(
    (await api('/api/products')).length,
    0,
    'Requires fresh isolated screenshot library.',
  );
  const products = [];
  for (const row of productSources) products.push(await api('/api/products', row.draft));
  const stored = JSON.parse(await readFile(join(dataRoot, 'data/products.json'), 'utf8'));
  assert.equal(stored.products.length, 2, 'API and specified portable disk root must agree.');
  assert.equal(stored.products[0].sourceId, products[0].sourceId);
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
  assert.equal(errors.length, 0, errors.join('\n'));
  const privateContent = JSON.parse(
    await readFile(join(dataRoot, 'data/content-plans.json'), 'utf8'),
  );
  assert.equal(privateContent.plans[0].currentVersionId, manualId);
  assert.equal(privateContent.plans[0].versions.length, 3);
  report.checks.push(
    'Final disk JSON preserves current manual version and all 3 versions; no page errors or document-level overflow at1440/375px.',
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
