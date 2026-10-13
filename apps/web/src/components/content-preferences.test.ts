import { describe, expect, it } from 'vitest';
import { restoreContentPreferences } from './content-preferences';

describe('content browser preferences', () => {
  it('preserves custom duration and valid pricing on the next create form', () => {
    const saved = restoreContentPreferences(
      JSON.stringify({
        version: 1,
        options: { duration: 45, creativeDirection: 'Office demo' },
        pricing: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 8 },
      }),
    );
    expect(saved.options.duration).toBe(45);
    expect(saved.options.creativeDirection).toBe('Office demo');
    expect(saved.pricing).toEqual({ inputUsdPerMillion: 2.5, outputUsdPerMillion: 8 });
  });
  it('drops malformed or unsupported settings and never guesses prices', () => {
    for (const raw of [
      null,
      'invalid',
      '[]',
      JSON.stringify({ version: 2, options: { duration: 60 } }),
      'x'.repeat(20001),
    ])
      expect(restoreContentPreferences(raw).options.duration).toBe(30);
    const saved = restoreContentPreferences(
      JSON.stringify({
        version: 1,
        options: { duration: -1 },
        pricing: { inputUsdPerMillion: 'secret', outputUsdPerMillion: -5 },
      }),
    );
    expect(saved.options.duration).toBe(30);
    expect(saved.pricing).toEqual({});
  });
  it('reuses existing analysis parameters only when content preferences are absent', () => {
    const previous = JSON.stringify({
      version: 1,
      options: {
        market: 'JP',
        language: 'ja',
        platform: 'Shorts',
        duration: 60,
        style: 'casual',
        goal: 'consideration',
        customInstructions: '避免功效承诺',
      },
      pricing: { inputUsdPerMillion: 2 },
    });
    const inherited = restoreContentPreferences(null, previous);
    expect(inherited.options).toMatchObject({
      market: 'JP',
      language: 'ja',
      duration: 60,
      platform: 'Shorts',
      customInstructions: '避免功效承诺',
    });
    expect(inherited.pricing.inputUsdPerMillion).toBe(2);
    const own = restoreContentPreferences(
      JSON.stringify({ version: 1, options: { market: 'US', duration: 45 } }),
      previous,
    );
    expect(own.options.market).toBe('US');
    expect(own.options.duration).toBe(45);
    expect(restoreContentPreferences('invalid', previous).options.duration).toBe(30);
  });
});
