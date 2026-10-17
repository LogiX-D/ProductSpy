import { describe, expect, it } from 'vitest';
import { extensionConfig } from './deployment-config';

describe('extension endpoint boundaries', () => {
  it('defaults to SaaS with an explicit development loopback origin', () => {
    expect(extensionConfig()).toEqual({
      appUrl: 'http://127.0.0.1:3000',
      legacy: false,
      loopback: true,
    });
    expect(extensionConfig('https://app.example.com/', 'legacy').legacy).toBe(true);
    expect(extensionConfig('https://app.example.com:443').appUrl).toBe('https://app.example.com');
  });
  it('refuses loopback for a production deployment while allowing an exact HTTPS origin', () => {
    expect(() => extensionConfig(undefined, 'saas', 'production')).toThrow('non-loopback HTTPS');
    expect(() => extensionConfig('https://localhost:3000', 'saas', 'production')).toThrow();
    expect(extensionConfig('https://app.example.test', 'saas', 'production').appUrl).toBe(
      'https://app.example.test',
    );
  });
  it.each([
    'http://app.example.com',
    'https://*.example.com',
    'https://user:secret@app.example.com',
    'https://app.example.com/path',
    'https://app.example.com/?secret=1',
    'https://app.example.com/#fragment',
    'javascript:alert(1)',
  ])('rejects an unsafe or non-origin endpoint %s', (url) => {
    expect(() => extensionConfig(url)).toThrow();
  });
});
