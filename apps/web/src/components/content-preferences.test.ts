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
});
