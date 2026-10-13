import { describe, expect, it } from 'vitest';
import { keyRejection } from '../auth/mcpAuth.ts';
import { KEY_ID_LENGTH, apiKeyMatches, apiKeyPrefix, generateApiKey, hashApiKey, parseApiKey, randomBase62 } from './apiKeys.ts';

const PEPPER = 'test-pepper-0123456789abcdef0123456789';

describe('API key format', () => {
  it('generates mgw_<12 base62>_<43 base62> keys whose id parses back', () => {
    for (let i = 0; i < 50; i++) {
      const { keyId, key } = generateApiKey();
      expect(key).toMatch(/^mgw_[0-9A-Za-z]{12}_[0-9A-Za-z]{43}$/);
      expect(keyId).toHaveLength(KEY_ID_LENGTH);
      expect(parseApiKey(key)).toEqual({ keyId });
    }
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'mgw_', 'mgw_short_x', `gw_${'a'.repeat(12)}_${'b'.repeat(43)}`, `mgw_${'a'.repeat(12)}_${'b'.repeat(42)}`, `mgw_${'a'.repeat(11)}-_${'b'.repeat(43)}`]) {
      expect(parseApiKey(bad)).toBeNull();
    }
  });

  it('shows only the key id in the prefix', () => {
    expect(apiKeyPrefix('AbCdEf012345')).toBe('mgw_AbCdEf012345_…');
  });

  it('randomBase62 uses only base62 characters', () => {
    expect(randomBase62(500)).toMatch(/^[0-9A-Za-z]{500}$/);
  });
});

describe('API key verification', () => {
  const { key } = generateApiKey();
  const stored = hashApiKey(PEPPER, key);

  it('stores an HMAC, not the key', () => {
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(key);
  });

  it('matches only the exact key under the same pepper', () => {
    expect(apiKeyMatches(PEPPER, key, stored)).toBe(true);
    expect(apiKeyMatches(PEPPER, `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`, stored)).toBe(false);
    expect(apiKeyMatches('another-pepper-0123456789abcdef01234', key, stored)).toBe(false);
    expect(apiKeyMatches(PEPPER, key, 'not-hex')).toBe(false);
  });

  it('refuses revoked keys and keys of disabled users, but only after the secret matched', () => {
    const row = (revokedAt: Date | null, status: 'active' | 'disabled') => ({ key: { keyHash: stored, revokedAt }, user: { status } });
    expect(keyRejection(PEPPER, key, row(null, 'active'))).toBeNull();
    expect(keyRejection(PEPPER, key, row(new Date(), 'active'))).toBe('revoked');
    expect(keyRejection(PEPPER, key, row(null, 'disabled'))).toBe('user_disabled');
    expect(keyRejection(PEPPER, generateApiKey().key, row(new Date(), 'active'))).toBe('wrong_secret');
    expect(keyRejection(PEPPER, key, undefined)).toBe('unknown_key');
  });
});
