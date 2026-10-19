import { describe, expect, it } from 'vitest';
import { authorizedOrigin, cloudConfiguration } from './verify-cloud-browser.mjs';
const env = {
  PRODUCTSPY_CLOUD_VERIFY: '1',
  GITHUB_ACTIONS: 'true',
  RUNNER_OS: 'Linux',
  PRODUCTSPY_CLOUD_ORIGIN: authorizedOrigin,
  PRODUCTSPY_CLOUD_AMAZON: 'fixture',
};
describe('authorized cloud browser verification boundary (no browser/network)', () => {
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
});
