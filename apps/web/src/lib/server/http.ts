import type { ApiResult } from '@productspy/shared';
import { AppError } from './errors';

const LOCAL_HOSTS = new Set(['localhost:3000', '127.0.0.1:3000']);
const LOCAL_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);
const MAX_BODY_BYTES = 1024 * 1024;

export function isAllowedOrigin(origin: string): boolean {
  return LOCAL_ORIGINS.has(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

export function assertLocalRequest(request: Request, write = false): void {
  const host = request.headers.get('host') ?? new URL(request.url).host;
  if (!LOCAL_HOSTS.has(host.toLowerCase())) {
    throw new AppError(403, 'ProductSpy API 仅允许本机工作台访问');
  }
  const origin = request.headers.get('origin');
  if (origin && !isAllowedOrigin(origin)) {
    throw new AppError(403, '请求来源不受支持');
  }
  if (write && !origin) throw new AppError(403, '写入请求缺少有效来源');
  if (!write) return;
  if (!['web', 'extension'].includes(request.headers.get('x-productspy-client') ?? '')) {
    throw new AppError(403, '请通过 ProductSpy 工作台或扩展保存商品');
  }
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new AppError(415, '请求需要使用 JSON 格式');
  }
}

export function corsHeaders(request: Request): Headers {
  const headers = new Headers({ Vary: 'Origin', 'Cache-Control': 'no-store' });
  const origin = request.headers.get('origin');
  if (origin && isAllowedOrigin(origin)) headers.set('Access-Control-Allow-Origin', origin);
  return headers;
}

export function jsonSuccess<T>(request: Request, data: T, status = 200): Response {
  const body: ApiResult<T> = { ok: true, data };
  return Response.json(body, { status, headers: corsHeaders(request) });
}

export function jsonFailure(request: Request, error: unknown): Response {
  const known = error instanceof AppError;
  if (!known || error.status >= 500) console.error('[ProductSpy API]', error);
  const body: ApiResult<never> = {
    ok: false,
    error: known ? error.message : '工作台暂时无法完成操作，请重试并检查服务日志',
  };
  return Response.json(body, { status: known ? error.status : 500, headers: corsHeaders(request) });
}

export async function withApiRequest<T>(
  request: Request,
  operation: () => Promise<T> | T,
  options: { write?: boolean; status?: number } = {},
): Promise<Response> {
  try {
    assertLocalRequest(request, options.write);
    return jsonSuccess(request, await operation(), options.status);
  } catch (error) {
    return jsonFailure(request, error);
  }
}

export function preflight(request: Request, methods: readonly string[]): Response {
  try {
    assertLocalRequest(request);
    if (!request.headers.get('origin')) throw new AppError(403, '预检请求缺少有效来源');
    const method = request.headers.get('access-control-request-method')?.toUpperCase();
    if (!method || !methods.includes(method)) throw new AppError(405, '不支持此请求方法');
    const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (
      requestedHeaders.some((header) => !['content-type', 'x-productspy-client'].includes(header))
    ) {
      throw new AppError(403, '不支持此请求头');
    }
    const headers = corsHeaders(request);
    headers.set('Access-Control-Allow-Methods', [...methods, 'OPTIONS'].join(', '));
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-ProductSpy-Client');
    headers.set('Access-Control-Max-Age', '600');
    if (request.headers.get('access-control-request-private-network') === 'true') {
      headers.set('Access-Control-Allow-Private-Network', 'true');
    }
    return new Response(null, { status: 204, headers });
  } catch (error) {
    return jsonFailure(request, error);
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    throw new AppError(413, '商品数据过大，请减少素材数量后重试');
  }
  if (!request.body) throw new AppError(400, '请求缺少商品数据');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new AppError(413, '商品数据过大，请减少素材数量后重试');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AppError(400, '商品数据不是有效的 JSON');
  }
}
