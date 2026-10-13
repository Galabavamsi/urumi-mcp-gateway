// The chat agent runs inside the gateway pod but talks to the gateway like any other MCP client, over the
// loopback-only listener. It proves "I am acting for user X" with a short HS256 JWT:
//   { sub: <userId>, act: 'chat-agent', aud: 'urumi-gateway-internal', iat, exp <= iat + 5 min }
// Short-lived on purpose: a leaked token is useless within minutes, and it is only accepted on 127.0.0.1.
import { SignJWT, jwtVerify } from 'jose';

export const CHAT_TOKEN_AUDIENCE = 'urumi-gateway-internal';
export const CHAT_TOKEN_ACTOR = 'chat-agent';
const LIFETIME_SECONDS = 5 * 60;

export class ChatTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(userId: string): Promise<string> {
    return new SignJWT({ act: CHAT_TOKEN_ACTOR })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setAudience(CHAT_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${LIFETIME_SECONDS}s`)
      .sign(this.key);
  }

  /** Returns the user id, or null for anything invalid, expired, mis-addressed or too long-lived. */
  async verify(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], // never let the token pick its own algorithm
        audience: CHAT_TOKEN_AUDIENCE,
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      if (payload.act !== CHAT_TOKEN_ACTOR) return null;
      if (payload.exp === undefined || payload.iat === undefined || payload.exp - payload.iat > LIFETIME_SECONDS) {
        return null;
      }
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
}
