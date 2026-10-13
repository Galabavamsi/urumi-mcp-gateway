import { describe, expect, it } from 'vitest';
import { UserInputError } from '../errors.ts';
import { toWooPrice } from './products.ts';

describe('toWooPrice', () => {
  it('turns numbers and numeric strings into WooCommerce price strings with 2 decimals', () => {
    expect(toWooPrice(499)).toBe('499.00');
    expect(toWooPrice(199.5)).toBe('199.50');
    expect(toWooPrice(299.99)).toBe('299.99');
    expect(toWooPrice('799')).toBe('799.00');
    expect(toWooPrice(' 799.5 ')).toBe('799.50');
    expect(toWooPrice('0')).toBe('0.00');
    expect(toWooPrice('00499.00')).toBe('499.00');
  });

  it('refuses amounts it would have to guess about', () => {
    for (const bad of ['₹499', '1,299', '499.999', '-5', 'free', '', '4.99e2', Number.NaN, Number.POSITIVE_INFINITY, -1, 0.1 + 0.2]) {
      expect(() => toWooPrice(bad)).toThrow(UserInputError);
    }
  });

  it('explains the expected format', () => {
    expect(() => toWooPrice('₹499')).toThrow(/like 499 or 499.50/);
  });
});
