import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  artifactPath,
  inventory,
  digest,
  zipDirectory,
  workspace as root,
} from './packaging/files.mjs';
/* global chrome */

const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const bundle = artifactPath(`ProductSpy-${version}-windows-x64`);
const dist = resolve(bundle, 'extension');
const output = artifactPath('store');
const evidence = resolve(
  root,
  '.test-data/phase10-store',
  new Date().toISOString().replace(/[:.]/g, '-'),
);
const base = 'http://127.0.0.1:3000';
const url = process.argv[2] ?? 'https://www.amazon.com/dp/B09B8V1LZ3';
if (!/^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/.test(url))
  throw new Error('Provide a public Amazon product URL; no fixture pages are used by this script.');
await mkdir(resolve(output, 'screenshots'), { recursive: true });
await mkdir(evidence, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(bundle, 'bundle-manifest.json'), 'utf8'));
if (manifest.version !== version)
  throw new Error('Rebuild the portable package before capturing store assets');
const context = await chromium.launchPersistentContext(resolve(evidence, 'profile'), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    '--enable-unsafe-extension-debugging',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
  ],
});
const report = {
  version,
  browser: 'Chrome for Testing (not formal Chrome stable)',
  browserVersion: context.browser().version(),
  pageUrl: url,
  fixture: false,
  ai: 'mock',
  source: 'portable production build',
  capturedAt: new Date().toISOString(),
  verified: false,
  screenshots: [],
};
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const amazon = context.pages()[0];
  await amazon.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await amazon.locator('#productTitle:visible').first().waitFor({ timeout: 15000 });
  // Grant activeTab through the actual extension action. No broad Amazon host permission.
  await amazon.bringToFront();
  const session = await context.browser().newBrowserCDPSession();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === amazon.url());
  if (!target) throw new Error('Amazon product tab is unavailable');
  const id = new URL(worker.url()).hostname;
  await session.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await session.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 400, height: 600 });
  await amazon.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
  await popup.getByText('商品已采集', { exact: true }).waitFor({ timeout: 20000 });
  const captured = await popup.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'PRODUCTSPY_CAPTURE' }),
  );
  if (captured.status !== 'captured') throw new Error(captured.error ?? 'Product capture failed');
  const draft = captured.draft;
  report.capture = {
    asin: draft.sourceId,
    title: draft.title,
    price: draft.price,
    currency: draft.currency,
    brand: draft.brand,
    rating: draft.rating,
    reviewCount: draft.reviewCount,
    images: draft.images.length,
    videos: draft.videos.length,
    bulletPoints: draft.bulletPoints.length,
    descriptionCharacters: draft.description?.length ?? 0,
  };
  const page = await context.newPage();
  await page.goto(base);
  const status = await page.evaluate(async () => (await (await fetch('/api/status')).json()).data);
  if (status.mode !== 'mock' || status.version !== version)
    throw new Error('Screenshots require this portable version in Mock mode.');
  await page.getByRole('button', { name: '查看安装与配对说明' }).click();
  await page.getByRole('button', { name: '生成配对码', exact: true }).click();
  const code = await page.getByLabel('扩展配对码').inputValue();
  if (!(await popup.getByLabel('工作台配对码').isVisible()))
    await popup.locator('.connection-panel > summary').click();
  await popup.getByLabel('工作台配对码').fill(code);
  await popup.getByRole('button', { name: '连接工作台', exact: true }).click();
  await popup.getByText('工作台已连接', { exact: true }).waitFor();
  const saveButton = await popup
    .getByRole('button', { name: '保存到素材库', exact: true })
    .boundingBox();
  if (!saveButton || saveButton.y < 0 || saveButton.y + saveButton.height > 600)
    throw new Error('Save action is outside the ordinary popup viewport');
  await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
  await popup.getByRole('status').filter({ hasText: '已保存到素材库' }).waitFor();
  await popup.screenshot({ path: resolve(output, 'popup-400x600.png') });
  // No API credentials or pairing codes are included in screenshots or reports.
  await page.goto(
    `${base}/products/${encodeURIComponent(`amazon:${draft.sourceId}`)}?tab=analysis`,
  );
  await page.getByRole('heading', { name: draft.title, exact: true }).waitFor();
  const startAnalysis = page.getByRole('button', { name: '开始 AI 分析', exact: true });
  if (await startAnalysis.isVisible()) await startAnalysis.click();
  else {
    await page.getByRole('button', { name: '重新生成分析', exact: true }).click();
    await page.getByRole('button', { name: '确认重新生成', exact: true }).click();
  }
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  report.workflow = {
    consent: true,
    paired: true,
    saved: true,
    mockAnalysis: true,
    persistedAfterReload: true,
    popupActionVisible: true,
  };
  for (const [name, route, heading] of [
    ['01-dashboard.png', '/', '最近商品'],
    ['02-library.png', '/products', '商品库'],
    [
      '03-analysis.png',
      `/products/${encodeURIComponent(`amazon:${draft.sourceId}`)}?tab=analysis`,
      '商品总结',
    ],
  ]) {
    await page.goto(`${base}${route}`);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)));
    });
    if (heading === '商品总结') {
      await page
        .getByRole('heading', { name: 'AI 分析', exact: true })
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    }
    const path = resolve(output, 'screenshots', name);
    await page.screenshot({ path, fullPage: false });
    report.screenshots.push({
      file: `screenshots/${name}`,
      width: 1280,
      height: 800,
      sha256: await digest(path),
    });
  }
  report.verified = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await context.close();
  await writeFile(resolve(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
if (report.verified) {
  const fromWeb = createRequire(resolve(root, 'apps/web/package.json'));
  const sharp = createRequire(fromWeb.resolve('next/package.json'))('sharp');
  await sharp(await readFile(resolve(root, 'docs/store/promotional.svg')))
    .png()
    .toFile(resolve(output, 'promo-440x280.png'));
  report.promo = {
    file: 'promo-440x280.png',
    width: 440,
    height: 280,
    source: 'original vector brand graphic, not a UI screenshot',
  };
  await writeFile(resolve(output, 'asset-provenance.json'), `${JSON.stringify(report, null, 2)}\n`);
  const archive = artifactPath(`ProductSpy-${version}-store-materials.zip`);
  const { rm, cp } = await import('node:fs/promises');
  await cp(resolve(root, 'docs/store'), resolve(output, 'submission-text'), { recursive: true });
  await cp(resolve(root, 'PRIVACY.md'), resolve(output, 'PRIVACY.md'));
  await cp(resolve(root, 'docs/windows-guide.md'), resolve(output, 'FIRST-RUN.md'));
  await cp(resolve(dist, 'icons/icon-128.png'), resolve(output, 'icon-128.png'));
  await rm(resolve(output, 'asset-manifest.json'), { force: true });
  const files = await inventory(output);
  await writeFile(resolve(output, 'asset-manifest.json'), `${JSON.stringify(files, null, 2)}\n`);
  await rm(archive, { force: true });
  await zipDirectory(output, archive);
}
console.log(JSON.stringify(report, null, 2));
