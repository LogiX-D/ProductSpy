import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Actual public media retrieval through the packaged authenticated API. No native-picker claim.
const base = 'http://127.0.0.1:3000';
const ownData = resolve('.test-data/phase17-screenshots/user/data/products.json');
const library = JSON.parse(await readFile(ownData, 'utf8'));
const product = library.products.find((item) => item.sourceId === 'B006JH8T3S');
assert(product, 'Run only against the caller-owned screenshot fixture service.');
const headers = {
  Origin: base,
  'Content-Type': 'application/json',
  'X-ProductSpy-Client': 'web',
  'Sec-Fetch-Site': 'same-origin',
};
const status = (await (await fetch(`${base}/api/status`)).json()).data;
assert(status.version === '0.6.0' && status.mode === 'mock');
const session = await fetch(`${base}/api/session`, { method: 'POST', headers, body: '{}' });
assert(session.ok);
const cookie = session.headers.get('set-cookie')?.split(';')[0];
assert(cookie);
const authenticated = { ...headers, Cookie: cookie };
const current = (
  await (
    await fetch(`${base}/api/products/${encodeURIComponent(product.id)}`, {
      headers: authenticated,
    })
  ).json()
).data;
assert.deepEqual(current, product, 'The running service must match the isolated product fixture.');
const output = resolve('.test-data/phase17-real-media');
await mkdir(output, { recursive: true });
const report = {
  phase: 17,
  version: status.version,
  capturedAt: new Date().toISOString(),
  realPublicResources: true,
  noProtectionBypass: true,
  nativePickerAcceptance: false,
  aiCalls: 0,
  rows: [],
};
for (const [kind, url] of [
  ['image', product.mainImage],
  ['video', product.videos[0]?.url],
]) {
  if (!url) {
    report.rows.push({ kind, status: 'not-available' });
    continue;
  }
  const response = await fetch(`${base}/api/media?kind=${kind}&url=${encodeURIComponent(url)}`, {
    headers: authenticated,
    signal: AbortSignal.timeout(70000),
  });
  const row = {
    kind,
    asin: product.sourceId,
    publicHost: new URL(url).hostname,
    httpStatus: response.status,
    contentType: response.headers.get('content-type'),
  };
  if (!response.ok) {
    row.status = 'failed';
    row.error = (await response.json()).error;
  } else {
    const bytes = Buffer.from(await response.arrayBuffer());
    assert(bytes.length <= (kind === 'image' ? 10 : 64) * 1024 * 1024);
    row.bytes = bytes.length;
    row.sha256 = createHash('sha256').update(bytes).digest('hex');
    row.status = 'downloaded';
    await writeFile(resolve(output, `${product.sourceId}-${kind}.bin`), bytes, { flag: 'wx' });
  }
  report.rows.push(row);
}
await writeFile(
  resolve('docs/phase17/public-media-results.json'),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
