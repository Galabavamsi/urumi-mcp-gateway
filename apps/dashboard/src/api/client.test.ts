import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setUnauthorizedHandler } from './client';

/** Replaces global fetch with a stub that returns `response` and records the call. */
function stubFetch(response: Response | Error) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Captures the rejection so several properties of the error can be checked. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the request to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('api() requests', () => {
  it('GET sends the cookie but no CSRF header, and parses JSON', async () => {
    const fetchMock = stubFetch(json(200, [{ id: 's1' }]));
    await expect(api('/api/servers')).resolves.toEqual([{ id: 's1' }]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/servers');
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.headers).not.toHaveProperty('X-Urumi-CSRF');
  });

  it('non-GET sends the CSRF header and a JSON body', async () => {
    const fetchMock = stubFetch(json(200, { id: 'k1' }));
    await api('/api/keys', { method: 'POST', body: { name: 'laptop' } });

    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ 'X-Urumi-CSRF': '1', 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"name":"laptop"}');
  });

  it('DELETE without a body still sends the CSRF header', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await expect(api('/api/keys/k1', { method: 'DELETE' })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'X-Urumi-CSRF': '1' });
  });
});

describe('api() errors', () => {
  it('uses the gateway error code and message', async () => {
    stubFetch(json(422, { error: { code: 'url_not_allowed', message: 'Only public https URLs are allowed' } }));
    const err = await rejection(api('/api/servers', { method: 'POST', body: {} }));
    expect(err.status).toBe(422);
    expect(err.code).toBe('url_not_allowed');
    expect(err.message).toBe('Only public https URLs are allowed');
  });

  it('falls back to a generic error for a non-JSON body (e.g. a proxy 502 page)', async () => {
    stubFetch(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const err = await rejection(api('/api/servers'));
    expect(err.status).toBe(502);
    expect(err.code).toBe('http_502');
    expect(err.message).toMatch(/HTTP 502/);
  });

  it('falls back when the JSON does not have the error shape', async () => {
    stubFetch(json(400, { message: 'nope' }));
    const err = await rejection(api('/api/servers'));
    expect(err.code).toBe('http_400');
  });

  it('reports a network failure as status 0', async () => {
    stubFetch(new TypeError('fetch failed'));
    const err = await rejection(api('/api/servers'));
    expect(err.status).toBe(0);
    expect(err.code).toBe('network_error');
  });

  it('passes an abort through unchanged', async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(new DOMException('aborted', 'AbortError'));
    await expect(api('/api/chat', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('calls the unauthorized handler on 401', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    stubFetch(json(401, { error: { code: 'unauthenticated', message: 'Sign in' } }));
    const err = await rejection(api('/api/servers'));
    expect(err.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not call the handler when the caller expects a 401 (login form)', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    stubFetch(json(401, { error: { code: 'invalid_credentials', message: 'Wrong email or password' } }));
    const err = await rejection(api('/api/auth/login', { method: 'POST', body: {}, redirectOn401: false }));
    expect(err.code).toBe('invalid_credentials');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not call the handler on 403', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    stubFetch(json(403, { error: { code: 'csrf_required', message: 'Missing CSRF header' } }));
    await rejection(api('/api/servers'));
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
