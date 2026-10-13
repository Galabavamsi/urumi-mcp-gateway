// Hono middleware for the dashboard API: CSRF guard, session check, admin check, and the session cookie itself.
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { errorBody } from '../api/errors.ts';
import type { AppEnv } from '../types.ts';
import { SESSION_COOKIE, SESSION_TTL_MS, type SessionStore } from './sessions.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'x-urumi-csrf';

/**
 * Every state-changing /api request must carry `X-Urumi-CSRF: 1`. A page on another site can make the browser send
 * our cookie with a form POST, but it cannot add a custom header without a CORS preflight, and the gateway never
 * answers preflights. So the header proves the request came from our own dashboard. (SameSite=Lax on the
 * cookie is the second layer.)
 */
export const csrfGuard: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== '1') {
    return c.json(errorBody('csrf_required', `missing ${CSRF_HEADER}: 1 header`), 403);
  }
  await next();
};

export function setSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true, // page scripts (and any XSS) cannot read it
    sameSite: 'Lax', // not sent on cross-site POSTs
    secure, // HTTPS-only in production (COOKIE_SECURE)
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'Lax' });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Requires a valid session; puts the user on the context as `user`. 401 otherwise. */
export function requireSession(store: SessionStore, cookieSecure: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = sessionToken(c);
    const session = token ? await store.resolve(token) : null;
    if (!session || !token) {
      if (token) clearSessionCookie(c, cookieSecure);
      return c.json(errorBody('unauthorized', 'please log in'), 401);
    }
    if (session.renewed) setSessionCookie(c, token, cookieSecure); // the browser's copy slides too
    c.set('user', session.user);
    await next();
  };
}

/** Must run after requireSession. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') return c.json(errorBody('forbidden', 'admins only'), 403);
  await next();
};
