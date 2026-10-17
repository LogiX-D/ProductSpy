export function extensionConfig(
  rawUrl = 'http://127.0.0.1:3000',
  mode = 'saas',
  environment = 'development',
) {
  if (!['saas', 'legacy'].includes(mode)) throw new Error('Unknown ProductSpy deployment mode.');
  if (!['development', 'test', 'production'].includes(environment))
    throw new Error('Unknown ProductSpy deployment environment.');
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/\.$/, '');
  const loopback =
    ['localhost', '[::1]'].includes(hostname) ||
    /^127\./.test(hostname) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/i.test(hostname);
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
