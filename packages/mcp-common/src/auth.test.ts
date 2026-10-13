import { describe, expect, it } from 'vitest';
import { bearerMatches } from './auth.ts';

describe('bearerMatches', () => {
  it('accepts the exact token', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(bearerMatches('bearer s3cret', 's3cret')).toBe(true);
  });

  it('rejects wrong, missing or malformed credentials', () => {
    expect(bearerMatches('Bearer nope', 's3cret')).toBe(false);
    expect(bearerMatches(undefined, 's3cret')).toBe(false);
    expect(bearerMatches('s3cret', 's3cret')).toBe(false);
    expect(bearerMatches('Basic s3cret', 's3cret')).toBe(false);
    expect(bearerMatches('Bearer s3cret', '')).toBe(false);
  });
});
