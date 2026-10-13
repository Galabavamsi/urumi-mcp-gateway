import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, SessionUser } from '../types.ts';
import { csrfGuard, requireAdmin, requireSession } from './middleware.ts';
import { SESSION_COOKIE, type ResolvedSession, type SessionStore } from './sessions.ts';

const alice: SessionUser = { id: 'u-alice', email: 'alice@example.com', name: 'Alice', role: 'admin' };
const bob: SessionUser = { id: 'u-bob', email: 'bob@example.com', name: 'Bob', role: 'member' };

/** In-memory SessionStore: token -> session. */
function fakeStore(sessions: Record<string, ResolvedSession>): SessionStore {
  return {
    create: async () => ({ token: 'new', expiresAt: new Date() }),
    resolve: async (token) => sessions[token] ?? null,
    destroy: async () => {},
    destroyAllForUser: async () => {},
  };
}

function app(store: SessionStore) {
  const a = new Hono<AppEnv>();
  a.use('*', csrfGuard);
  a.get('/me', requireSession(store, true), (c) => c.json(c.get('user')));
  a.post('/thing', requireSession(store, true), (c) => c.json({ ok: true }));
  a.post('/admin-only', requireSession(store, true), requireAdmin, (c) => c.json({ ok: true }));
  a.post('/public', (c) => c.json({ ok: true }));
  return a;
}

const store = fakeStore({
  'tok-alice': { user: alice, expiresAt: new Date(Date.now() + 3600_000), renewed: false },
  'tok-bob': { user: bob, expiresAt: new Date(Date.now() + 3600_000), renewed: true },
});
const cookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
const csrf = { 'x-urumi-csrf': '1' };

describe('csrfGuard', () => {
  it('refuses state-changing requests without X-Urumi-CSRF: 1', async () => {
    for (const headers of [{}, { 'x-urumi-csrf': '0' }, { 'x-urumi-csrf': 'true' }]) {
      const res = await app(store).request('/public', { method: 'POST', headers });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: { code: 'csrf_required', message: expect.any(String) } });
    }
  });

  it('lets them through with the header, and never blocks GET', async () => {
    expect((await app(store).request('/public', { method: 'POST', headers: csrf })).status).toBe(200);
    expect((await app(store).request('/me', { headers: cookie('tok-alice') })).status).toBe(200);
  });

  it('runs before the session check (a cross-site POST learns nothing about the session)', async () => {
    const res = await app(store).request('/thing', { method: 'POST', headers: cookie('tok-alice') });
    expect(res.status).toBe(403);
  });
});

describe('requireSession', () => {
  it('puts the session user on the context', async () => {
    const res = await app(store).request('/me', { headers: cookie('tok-alice') });
    expect(await res.json()).toEqual(alice);
  });

  it('answers 401 without a cookie or with an unknown one, and clears a bad cookie', async () => {
    const missing = await app(store).request('/me');
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: { code: 'unauthorized', message: 'please log in' } });

    const unknown = await app(store).request('/me', { headers: cookie('tok-nobody') });
    expect(unknown.status).toBe(401);
    expect(unknown.headers.get('set-cookie')).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
  });

  it('re-sends a sliding session cookie with HttpOnly, SameSite=Lax and Secure', async () => {
    const res = await app(store).request('/me', { headers: cookie('tok-bob') });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=tok-bob`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Max-Age=43200');
  });

  it('does not re-send the cookie when the session was not renewed', async () => {
    const res = await app(store).request('/me', { headers: cookie('tok-alice') });
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});

describe('requireAdmin', () => {
  it('lets admins through and gives members 403', async () => {
    const asAdmin = await app(store).request('/admin-only', { method: 'POST', headers: { ...cookie('tok-alice'), ...csrf } });
    expect(asAdmin.status).toBe(200);
    const asMember = await app(store).request('/admin-only', { method: 'POST', headers: { ...cookie('tok-bob'), ...csrf } });
    expect(asMember.status).toBe(403);
  });
});
