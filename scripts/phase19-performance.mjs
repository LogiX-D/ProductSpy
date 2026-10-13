import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';

// Runs against a caller-owned frozen production portable service. All records are
// labelled synthetic. No real AI, Amazon navigation, private profiles or credentials.
const { values } = parseArgs({
  options: {
    'data-root': { type: 'string' },
    'server-pid': { type: 'string' },
    version: { type: 'string' },
    'startup-ms': { type: 'string' },
  },
});
const root = resolve(values['data-root'] ?? '');
const scope = relative(resolve('.test-data'), root);
assert(scope && !scope.startsWith('..') && !isAbsolute(scope), 'Use isolated .test-data root.');
const pid = Number(values['server-pid']);
assert(Number.isInteger(pid) && pid > 0);
const run = promisify(execFile);
const output = resolve('.test-data/phase19');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const report = {
  version: values.version,
  production: true,
  synthetic: true,
  realAiCalls: 0,
  capturedAt: new Date().toISOString(),
  startupMs: Number(values['startup-ms']),
  samples: [],
  modules: [],
  memorySamples: [],
  checks: [],
  passed: false,
};
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const started = performance.now();
  const response = await page.request.fetch(`http://127.0.0.1:3000${path}`, {
    method,
    headers: {
      Origin: 'http://127.0.0.1:3000',
      'Content-Type': 'application/json',
      'X-ProductSpy-Client': 'web',
      'Sec-Fetch-Site': 'same-origin',
    },
    ...(body === undefined ? {} : { data: body }),
    timeout: 120000,
  });
  const bytes = await response.body();
  const envelope = JSON.parse(bytes.toString());
  assert(response.ok() && envelope.ok, `${path}: ${response.status()} ${envelope.error}`);
  return { data: envelope.data, ms: performance.now() - started, bytes: bytes.length };
}
async function rss(label) {
  const result = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`,
    ],
    { windowsHide: true },
  );
  report.memorySamples.push({ label, serviceWorkingSetBytes: Number(result.stdout.trim()) });
}
function stats(numbers) {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
    p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10,
  };
}
async function importRecords(path, backup) {
  const preview = (await api(path, { backup })).data;
  return api(path, { backup, commit: true, policy: 'skip', expectedRevision: preview.revision });
}
async function disk(directory) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = await disk(file);
      bytes += child.bytes;
      files += child.files;
    } else if (entry.isFile()) {
      bytes += (await stat(file)).size;
      files++;
    }
  }
  return { bytes, files };
}
try {
  await page.goto('http://127.0.0.1:3000');
  const status = (await api('/api/status')).data;
  assert.equal(status.version, values.version);
  assert.equal(status.mode, 'mock');
  await api('/api/session', {});
  assert.equal((await api('/api/products')).data.length, 0);
  await rss('empty');
  const now = new Date().toISOString();
  const analysis = {
    summary: '合成容量样本，不代表真实商品分析质量',
    sellingPoints: ['合成卖点'],
    targetAudience: ['待验证用户'],
    purchaseMotivations: ['假设'],
    painPoints: ['假设'],
    strengths: ['假设'],
    weaknesses: ['待确认'],
    marketingAngles: ['合成测试'],
    hooks: ['1', '2', '3', '4', '5'],
    shortVideoScript: 'Hook: sample\nProblem: sample\nSolution: sample\nDemo: sample\nCTA: sample',
    imagePrompts: ['测试'],
    videoPrompts: ['测试'],
  };
  const products = Array.from({ length: 1000 }, (_, i) => {
    const asin = `B019${String(i).padStart(6, '0')}`;
    const history =
      i >= 800 && i < 840
        ? Array.from({ length: 40 }, () => ({
            id: randomUUID(),
            createdAt: now,
            kind: 'edited',
            analysis,
          }))
        : undefined;
    return {
      id: `amazon:${asin}`,
      source: 'amazon',
      sourceId: asin,
      url: `https://www.amazon.com/dp/${asin}`,
      title: `合成性能商品 ${String(i).padStart(4, '0')} · 非真实采集`,
      price: '$19.99',
      currency: 'USD',
      brand: 'SyntheticBenchmark',
      images: [],
      videos: [],
      bulletPoints: ['仅容量测试'],
      createdAt: now,
      updatedAt: now,
      ...(history ? { aiAnalysis: analysis, analysisHistory: history } : {}),
    };
  });
  let previous = 0;
  for (const count of [100, 500, 1000]) {
    const batch = products.slice(previous, count);
    const preview = (await api('/api/library/import', { action: 'preview', data: batch })).data;
    const saved = await api('/api/library/import', {
      action: 'commit',
      data: batch,
      confirmed: true,
      policy: 'skip',
      expectedRevision: preview.revision,
    });
    previous = count;
    const reads = [];
    for (let i = 0; i < 7; i++) reads.push((await api('/api/products')).ms);
    const started = performance.now();
    await page.goto('http://127.0.0.1:3000/products');
    await expect(page.getByText(products[0].title, { exact: true }).first()).toBeVisible();
    const readyMs = performance.now() - started;
    const search = page.getByPlaceholder('搜索标题、ASIN 或品牌');
    const actualSearch = (await search.count())
      ? search
      : page.locator('input[type="search"]').first();
    const searchStarted = performance.now();
    await actualSearch.fill(products[count - 1].sourceId);
    await expect(page.getByText(products[count - 1].title, { exact: true }).first()).toBeVisible();
    const searchMs = performance.now() - searchStarted;
    await actualSearch.fill('');
    report.samples.push({
      products: count,
      importMs: saved.ms,
      listApi: stats(reads),
      readyMs,
      searchMs,
    });
    await rss(`${count} products`);
  }
  const builtin = (await api('/api/templates')).data.templates.find(
    (template) => template.origin === 'builtin',
  );
  const keys = [
    'name',
    'description',
    'scenario',
    'category',
    'tags',
    'favorite',
    'prompt',
    'outputFields',
    'outputRequirements',
  ];
  const definition = Object.fromEntries(keys.map((key) => [key, builtin[key]]));
  const templates = Array.from({ length: 100 }, (_, i) => {
    const snapshot = { ...definition, name: `合成性能模板 ${String(i).padStart(3, '0')}` };
    return {
      ...snapshot,
      id: randomUUID(),
      origin: 'custom',
      createdAt: now,
      updatedAt: now,
      versions: Array.from({ length: 10 }, (_, v) => ({
        id: randomUUID(),
        createdAt: now,
        kind: v === 0 ? 'created' : 'edited',
        snapshot,
      })),
    };
  });
  await importRecords('/api/templates/backup', {
    format: 'productspy-templates',
    schemaVersion: 1,
    exportedAt: now,
    templates,
  });
  let basePlan = (
    await api('/api/content-plans', {
      name: '合成性能方案000',
      productId: products[0].id,
      templateId: templates[0].id,
    })
  ).data;
  basePlan = (
    await api('/api/generate-content', {
      planId: basePlan.id,
      expectedUpdatedAt: basePlan.updatedAt,
      requestId: randomUUID(),
    })
  ).data.plan;
  const seedVersion = basePlan.versions[0];
  const plans = Array.from({ length: 99 }, (_, i) => {
    const versions = Array.from({ length: 10 }, () => ({
      ...seedVersion,
      id: randomUUID(),
      kind: 'edited',
      metadata: { ...seedVersion.metadata, requestId: randomUUID() },
    }));
    return {
      ...basePlan,
      id: randomUUID(),
      name: `合成性能方案${String(i + 1).padStart(3, '0')}`,
      versions,
      currentVersionId: versions.at(-1).id,
    };
  });
  await importRecords('/api/content-plans/backup', {
    format: 'productspy-content',
    schemaVersion: 1,
    exportedAt: now,
    plans,
  });
  for (let i = 0; i < 20; i++)
    await api('/api/comparisons', {
      name: `合成性能对比${i}`,
      productIds: [products[i].id, products[i + 1].id],
    });
  for (const [route, selector, endpoint] of [
    ['/templates', '搜索模板', '/api/templates'],
    ['/content', '搜索内容方案', '/api/content-plans'],
    ['/comparisons', null, '/api/comparisons'],
  ]) {
    const reads = [];
    for (let i = 0; i < 7; i++) reads.push((await api(endpoint)).ms);
    const started = performance.now();
    await page.goto(`http://127.0.0.1:3000${route}`);
    await page.locator('.loading-state').waitFor({ state: 'hidden' });
    if (selector) await expect(page.getByRole('textbox', { name: selector })).toBeVisible();
    report.modules.push({ route, readyMs: performance.now() - started, listApi: stats(reads) });
  }
  const concurrentStarted = performance.now();
  await Promise.all(Array.from({ length: 10 }, () => api('/api/products')));
  report.concurrentReadsMs = performance.now() - concurrentStarted;
  const writeStarted = performance.now();
  const drafts = products
    .slice(0, 5)
    .map((product) =>
      Object.fromEntries(
        [
          'source',
          'sourceId',
          'url',
          'title',
          'price',
          'currency',
          'brand',
          'images',
          'videos',
          'bulletPoints',
        ].map((key) => [key, product[key]]),
      ),
    );
  await Promise.all(
    drafts.map((draft) => api('/api/products', { ...draft, title: `${draft.title} · 更新` })),
  );
  const current = (await api('/api/products')).data;
  assert.equal(current.length, 1000);
  assert(current.filter((product) => product.title.endsWith('· 更新')).length === 5);
  report.concurrentWritesMs = performance.now() - writeStarted;
  report.checks.push(
    '1000 products retained after 5 concurrent atomic writes; 1600 product analysis versions and 1000 template versions retained.',
  );
  for (const endpoint of values.version === '0.8.0'
    ? ['/api/workspace-backup']
    : ['/api/library', '/api/templates/backup', '/api/content-plans/backup']) {
    const result = await api(endpoint);
    report.modules.push({ export: endpoint, ms: result.ms, bytes: result.bytes });
  }
  await rss('all modules and exports');
  const library = JSON.parse(await readFile(join(root, 'data/products.json'), 'utf8'));
  assert.equal(library.products.length, 1000);
  report.disk = await disk(root);
  report.fixtureCounts = {
    products: 1000,
    comparisons: 20,
    customTemplates: 100,
    contentPlans: 100,
    productHistoryVersions: 1600,
    templateHistoryVersions: 1000,
    contentHistoryVersions: 991,
  };
  report.passed = true;
} finally {
  await browser.close();
  await writeFile(
    join(output, `performance-${values.version}.json`),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      version: report.version,
      passed: report.passed,
      samples: report.samples,
      modules: report.modules,
      disk: report.disk,
    }),
  );
}
