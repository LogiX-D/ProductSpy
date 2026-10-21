import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { packageSaasExtension } from './package-extension.mjs';
/* global chrome */

export const authorizedOrigin = 'https://203.88.118.240:8443';
// This function is serialized into the test page. Only bounded categories and
// booleans may leave the page; never return its URL, text, form values or HTML.
export function readAmazonPageIndicators() {
  const path = location.pathname;
  const urlKind = /\/errors\/validateCaptcha/i.test(path)
    ? 'captcha'
    : /\/ap\/signin(?:\/|$)/i.test(path)
      ? 'sign-in'
      : /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(path)
        ? 'product'
        : 'other';
  return {
    expectedHost: location.hostname === 'www.amazon.com' || location.hostname === 'amazon.com',
    urlKind,
    readyState: ['loading', 'interactive', 'complete'].includes(document.readyState)
      ? document.readyState
      : 'other',
    productTitlePresent: Boolean(document.querySelector('#productTitle')?.textContent?.trim()),
    alternativeTitlePresent: Boolean(
      document.querySelector('#title_feature_div h1, h1.a-size-large')?.textContent?.trim(),
    ),
    captchaFormPresent: Boolean(
      document.querySelector('form[action*="validateCaptcha" i], #captchacharacters'),
    ),
    robotPromptPresent:
      /make sure you(?:'|’)re not a robot|enter the characters you see below/i.test(
        document.body?.textContent ?? '',
      ),
    signInFormPresent: Boolean(document.querySelector('form[name="signIn"], #ap_password')),
  };
}

export function safeFailure(error) {
  const codes = new Set([
    'ERR_ASSERTION',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ABORT_ERR',
    'ERR_INVALID_URL',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
  ]);
  const safeCode = (value) => (codes.has(value) ? value : undefined);
  const names = new Set(['TimeoutError', 'AssertionError', 'TypeError', 'Error', 'AbortError']);
  return {
    kind: names.has(error?.name) ? error.name : 'OtherError',
    code: safeCode(error?.code),
    causeCode: safeCode(error?.cause?.code),
  };
}

async function amazonPageEvidence(page) {
  return {
    ...(await page.evaluate(readAmazonPageIndicators)),
    htmlSha256: createHash('sha256')
      .update(await page.content())
      .digest('hex'),
  };
}

export function cloudConfiguration(env, platform = process.platform) {
  assert(env.PRODUCTSPY_CLOUD_VERIFY === '1', 'Explicit cloud verification opt-in required.');
  assert(
    env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Linux' && platform === 'linux',
    'Cloud browser acceptance runs on the Linux CI test client.',
  );
  assert(
    env.PRODUCTSPY_CLOUD_ORIGIN === authorizedOrigin,
    'Only the user-authorized staging origin is allowed.',
  );
  assert(
    ['fixture', 'live'].includes(env.PRODUCTSPY_CLOUD_AMAZON),
    'Choose fixture or live explicitly; no fallback.',
  );
  assert(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS verification cannot be disabled.');
  return { base: authorizedOrigin, amazon: env.PRODUCTSPY_CLOUD_AMAZON };
}

async function main() {
  const { base, amazon: mode } = cloudConfiguration(process.env);
  const { chromium, expect } = await import('@playwright/test');
  const runId = randomUUID();
  const output = resolve('.test-data/saas/cloud-browser', `${mode}-${runId}`);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const report = {
    startedAt: new Date().toISOString(),
    outcome: 'RUNNING',
    stage: 'preflight',
    runId,
    target: base,
    amazon:
      mode === 'live'
        ? 'Actual Amazon page; no interception or DOM edits'
        : 'Explicit Amazon HTML fixture; not live Amazon',
    extension: 'Actual MV3, production origin; popup shown as extension tab',
    backend: 'Remote HTTPS SaaS, mandatory browser TLS validation',
    ai: 'Mock only; no authorized paid model call',
    physicalDevice:
      'Linux CI client; second context on same runner, not two physical end-user devices',
    payments: 'Not exercised',
    checks: [],
  };
  const email = `cloud-${mode}-${runId}@example.invalid`;
  const otherEmail = `cloud-other-${mode}-${runId}@example.invalid`;
  const password = `Synthetic-cloud-${randomUUID()}`;
  let context, browser, amazonPage;
  async function register(page, account) {
    await page.goto(`${base}/register`);
    await page.getByLabel('姓名', { exact: true }).fill('Synthetic Cloud Acceptance');
    await page.getByLabel('邮箱', { exact: true }).fill(account);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const accepted = page.waitForResponse(
      (item) => item.url() === `${base}/api/auth/register` && item.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
    const response = await accepted;
    assert(response.ok(), 'Synthetic registration rejected.');
    report.syntheticAccountIds ??= [];
    report.syntheticAccountIds.push((await response.json()).data.user.id);
    await expect(page).toHaveURL(`${base}/`);
  }
  try {
    report.stage = 'remote-status-api';
    const status = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(20_000) });
    report.statusHTTP = status.status;
    assert(
      status.ok && (await status.json()).data?.mode === 'mock',
      'Remote server must explicitly use Mock AI.',
    );
    report.stage = 'production-extension-package';
    const pkg = await packageSaasExtension({ environment: 'production', origin: base });
    const dist = resolve(dirname(pkg.receiptPath), 'extension');
    const manifest = JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8'));
    assert(
      manifest.manifest_version === 3 &&
        JSON.stringify(manifest.host_permissions) === JSON.stringify([`${base}/*`]),
      'Production extension origin mismatch.',
    );
    report.extensionArchiveSha256 = pkg.receipt.archive.sha256;
    report.stage = 'launch-chromium';
    context = await chromium.launchPersistentContext(resolve(output, 'profile'), {
      channel: 'chromium',
      headless: true,
      viewport: { width: 1360, height: 950 },
      args: [
        '--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
      ],
    });
    context.setDefaultTimeout(30_000);
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 45_000 }));
    const extensionId = new URL(worker.url()).hostname;
    const web = context.pages()[0];
    report.stage = 'registration';
    await register(web, email);
    report.checks.push('remote-web-registration');
    const asin = mode === 'live' ? 'B09B8V1LZ3' : 'B012345678';
    if (mode === 'fixture') {
      const html = await readFile(
        resolve('apps/extension/tests/fixtures/jsonld-product.html'),
        'utf8',
      );
      await context.route('https://www.amazon.com/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: html }),
      );
      await context.route('https://m.media-amazon.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="gray"/></svg>',
        }),
      );
      await context.route('https://media.example.com/**', (route) => route.abort());
    }
    report.stage = `${mode}-amazon`;
    const amazon = await context.newPage();
    amazonPage = amazon;
    const response = await amazon.goto(`https://www.amazon.com/dp/${asin}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    report.amazonHTTP = response?.status();
    assert.equal(report.amazonHTTP, 200, 'Amazon did not return 200.');
    await amazon.locator('#productTitle').waitFor({ timeout: 15_000 });
    const title = (await amazon.locator('#productTitle').innerText()).replace(/\s+/g, ' ').trim();
    assert(title.length > 0, 'Product title missing.');
    report.htmlSha256 = createHash('sha256')
      .update(await amazon.content())
      .digest('hex');
    const cdp = await context.browser().newBrowserCDPSession();
    const targets = await cdp.send('Target.getTargets', {
      filter: [{ type: 'tab', exclude: false }],
    });
    const target = targets.targetInfos.find((item) => item.url === amazon.url());
    assert(target, 'Amazon tab missing.');
    await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
    await cdp.detach();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await amazon.bringToFront();
    await popup.reload();
    await popup.getByRole('button', { name: '同意并开始采集', exact: true }).click();
    await expect(popup.getByRole('heading', { name: title, exact: true })).toBeVisible();
    report.checks.push(`${mode}-amazon-actual-mv3-capture`);
    report.stage = 'extension-login-upload';
    await popup.locator('.connection-panel > summary').click();
    await expect(popup.getByText(`当前账号：${email}`, { exact: true })).toBeVisible();
    await expect(popup.getByLabel('一次性登录授权码', { exact: true })).toHaveCount(0);
    report.checks.push('automatic-browser-account-connection-without-code');
    assert.deepEqual(
      await worker.evaluate(async () => {
        const key = 'productspy.cloud-session.v1';
        return {
          memory: Boolean((await chrome.storage.session.get(key))[key]),
          disk: Boolean((await chrome.storage.local.get(key))[key]),
        };
      }),
      { memory: true, disk: false },
      'Extension credential must use trusted session memory.',
    );
    report.checks.push('credential-in-session-memory-not-local-storage');
    await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
    await expect(popup.getByRole('status').filter({ hasText: '已保存到素材库' })).toBeVisible();
    const listed = await web.request.get(`${base}/api/products`);
    assert(listed.ok(), 'Cloud product list failed.');
    const products = (await listed.json()).data;
    assert.equal(products.length, 1, 'Expected one uploaded product.');
    const product = products[0];
    assert.equal(product.sourceId, asin);
    assert.equal(product.title, title);
    report.product = {
      id: product.id,
      asin,
      title,
      images: product.images.length,
      videos: product.videos.length,
      bulletPoints: product.bulletPoints.length,
      priceCaptured: product.price !== undefined,
    };
    report.checks.push(
      'extension-paired',
      'actual-extension-https-upload',
      'cloud-product-library',
    );
    report.stage = 'remote-mock-analysis';
    const productURL = `${base}/products/${encodeURIComponent(product.id)}`;
    await web.goto(productURL);
    await web.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    let jobPosts = 0;
    web.on('request', (req) => {
      if (req.method() === 'POST' && req.url() === `${base}/api/jobs`) jobPosts++;
    });
    const queued = web.waitForResponse(
      (item) => item.url() === `${base}/api/jobs` && item.request().method() === 'POST',
    );
    await web.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    const accepted = await queued;
    assert(accepted.ok(), 'Cloud task rejected.');
    await expect(web.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible({
      timeout: 90_000,
    });
    await expect(web.getByText('Mock 演示', { exact: true }).first()).toBeVisible();
    assert.equal(jobPosts, 1, 'AI POST repeated.');
    const saved = await web.request.get(`${base}/api/products/${encodeURIComponent(product.id)}`);
    const analysis = (await saved.json()).data;
    assert(
      saved.ok() && analysis.aiAnalysis && analysis.analysisMetadata?.mode === 'mock',
      'Mock result not saved.',
    );
    report.analysisSha256 = createHash('sha256')
      .update(JSON.stringify(analysis.aiAnalysis))
      .digest('hex');
    report.checks.push('single-ai-post', 'cloud-worker-mock-analysis-saved');
    await web.screenshot({ path: resolve(output, 'saved-mock-analysis.png') });
    report.stage = 'independent-browser-session';
    browser = await chromium.launch({ headless: true });
    const second = await browser.newContext();
    const another = await second.newPage();
    await another.goto(`${base}/login`);
    await another.getByLabel('邮箱', { exact: true }).fill(email);
    await another.getByLabel('密码', { exact: true }).fill(password);
    await another.getByRole('button', { name: '登录', exact: true }).click();
    await expect(another).toHaveURL(`${base}/`);
    await another.goto(productURL);
    await another.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await expect(another.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    const strangerContext = await browser.newContext();
    const stranger = await strangerContext.newPage();
    await register(stranger, otherEmail);
    const denied = await stranger.request.get(
      `${base}/api/products/${encodeURIComponent(product.id)}`,
      { headers: { 'X-ProductSpy-Client': 'web' } },
    );
    assert.equal(denied.status(), 404, 'Cross-user product access.');
    report.checks.push('independent-session-cloud-readback', 'other-account-404');
    if (mode === 'fixture') {
      report.stage = 'fixture-offline-recovery';
      await amazon.evaluate(() => {
        document.querySelector('#productTitle').textContent = 'Cloud Offline Fixture Grinder';
      });
      await amazon.bringToFront();
      await popup.reload();
      await expect(
        popup.getByRole('heading', { name: 'Cloud Offline Fixture Grinder', exact: true }),
      ).toBeVisible();
      await context.setOffline(true);
      await popup.getByRole('button', { name: '保存到素材库', exact: true }).click();
      await expect(
        popup.getByRole('status').filter({ hasText: '商品已暂存在插件队列中' }),
      ).toBeVisible();
      const queueKey = await worker.evaluate(async () => {
        const key = 'productspy.cloud-session.v1';
        const value = (await chrome.storage.session.get(key))[key];
        const queueKey = `productspy.cloud-queue.v1.user.${encodeURIComponent(value.user.id)}`;
        const queue = (await chrome.storage.local.get(queueKey))[queueKey];
        if (Object.keys(queue.pending).length !== 1)
          throw new Error('Offline outbox was not preserved.');
        return queueKey;
      });
      await context.setOffline(false);
      await popup.locator('.connection-panel > summary').click();
      await popup.getByRole('button', { name: '刷新连接', exact: true }).click();
      await expect
        .poll(() =>
          worker.evaluate(async (queueKey) => {
            const queue = (await chrome.storage.local.get(queueKey))[queueKey];
            return Object.keys(queue.pending).length;
          }, queueKey),
        )
        .toBe(0);
      await another.goto(`${base}/products`);
      await expect(
        another.getByRole('link', { name: 'Cloud Offline Fixture Grinder', exact: true }),
      ).toBeVisible();
      report.checks.push('actual-browser-offline-queue-https-recovery');
    }
    report.stage = 'complete';
    report.outcome = 'PASS';
  } catch (error) {
    report.failure = safeFailure(error);
    if (amazonPage)
      report.amazonPage = await amazonPageEvidence(amazonPage).catch(() => ({
        observation: 'unavailable',
      }));
    report.outcome = 'FAILED_OR_BLOCKED';
    report.reason =
      'Verification did not pass at the recorded stage; no fixture fallback or automatic AI resubmission.';
    process.exitCode = 1;
  } finally {
    await context?.setOffline(false).catch(() => {});
    await browser?.close();
    await context?.close();
    report.finishedAt = new Date().toISOString();
    report.cleanup =
      'Run-owned synthetic accounts retained for server verification; no server data deleted. Browser profile and screenshots stay on ephemeral runner and are not uploaded.';
    await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(report, null, 2));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  void main().catch(() => {
    console.error('Cloud acceptance preflight failed; no secret values are printed.');
    process.exitCode = 1;
  });
