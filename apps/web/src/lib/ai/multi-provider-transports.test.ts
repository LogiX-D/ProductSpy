import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aiProviderIds,
  builtinTemplates,
  contentOptionsSchema,
  contentPlanSchema,
  mergeProduct,
  type AIProviderId,
} from '@productspy/shared';
import { AppError } from '../server/errors';
import { mockComparison } from './comparison-mock';
import { mockContent } from './content-generation';
import { MockAIProvider } from './mock-provider';
import { AIProviderError, OpenAICompatibleProvider } from './openai-compatible-provider';
import { AI_PROVIDER_PRESETS, providerPreset } from './provider-presets';

// All completions in this file are local Mock fixtures; no real provider is called.
const product = mergeProduct({
  source: 'amazon',
  sourceId: 'B012345678',
  url: 'https://www.amazon.com/dp/B012345678',
  title: 'Local fixture travel bottle',
  images: ['https://example.invalid/do-not-send.jpg'],
  videos: [],
  bulletPoints: ['Page claims stainless steel'],
});
const key = 'local-stub-secret-not-a-real-key';
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function nativeResponse(input: unknown, name = 'productspy_analysis') {
  return {
    id: 'msg_local_fixture',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_fixture', name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}
function claude(config: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({
    apiKey: key,
    protocol: 'anthropic',
    providerId: 'anthropic',
    model: 'administrator-selected-local-fixture',
    ...config,
  });
}
function responseStub(body: unknown) {
  const fetcher = vi.fn().mockResolvedValue(Response.json(body));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('Provider presets are configuration aids with administrator model whitelists', () => {
  it('covers every advertised provider exactly once without embedding a model catalog', () => {
    expect(AI_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([...aiProviderIds]);
    for (const id of aiProviderIds) {
      const preset = providerPreset(id);
      expect(preset.id).toBe(id);
      expect(preset.protocol).toBe(id === 'anthropic' ? 'anthropic' : 'openai-compatible');
      expect(new URL(preset.documentationUrl).protocol).toBe('https:');
      expect(preset).not.toHaveProperty('models');
      expect(preset).not.toHaveProperty('apiKey');
      if (id === 'custom') expect(preset.baseUrl).toBe('');
      else expect(new URL(preset.baseUrl).protocol).toBe('https:');
    }
    expect(() => providerPreset('unsupported-raw-value' as AIProviderId)).toThrow(AppError);
    expect(() => providerPreset('unsupported-raw-value' as AIProviderId)).not.toThrow(
      'unsupported-raw-value',
    );
  });
  it('returns a copy so one configuration cannot mutate another preset', () => {
    const original = providerPreset('gemini');
    const copy = providerPreset('gemini');
    copy.baseUrl = 'https://example.invalid/changed';
    expect(providerPreset('gemini')).toEqual(original);
  });
  it.each(
    AI_PROVIDER_PRESETS.filter((preset) => preset.id !== 'anthropic' && preset.id !== 'custom'),
  )('sends one compatible request for $id with the exact documented path', async (preset) => {
    const generated = await new MockAIProvider().generate(product);
    const fetcher = responseStub({
      choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: 'stop' }],
    });
    await new OpenAICompatibleProvider({
      apiKey: key,
      providerId: preset.id,
      protocol: preset.protocol,
      baseUrl: preset.baseUrl,
      model: 'administrator-selected-local-fixture',
    }).generate(product);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`${preset.baseUrl}/chat/completions`);
    const init = fetcher.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    });
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    const request = JSON.parse(String(init.body));
    expect(request.model).toBe('administrator-selected-local-fixture');
    expect(request.response_format).toEqual({ type: 'json_object' });
    expect(request.messages.map((message: { role: string }) => message.role)).toEqual([
      'system',
      'user',
    ]);
    if (preset.id === 'openrouter')
      expect(request.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
    else expect(request).not.toHaveProperty('provider');
    expect(String(init.body)).not.toContain(key);
    expect(String(init.body)).not.toContain('do-not-send.jpg');
  });
});

describe('Claude native Messages structured transport (local stub only)', () => {
  it('uses the native endpoint and API key header over real loopback HTTP, without a second tool call', async () => {
    const generated = await new MockAIProvider().generate(product);
    const inspected: {
      path?: string;
      headers?: Record<string, unknown>;
      body?: Record<string, unknown>;
    } = {};
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      let body = '';
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on('end', () => {
        inspected.path = request.url;
        inspected.headers = request.headers;
        inspected.body = JSON.parse(body);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(nativeResponse(generated)));
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local fixture port');
    const result = await claude({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxOutputTokens: 2048,
    }).generate(product);
    expect(requests).toBe(1);
    expect(inspected.path).toBe('/v1/messages');
    expect(inspected.headers?.['x-api-key']).toBe(key);
    expect(inspected.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(inspected.headers?.authorization).toBeUndefined();
    expect(inspected.body?.max_tokens).toBe(2048);
    expect(inspected.body?.system).toContain('没有提供真实评论正文');
    expect(inspected.body?.messages).toEqual([{ role: 'user', content: expect.any(String) }]);
    expect(inspected.body?.tool_choice).toEqual({
      type: 'tool',
      name: 'productspy_analysis',
      disable_parallel_tool_use: true,
    });
    expect(inspected.body?.tools).toEqual([
      expect.objectContaining({
        name: 'productspy_analysis',
        input_schema: expect.objectContaining({
          type: 'object',
          required: ['analysis', 'evidence'],
        }),
      }),
    ]);
    for (const unsupported of ['response_format', 'thinking', 'max_completion_tokens'])
      expect(inspected.body).not.toHaveProperty(unsupported);
    expect(JSON.stringify(inspected.body)).not.toContain(key);
    expect(JSON.stringify(inspected.body)).not.toContain('do-not-send.jpg');
    expect(result.analysis).toEqual(generated.analysis);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 200 });
  });
  it.each(['https://api.anthropic.com/v1', 'https://api.anthropic.com/v1/messages/'])(
    'appends no duplicate Messages suffix to %s',
    async (baseUrl) => {
      const fetcher = responseStub(nativeResponse(await new MockAIProvider().generate(product)));
      await claude({ baseUrl }).generate(product);
      expect(fetcher.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
      const init = fetcher.mock.calls[0][1] as RequestInit;
      expect(init.redirect).toBe('error');
      expect(init.cache).toBe('no-store');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('includes cached input tokens once in reported usage', async () => {
    responseStub({
      ...nativeResponse(await new MockAIProvider().generate(product)),
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
      },
    });
    expect((await claude().generate(product)).usage).toEqual({
      inputTokens: 150,
      outputTokens: 200,
    });
  });
  it('uses the comparison tool schema and existing business validation', async () => {
    const other = mergeProduct({
      source: 'amazon',
      title: 'Second local fixture',
      sourceId: 'B012345679',
      url: 'https://www.amazon.com/dp/B012345679',
      images: [],
      videos: [],
      bulletPoints: [],
    });
    const products = [product, other];
    const generated = mockComparison(products);
    const fetcher = responseStub(nativeResponse(generated, 'productspy_comparison'));
    const result = await claude().compare(products);
    expect(result.analysis).toEqual(generated.analysis);
    expect(
      JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body)).tool_choice.name,
    ).toBe('productspy_comparison');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses the content tool schema and existing business validation', async () => {
    const plan = contentPlanSchema.parse({
      id: '00000000-0000-4000-8000-000000000123',
      name: 'Local transport fixture',
      productId: product.id,
      productSnapshot: product,
      templateSnapshot: builtinTemplates[0],
      options: contentOptionsSchema.parse({}),
      status: 'draft',
      favorite: false,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      versions: [],
    });
    const generated = mockContent(plan);
    const fetcher = responseStub(nativeResponse(generated, 'productspy_content'));
    const result = await claude().createContent(plan);
    expect(result.output).toEqual(generated.output);
    expect(
      JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body)).tool_choice.name,
    ).toBe('productspy_content');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { thinking: 'enabled' as const },
    { thinking: 'disabled' as const },
    { tokenParameter: 'max_completion_tokens' as const },
    { responseFormat: 'text' as const },
    { temperature: 1.1 },
    { model: ' ' },
    { protocol: 'unsupported' as 'anthropic' },
  ])('rejects unsupported protocol configuration before any call: %j', (config) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(() => claude(config)).toThrow(AppError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'max_tokens',
    'model_context_window_exceeded',
    'refusal',
    'end_turn',
    'pause_turn',
    null,
  ])('rejects incomplete or refused stop_reason %s without retry', async (stop_reason) => {
    const fetcher = responseStub({
      ...nativeResponse(await new MockAIProvider().generate(product)),
      stop_reason,
    });
    await expect(claude().generate(product)).rejects.toThrow(AppError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(
    [
      [],
      [{ type: 'tool_use', id: 'toolu_fixture', name: 'wrong-sensitive-tool', input: {} }],
      [{ type: 'tool_use', id: '', name: 'productspy_analysis', input: {} }],
      [
        {
          type: 'tool_use',
          id: 'toolu_fixture',
          name: 'productspy_analysis',
          input: 'raw-sensitive-data',
        },
      ],
      [{ type: 'text', text: 'raw-sensitive-text' }],
      [
        { type: 'tool_use', id: 'toolu_1', name: 'productspy_analysis', input: {} },
        { type: 'tool_use', id: 'toolu_2', name: 'productspy_analysis', input: {} },
      ],
    ].map((content) => ({ content })),
  )('rejects ambiguous, mismatched or non-object structured content: %j', async ({ content }) => {
    const fetcher = responseStub({ ...nativeResponse({}), content });
    const failure = await claude()
      .generate(product)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as Error).message).not.toContain('sensitive');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    {},
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 'sensitive-raw-value' },
    { input_tokens: 1.5, output_tokens: 1 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: -1 },
    { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null },
    { input_tokens: 1_000_000_000, output_tokens: 1, cache_creation_input_tokens: 1 },
  ])('rejects invalid upstream usage without invented token values: %j', async (usage) => {
    const fetcher = responseStub({
      ...nativeResponse(await new MockAIProvider().generate(product)),
      usage,
    });
    await expect(claude().generate(product)).rejects.toThrow('有效用量');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 429, 503])(
    'redacts native HTTP %s and makes only one request',
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response(`sensitive-provider-body ${key}`, {
          status,
          headers: { 'retry-after': '17' },
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      const failure = await claude()
        .generate(product)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expect((failure as Error).message).not.toContain('sensitive-provider-body');
      expect((failure as Error).message).not.toContain(key);
      if (status === 429) {
        expect(failure).toBeInstanceOf(AIProviderError);
        expect((failure as AIProviderError).retryAfterSeconds).toBe(17);
      }
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it('redacts network errors without fallback', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(`sensitive-provider-body ${key}`));
    vi.stubGlobal('fetch', fetcher);
    const failure = await claude()
      .generate(product)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as Error).message).toContain('没有自动重试');
    expect((failure as Error).message).not.toContain(key);
    expect((failure as Error).message).not.toContain('sensitive-provider-body');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('bounds native timeout during a response read and does not repeat the paid POST', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init.signal?.addEventListener('abort', () =>
                controller.error(new DOMException('aborted', 'AbortError')),
              );
            },
          }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    await expect(claude({ timeoutMs: 10 }).generate(product)).rejects.toThrow('平台可能已计费');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'enforces the same 2 MiB bound with declared length: %s',
    async (declared) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response('x'.repeat(2 * 1024 * 1024 + 1), {
          headers: declared ? { 'content-length': String(2 * 1024 * 1024 + 1) } : {},
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      await expect(claude().generate(product)).rejects.toThrow('过大');
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});
