// MCP API keys: `mgw_<keyId>_<secret>`.
//   keyId  = 12 random base62 characters, stored in clear and indexed, so a key is found without scanning;
//   secret = 32 random bytes (256 bits) in base62.
// The database stores HMAC-SHA256(API_KEY_PEPPER, full key). A fast hash is enough because the secret is random
// and long (nobody can brute-force 256 bits); the pepper means a leaked database alone cannot even confirm a guess.
// The `mgw_` prefix makes leaked keys easy to spot (secret scanners, logs).
import { randomBytes } from 'node:crypto';
import { hexEqual, hmacHex } from './hashing.ts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KEY_ID_LENGTH = 12;
const SECRET_LENGTH = 43; // 62^43 > 2^256, so 43 base62 digits always hold 32 bytes
const KEY_PATTERN = /^mgw_([0-9A-Za-z]{12})_([0-9A-Za-z]{43})$/;

/** Uniform random base62 string. Bytes >= 248 (= 4 * 62) are skipped so `% 62` has no bias. */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

/** Encodes bytes as a fixed-width base62 number (left-padded with '0'). */
function bytesToBase62(bytes: Buffer, width: number): string {
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(width, '0');
}

export interface NewApiKey {
  keyId: string;
  /** The full key. Shown to the user exactly once, never stored. */
  key: string;
}

export function generateApiKey(): NewApiKey {
  const keyId = randomBase62(KEY_ID_LENGTH);
  const secret = bytesToBase62(randomBytes(32), SECRET_LENGTH);
  return { keyId, key: `mgw_${keyId}_${secret}` };
}

/** Extracts the key id from a well-formed key, or null. Never throws on garbage input. */
export function parseApiKey(raw: string): { keyId: string } | null {
  const match = KEY_PATTERN.exec(raw);
  return match?.[1] ? { keyId: match[1] } : null;
}

export function hashApiKey(pepper: string, key: string): string {
  return hmacHex(pepper, key);
}

export function apiKeyMatches(pepper: string, key: string, storedHash: string): boolean {
  return hexEqual(hashApiKey(pepper, key), storedHash);
}

/** What the UI and the audit log show instead of the key: enough to recognise it, useless to an attacker. */
export function apiKeyPrefix(keyId: string): string {
  return `mgw_${keyId}_…`;
}
