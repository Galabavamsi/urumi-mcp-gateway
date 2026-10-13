import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { CHAT_TOKEN_ACTOR, CHAT_TOKEN_AUDIENCE, ChatTokens } from './chatToken.ts';

const SECRET = 'chat-jwt-test-key-0123456789abcdef0123';
const tokens = new ChatTokens(SECRET);
const key = new TextEncoder().encode(SECRET);

function craft(claims: Record<string, unknown>, opts: { aud?: string; sub?: string; ttl?: string; alg?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? 'HS256' })
    .setSubject(opts.sub ?? 'user-1')
    .setAudience(opts.aud ?? CHAT_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.ttl ?? '5m')
    .sign(key);
}

describe('ChatTokens', () => {
  it('round-trips the user id', async () => {
    expect(await tokens.verify(await tokens.sign('user-42'))).toBe('user-42');
  });

  it('rejects a token signed with another key', async () => {
    const other = await new ChatTokens('another-key-0123456789abcdef0123456789').sign('user-42');
    expect(await tokens.verify(other)).toBeNull();
  });

  it('rejects the wrong audience or actor', async () => {
    expect(await tokens.verify(await craft({ act: CHAT_TOKEN_ACTOR }, { aud: 'someone-else' }))).toBeNull();
    expect(await tokens.verify(await craft({ act: 'admin-console' }))).toBeNull();
    expect(await tokens.verify(await craft({}))).toBeNull();
  });

  it('rejects tokens that live longer than 5 minutes, and expired ones', async () => {
    expect(await tokens.verify(await craft({ act: CHAT_TOKEN_ACTOR }, { ttl: '1h' }))).toBeNull();
    expect(await tokens.verify(await craft({ act: CHAT_TOKEN_ACTOR }, { ttl: '-1s' }))).toBeNull();
  });

  it('rejects other algorithms and garbage', async () => {
    expect(await tokens.verify(await craft({ act: CHAT_TOKEN_ACTOR }, { alg: 'HS512' }))).toBeNull();
    expect(await tokens.verify('not.a.jwt')).toBeNull();
    expect(await tokens.verify('')).toBeNull();
  });
});
