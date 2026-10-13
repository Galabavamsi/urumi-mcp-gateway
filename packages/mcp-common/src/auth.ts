import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Checks an `Authorization: Bearer <token>` header against the expected token.
 * Both sides are hashed first so the comparison is constant-time even when lengths differ.
 */
export function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header || !expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const given = createHash('sha256').update(match[1]).digest();
  const want = createHash('sha256').update(expected).digest();
  return timingSafeEqual(given, want);
}
