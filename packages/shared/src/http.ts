import type { ApiResult } from './types';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  baseUrl = '',
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (!headers.has('X-ProductSpy-Client')) headers.set('X-ProductSpy-Client', 'web');
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20000),
      headers,
    });
    const body: unknown = await response.json().catch(() => {
      throw new Error('工作台返回了无法识别的数据，请检查 3000 端口是否由 ProductSpy 使用');
    });
    if (!body || typeof body !== 'object' || !('ok' in body))
      throw new Error('工作台返回了无法识别的数据');
    const result = body as ApiResult<T>;
    if (!result.ok) throw new ApiRequestError(result.error, response.status);
    if (!response.ok) throw new ApiRequestError(`请求失败 (${response.status})`, response.status);
    return result.data;
  } catch (error) {
    if (
      error instanceof TypeError ||
      (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name))
    ) {
      throw new Error('无法连接 ProductSpy 工作台，请启动 pnpm dev 并确认 3000 端口可用');
    }
    throw error;
  }
}
