// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizedOrigin,
  cloudConfiguration,
  readAmazonPageIndicators,
  safeFailure,
} from './verify-cloud-browser.mjs';
const env = {
  PRODUCTSPY_CLOUD_VERIFY: '1',
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Linux',
  PRODUCTSPY_CLOUD_ORIGIN: authorizedOrigin,
  PRODUCTSPY_CLOUD_AMAZON: 'fixture',
};
describe('authorized cloud browser verification boundary (no browser/network)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('requires explicit Linux CI opt-in and exact user-authorized staging origin', () => {
    expect(cloudConfiguration(env, 'linux')).toEqual({ base: authorizedOrigin, amazon: 'fixture' });
    for (const change of [
      { PRODUCTSPY_CLOUD_VERIFY: '' },
      { GITHUB_ACTIONS: 'false' },
      { RUNNER_OS: 'Windows' },
      { PRODUCTSPY_CLOUD_ORIGIN: 'https://example.com' },
      { PRODUCTSPY_CLOUD_ORIGIN: authorizedOrigin + '/' },
      { PRODUCTSPY_CLOUD_ORIGIN: 'http://127.0.0.1:3000' },
    ])
      expect(() => cloudConfiguration({ ...env, ...change }, 'linux')).toThrow();
    expect(() => cloudConfiguration(env, 'win32')).toThrow();
  });
  it('requires fixture/live explicitly and never allows a TLS bypass', () => {
    expect(cloudConfiguration({ ...env, PRODUCTSPY_CLOUD_AMAZON: 'live' }, 'linux').amazon).toBe(
      'live',
    );
    for (const mode of ['', undefined, 'auto'])
      expect(() =>
        cloudConfiguration({ ...env, PRODUCTSPY_CLOUD_AMAZON: mode }, 'linux'),
      ).toThrow();
    expect(() =>
      cloudConfiguration({ ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'linux'),
    ).toThrow('TLS');
  });
  it('reports challenge indicators without exporting page text, form values or URL secrets', () => {
    vi.stubGlobal(
      'location',
      new URL('https://www.amazon.com/errors/validateCaptcha?token=PRIVATE_QUERY'),
    );
    document.body.innerHTML = `<form action="/errors/validateCaptcha?token=PRIVATE_QUERY"><input id="captchacharacters" value="PRIVATE_FORM"></form><p>Enter the characters you see below PRIVATE_TEXT</p>`;
    const evidence = readAmazonPageIndicators();
    expect(evidence.captchaFormPresent).toBe(true);
    expect(evidence.robotPromptPresent).toBe(true);
    expect(evidence.productTitlePresent).toBe(false);
    expect(evidence.urlKind).toBe('captcha');
    expect(JSON.stringify(evidence)).not.toMatch(/PRIVATE|validateCaptcha|localhost/);
    expect(
      Object.values(evidence).every(
        (value) =>
          typeof value === 'boolean' ||
          ['product', 'captcha', 'sign-in', 'other', 'loading', 'interactive', 'complete'].includes(
            value,
          ),
      ),
    ).toBe(true);
  });
  it('separates product, alternate-title and sign-in indicators without inferring capture success', () => {
    vi.stubGlobal(
      'location',
      new URL('https://www.amazon.com/dp/B012345678?session=PRIVATE_QUERY'),
    );
    document.body.innerHTML =
      '<h1 id="productTitle">PRIVATE_PRODUCT</h1><div id="title_feature_div"><h1>PRIVATE_ALT</h1></div>';
    const product = readAmazonPageIndicators();
    expect(product.productTitlePresent).toBe(true);
    expect(product.alternativeTitlePresent).toBe(true);
    expect(product.captchaFormPresent).toBe(false);
    expect(product.signInFormPresent).toBe(false);
    expect(product.urlKind).toBe('product');
    expect(product.expectedHost).toBe(true);
    vi.stubGlobal('location', new URL('https://www.amazon.com/ap/signin?token=PRIVATE_QUERY'));
    document.body.innerHTML =
      '<form name="signIn"><input id="ap_password" type="password" value="PRIVATE_PASSWORD"></form>';
    const signIn = readAmazonPageIndicators();
    expect(signIn.signInFormPresent).toBe(true);
    expect(signIn.productTitlePresent).toBe(false);
    expect(signIn.urlKind).toBe('sign-in');
    expect(JSON.stringify({ product, signIn })).not.toContain('PRIVATE');
  });
  it('retains safe timeout and transport categories without logging exception messages or arbitrary names', () => {
    const timeout = {
      name: 'TimeoutError',
      message: 'PRIVATE_URL_OR_TOKEN',
      code: 'ETIMEDOUT',
      cause: { code: 'ECONNRESET', message: 'PRIVATE_CAUSE' },
    };
    expect(safeFailure(timeout)).toEqual({
      kind: 'TimeoutError',
      code: 'ETIMEDOUT',
      causeCode: 'ECONNRESET',
    });
    expect(JSON.stringify(safeFailure(timeout))).not.toContain('PRIVATE');
    expect(
      safeFailure({
        name: 'PRIVATE_NAME',
        code: 'PRIVATE_TOKEN',
        cause: { code: 'private-string' },
      }),
    ).toEqual({ kind: 'OtherError', code: undefined, causeCode: undefined });
  });
});
