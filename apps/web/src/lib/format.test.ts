import { describe, expect, it } from 'vitest';
import { formatPrice } from './format';

describe('captured price display', () => {
  it.each([
    [{ price: 'TWD606.36', currency: 'TWD' }, 'TWD606.36'],
    [{ price: '606.36', currency: 'TWD' }, 'TWD 606.36'],
    [{ price: '$99.99' }, '$99.99'],
  ])(
    'displays the captured price without duplicating or guessing currency',
    (product, expected) => {
      expect(formatPrice(product)).toBe(expected);
    },
  );
});
