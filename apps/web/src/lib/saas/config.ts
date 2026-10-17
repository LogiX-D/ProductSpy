import { AppError } from '../server/errors';

export function appOrigin(): string {
  const url = new URL(process.env.PRODUCTSPY_APP_URL ?? 'http://127.0.0.1:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('PRODUCTSPY_APP_URL must be an origin');
  if (
    url.protocol !== 'https:' &&
    !(
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.protocol === 'http:' &&
      (process.env.NODE_ENV !== 'production' ||
        process.env.PRODUCTSPY_ENV === 'test' ||
        process.env.PRODUCTSPY_ENV === 'development')
    )
  )
    throw new AppError(503, '请配置 HTTPS SaaS 地址；HTTP 仅允许本机开发环境');
  return url.origin;
}

export const extensionOriginPattern = /^chrome-extension:\/\/[a-p]{32}$/;
export const sessionCookie = 'productspy_account';
export function accountCookie(token: string, maxAge = 60 * 60 * 24 * 7): string {
  return `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${appOrigin().startsWith('https:') ? '; Secure' : ''}`;
}
