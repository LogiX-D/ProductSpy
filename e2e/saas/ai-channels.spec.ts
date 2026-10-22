import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mergeProduct } from '../../packages/shared/src';
import { MockAIProvider } from '../../apps/web/src/lib/ai/mock-provider';

const BASE = 'http://127.0.0.1:3100';
const headers = { Origin: BASE, 'X-ProductSpy-Client': 'web' };
test('administrator configures two channels; actual browser selection reaches one frozen HTTP stub task', async ({
  page,
  browser,
}, info) => {
  const draft = {
    source: 'amazon' as const,
    sourceId: 'B023CHAN01',
    url: 'https://www.amazon.com/dp/B023CHAN01',
    title: 'Synthetic multi-channel product',
    images: [],
    videos: [],
    bulletPoints: ['Synthetic fixture, not a live listing'],
  };
  const generated = await new MockAIProvider().generate(mergeProduct(draft));
  generated.analysis.summary = 'Synthetic local HTTP stub output; no real model was called.';
  const calls: { path: string; model: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      const input = JSON.parse(body);
      calls.push({ path: request.url ?? '', model: input.model });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing stub address');
  const endpoint = 'http://127.0.0.1:' + address.port;
  try {
    await page.goto('/login');
    await page.getByLabel('邮箱', { exact: true }).fill('channel-admin@example.invalid');
    await page.getByLabel('密码', { exact: true }).fill('Synthetic-browser-admin-2026');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(BASE + '/');
    await page.goto('/settings/ai');
    await expect(page.getByRole('heading', { name: 'AI 渠道管理', exact: true })).toBeVisible();
    for (const index of [1, 2]) {
      await page.getByRole('button', { name: '添加渠道', exact: true }).click();
      await page
        .getByLabel('渠道 ' + index + ' 名称', { exact: true })
        .fill('Synthetic channel ' + index);
      await page
        .getByLabel('渠道 ' + index + ' ID', { exact: true })
        .fill('browser-channel-' + index);
      await page
        .getByLabel('渠道 ' + index + ' API 地址', { exact: true })
        .fill(endpoint + '/channel-' + index + '/v1');
      await page
        .getByLabel('渠道 ' + index + ' 模型列表', { exact: true })
        .fill('stub-model-one\nstub-model-two');
      await page.getByLabel('渠道 ' + index + ' 默认模型', { exact: true }).fill('stub-model-one');
      await page
        .getByLabel('渠道 ' + index + ' API Key', { exact: true })
        .fill('synthetic-browser-channel-key-' + index);
      await page
        .getByRole('region', { name: '渠道 ' + index, exact: true })
        .getByLabel('启用渠道', { exact: true })
        .check();
    }
    await page.getByLabel('默认 AI 渠道', { exact: true }).selectOption('browser-channel-1');
    await page.getByRole('button', { name: '保存渠道配置', exact: true }).click();
    await expect(
      page.getByText('渠道配置已保存，密钥输入已清空。此次保存没有调用 AI。', { exact: true }),
    ).toBeVisible();
    expect(calls).toHaveLength(0);
    await expect(page.getByLabel('渠道 1 API Key', { exact: true })).toHaveValue('');
    const publicResponse = await page.request.get('/api/ai/channels');
    const catalog = await publicResponse.text();
    expect(catalog).not.toMatch(/synthetic-browser-channel-key|baseUrl|apiKey|127\.0\.0\.1/);
    const captured = await page.request.post('/api/products', { headers, data: draft });
    expect(captured.ok()).toBe(true);
    await page.goto('/products/amazon:' + draft.sourceId);
    await page.getByRole('tab', { name: 'AI 分析', exact: true }).click();
    await page.getByLabel('AI 渠道', { exact: true }).selectOption('browser-channel-2');
    await page.getByLabel('AI 模型', { exact: true }).selectOption('stub-model-two');
    await page.getByRole('button', { name: '开始 AI 分析', exact: true }).click();
    await page.getByRole('button', { name: '授权本次调用', exact: true }).click();
    await expect(page.getByRole('heading', { name: '商品总结', exact: true })).toBeVisible();
    expect(calls).toEqual([{ path: '/channel-2/v1/chat/completions', model: 'stub-model-two' }]);
    const stored = await page.request.get('/api/products/amazon:' + draft.sourceId);
    const body = await stored.json();
    expect(body.data.analysisMetadata).toMatchObject({
      mode: 'real',
      channelId: 'browser-channel-2',
      channelLabel: 'Synthetic channel 2',
      provider: 'openai',
      model: 'stub-model-two',
    });
    await page.reload();
    expect(calls).toHaveLength(1);
    const ordinary = await browser.newContext();
    try {
      const customer = await ordinary.newPage();
      await customer.goto(BASE + '/register');
      await customer.getByLabel('姓名', { exact: true }).fill('Synthetic ordinary user');
      await customer
        .getByLabel('邮箱', { exact: true })
        .fill('channels-' + randomUUID() + '@example.invalid');
      await customer.getByLabel('密码', { exact: true }).fill('Synthetic-browser-customer-2026');
      await customer.getByRole('button', { name: '注册并进入工作台', exact: true }).click();
      await expect(customer).toHaveURL(BASE + '/');
      await customer.goto(BASE + '/settings/ai');
      await expect(
        customer.getByText(
          '此页面仅供已授权的 SaaS 管理员使用。如需管理权限，请由运维配置管理员账号 UUID。',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(customer.getByRole('button', { name: '保存渠道配置', exact: true })).toHaveCount(
        0,
      );
    } finally {
      await ordinary.close();
    }
    await info.attach('scope', {
      body: Buffer.from(
        'Actual browser + local HTTP/database, two synthetic configured providers, one HTTP stub generation; no real model, provider account, paid usage or physical cross-device acceptance.',
      ),
      contentType: 'text/plain',
    });
  } finally {
    const current = await page.request.get('/api/admin/ai-channels');
    if (current.ok()) {
      const body = await current.json();
      await page.request.put('/api/admin/ai-channels', {
        headers,
        data: { revision: body.data.revision, channels: [], defaultChannelId: 'mock' },
      });
    }
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
