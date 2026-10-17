export function extensionConfig(
  rawUrl = 'http://127.0.0.1:3000',
  mode = 'saas',
  environment = 'development',
) {
  const url = new URL(rawUrl);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.hostname.includes('*') ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new Error(
      'ProductSpy app URL must be an HTTPS origin (HTTP loopback is development only).',
    );
  if (environment === 'production' && (loopback || url.protocol !== 'https:'))
    throw new Error('Production extension builds require a non-loopback HTTPS app origin.');
  return { appUrl: url.origin, legacy: mode === 'legacy', loopback };
}
