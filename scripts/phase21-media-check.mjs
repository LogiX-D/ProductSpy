import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from '@playwright/test';
assert.equal(process.platform, 'win32', 'This probe uses the actual Windows portable package.');
assert(process.argv[2], 'Pass the caller-owned .test-data/phase21-media/.../user directory.');
const dataRoot = resolve(process.argv[2]);
assert(dataRoot.startsWith(resolve('.test-data/phase21-media') + '\\'));
const output = resolve('docs/screenshots/phase21-media');
await mkdir(output, { recursive: true });
const sha = (v) => createHash('sha256').update(v).digest('hex');
const report = {
  phase: 21,
  version: '1.0.0-rc.1',
  startedAt: new Date().toISOString(),
  method:
    'Actual frozen portable UI, foreground CFT, retained public Phase17 captures; no interceptions or DOM changes',
  realAiCalls: 0,
  stableChromeManual: false,
  observations: [],
  network: [],
  pageErrors: [],
  screenshots: [],
};
const browser = await chromium.launch({ channel: 'chromium', headless: true });
report.browser = browser.version();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
page.on('pageerror', (e) => report.pageErrors.push(e.message));
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.hostname === 'm.media-amazon.com')
    report.network.push({
      urlSha256: sha(r.url()),
      status: r.status(),
      contentType: r.headers()['content-type'],
    });
});
page.on('requestfailed', (r) => {
  const u = new URL(r.url());
  if (u.hostname === 'm.media-amazon.com')
    report.network.push({ urlSha256: sha(r.url()), failure: r.failure()?.errorText });
});
async function api(path, body) {
  return page.evaluate(
    async ({ path, body }) => {
      const r = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-productspy-client': 'web' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const e = await r.json();
      if (!r.ok || !e.ok) throw Error(e.error);
      return e.data;
    },
    { path, body },
  );
}
async function inspect(label) {
  const start = Date.now();
  await page.bringToFront();
  let readiness = 'ready';
  try {
    await page.waitForFunction(
      () => {
        const images = [...document.images].filter((i) => {
          const r = i.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
        });
        return images.length > 0 && images.every((i) => i.complete && i.naturalWidth > 0);
      },
      {},
      { timeout: 15000 },
    );
  } catch {
    readiness = 'visible image decode did not finish in 15s';
  }
  const values = await page.evaluate(() =>
    [...document.images].map((i) => {
      const r = i.getBoundingClientRect(),
        s = getComputedStyle(i);
      return {
        src: i.currentSrc || i.src,
        complete: i.complete,
        width: i.naturalWidth,
        height: i.naturalHeight,
        loading: i.loading,
        box: { x: r.x, y: r.y, width: r.width, height: r.height },
        display: s.display,
        opacity: s.opacity,
        visibleInViewport: r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0,
      };
    }),
  );
  report.observations.push({
    label,
    readiness,
    elapsedMs: Date.now() - start,
    images: values.map((v) => {
      const { src, ...rest } = v;
      return { ...rest, urlSha256: sha(src) };
    }),
  });
  const path = join(output, label + '-1280.png');
  await page.screenshot({ path });
  report.screenshots.push({
    path: path.replace(process.cwd() + '\\', '').replaceAll('\\', '/'),
    sha256: sha(await readFile(path)),
  });
}
try {
  await page.goto('http://127.0.0.1:3000');
  await api('/api/session', {});
  const status = await api('/api/status');
  assert.equal(status.version, report.version);
  assert.equal(status.mode, 'mock');
  assert.equal((await api('/api/products')).length, 0);
  const captures = JSON.parse(
    await readFile('.test-data/phase17-amazon/acceptance/report.json', 'utf8'),
  );
  assert(captures.realPages && !captures.mock);
  report.sourceSha256 = sha(await readFile('.test-data/phase17-amazon/acceptance/report.json'));
  const products = [];
  for (const label of ['Logitech C920', 'Hanes hoodie']) {
    const row = captures.reports.find((r) => r.label === label && r.outcome === 'captured');
    assert(row?.draft);
    products.push(await api('/api/products', row.draft));
  }
  const disk = JSON.parse(await readFile(join(dataRoot, 'data/products.json'), 'utf8'));
  assert.equal(disk.products.length, 2);
  assert.equal(disk.products[0].id, products[0].id);
  await page.goto('http://127.0.0.1:3000/products');
  await page.getByRole('heading', { name: '商品库', exact: true }).waitFor();
  await page.locator('.ws-card-image img').first().waitFor();
  await inspect('library');
  await page.goto(`http://127.0.0.1:3000/products/${products[0].id}?tab=media`);
  await page.locator('.ws-media-card img').first().waitFor();
  await page.locator('.ws-media').scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -85));
  await inspect('media');
  report.frozenBundleManifestSha256 = sha(
    await readFile('artifacts/ProductSpy-1.0.0-rc.1-windows-x64/bundle-manifest.json'),
  );
  report.finishedAt = new Date().toISOString();
  try {
    report.httpHeadProbe = JSON.parse(
      await readFile('.test-data/phase21/media-probe.json', 'utf8'),
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    report.httpHeadProbe = {
      performed: false,
      reason: 'Optional earlier HTTP diagnostic is absent.',
    };
  }
  report.publicationApproved = false;
} finally {
  await browser.close();
  await writeFile('docs/phase21/media-preview-check.json', JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
assert.equal(report.pageErrors.length, 0, 'Retain and investigate browser page errors.');
assert(
  report.observations.length === 2 &&
    report.observations.every((item) => item.readiness === 'ready'),
  'Visible media did not decode; inspect the retained diagnostic instead of claiming a pass.',
);
