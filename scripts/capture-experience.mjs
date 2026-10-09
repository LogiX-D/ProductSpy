import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { artifactPath, digest, inventory, zipDirectory, workspace } from './packaging/files.mjs';
/* global chrome */

const { version } = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = resolve(workspace, '.test-data/phase11-ui', stamp);
const output = artifactPath(`ProductSpy-${version}-experience`);
const bundle = artifactPath(`ProductSpy-${version}-windows-x64`);
const dataRoot = resolve(evidence, 'user');
const base = 'http://127.0.0.1:3000';
const url = process.argv[2] ?? 'https://www.amazon.com/dp/B00TTD9BRC';
if (!/^https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}$/.test(url))
  throw new Error('Provide a public Amazon product URL, never a fixture or authentication page.');
const portBusy = await new Promise((complete) => {
  const socket = createConnection({ host: '127.0.0.1', port: 3000 });
  socket.once('connect', () => {
    socket.destroy();
    complete(true);
  });
  socket.once('error', () => complete(false));
});
if (portBusy) throw new Error('Stop your existing workspace before this isolated acceptance run.');
await mkdir(evidence, { recursive: true });
await mkdir(output, { recursive: true });
const report = {
  version,
  source: 'portable production build',
  browser: 'Chrome for Testing, not installed Chrome stable',
  fixture: false,
  ai: 'mock',
  pageUrl: url,
  capturedAt: new Date().toISOString(),
  verified: false,
  checks: [],
  screenshots: [],
};
const args = (action) => [
  '-NoProfile',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  resolve(bundle, 'launcher/ProductSpy.ps1'),
  '-Headless',
  '-NoBrowser',
  '-Action',
  action,
  '-DataRoot',
  dataRoot,
  '-RuntimeRoot',
  resolve(dataRoot, 'runtime'),
];
const launcher = spawn('powershell.exe', args('Start'), { windowsHide: true, stdio: 'pipe' });
launcher.stdout.resume();
launcher.stderr.resume();
let context;
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (launcher.exitCode !== null) throw new Error('Portable launcher exited before readiness.');
    try {
      const response = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1000) });
      const status = (await response.json()).data;
      if (status?.version === version && status.mode === 'mock') return;
    } catch {
      /* wait for owned loopback service */
    }
    await new Promise((complete) => setTimeout(complete, 250));
  }
  throw new Error('Portable workspace did not start in Mock mode.');
}
async function screenshot(page, file, width, height, heading) {
  await page.setViewportSize({ width, height });
  if (heading)
    await page
      .getByRole('heading', { name: heading, exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate((hasHeading) => {
    if (hasHeading) window.scrollBy(0, -20);
    else window.scrollTo(0, 0);
    const popupContent = document.querySelector('.popup-content');
    if (popupContent) popupContent.scrollTop = 0;
  }, Boolean(heading));
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
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (overflow) throw new Error(`Horizontal overflow at ${width}px: ${file}`);
  const path = resolve(output, file);
  await page.screenshot({ path });
  report.screenshots.push({
    file,
    width,
    height,
    sha256: await digest(path),
    horizontalOverflow: false,
  });
}
try {
  await ready();
  context = await chromium.launchPersistentContext(resolve(evidence, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      '--enable-unsafe-extension-debugging',
      `--disable-extensions-except=${resolve(bundle, 'extension')}`,
      `--load-extension=${resolve(bundle, 'extension')}`,
    ],
  });
  report.browserVersion = context.browser().version();
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const amazon = context.pages()[0];
  await amazon.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await amazon.locator('#productTitle:visible').first().waitFor({ timeout: 15000 });
  const session = await context.browser().newBrowserCDPSession();
  const targets = await session.send('Target.getTargets', {
    filter: [{ type: 'tab', exclude: false }],
  });
  const target = targets.targetInfos.find((item) => item.url === amazon.url());
  if (!target) throw new Error('Amazon product tab not found');
  const id = new URL(worker.url()).hostname;
  await session.send('Extensions.triggerAction', { id, targetId: target.targetId });
  await session.detach();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({ width: 400, height: 600 });
  await amazon.bringToFront();
  await popup.reload();
  await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
  await popup.getByText('商品已采集', { exact: true }).waitFor();
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
    images: draft.images.length,
    videos: draft.videos.length,
    bulletPoints: draft.bulletPoints.length,
  };
  const page = await context.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: '查看安装与配对说明', exact: true }).click();
  await page.getByRole('button', { name: '生成配对码', exact: true }).click();
  const code = await page.getByLabel('扩展配对码').inputValue();
  if (!(await popup.getByLabel('工作台配对码').isVisible()))
    await popup.locator('.connection-panel > summary').click();
  await popup.getByLabel('工作台配对码').fill(code);
  await popup.getByRole('button', { name: '连接工作台', exact: true }).click();
  await popup.getByText('工作台已连接', { exact: true }).waitFor();
  await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
  await popup.getByRole('status').filter({ hasText: '已保存到素材库' }).waitFor();
  const details = popup.locator('.connection-panel');
  if ((await details.getAttribute('open')) !== null) await details.locator('summary').click();
  await screenshot(popup, '01-popup.png', 400, 600);
  const stats = await popup
    .locator('section[aria-label="商品已采集"] .grid > div')
    .last()
    .boundingBox();
  const content = await popup.locator('.popup-content').boundingBox();
  if (!stats || !content || stats.y + stats.height > content.y + content.height)
    throw new Error('Ordinary popup clips product statistics behind its fixed footer');
  await screenshot(popup, '02-popup-short.png', 400, 480);
  const action = await popup.getByRole('button', { name: '更新素材库', exact: true }).boundingBox();
  if (!action || action.y < 0 || action.y + action.height > 480)
    throw new Error('Short popup hides its save action');
  const productRoute = `/products/${encodeURIComponent(`amazon:${draft.sourceId}`)}`;
  await page.goto(`${base}${productRoute}?tab=analysis`);
  await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  for (const [file, route, heading] of [
    ['03-dashboard.png', '/', undefined],
    ['04-library.png', '/products', '商品库'],
    ['05-detail.png', productRoute, undefined],
    ['06-media.png', `${productRoute}?tab=media`, /商品图片/],
    ['07-analysis.png', `${productRoute}?tab=analysis`, 'AI 分析'],
  ]) {
    await page.goto(`${base}${route}`);
    await page
      .getByRole('heading', {
        name: route === '/' ? '最近商品' : (heading ?? draft.title),
        exact: true,
      })
      .waitFor();
    await page.locator('.loading-state').waitFor({ state: 'hidden' });
    if (route === '/' || route === '/products')
      await page.getByRole('link', { name: draft.title, exact: true }).waitFor();
    await screenshot(page, file, 1280, 800, heading);
  }
  await page.getByRole('button', { name: '编辑分析', exact: true }).click();
  await screenshot(page, '08-editor.png', 1280, 800, 'AI 分析');
  // Leave the original generated analysis unchanged; this run records genuine rendered editing UI.
  await page.goto(`${base}/products`);
  await page.getByRole('heading', { name: '商品库', exact: true }).waitFor();
  await screenshot(page, '09-library-mobile.png', 375, 812);
  await page.goto(`${base}${productRoute}?tab=analysis`);
  await page.getByRole('heading', { name: '商品总结', exact: true }).waitFor();
  await screenshot(page, '10-analysis-mobile.png', 375, 812, 'AI 分析');
  report.checks = [
    'portable startup',
    'first consent',
    'real Amazon capture',
    'authenticated pairing',
    'product save',
    'Mock analysis',
    'analysis after reload',
    'real editing UI',
    'short popup visible action',
    '375px and 1280px layouts without horizontal overflow',
  ];
  report.verified = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  const stop = spawn('powershell.exe', args('Stop'), { windowsHide: true, stdio: 'ignore' });
  if (stop.exitCode === null) await once(stop, 'exit');
  if (launcher.exitCode === null) await once(launcher, 'exit');
  await writeFile(resolve(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
if (report.verified) {
  await writeFile(resolve(output, 'provenance.json'), `${JSON.stringify(report, null, 2)}\n`);
  await rm(resolve(output, 'files.json'), { force: true });
  await writeFile(
    resolve(output, 'files.json'),
    `${JSON.stringify(await inventory(output), null, 2)}\n`,
  );
  const archive = artifactPath(`ProductSpy-${version}-experience.zip`);
  // Only this explicitly versioned generated archive may be replaced on a verified rerun.
  await rm(archive, { force: true });
  await zipDirectory(output, archive);
}
console.log(JSON.stringify({ ...report, evidence: evidence.replaceAll('\\', '/') }, null, 2));
