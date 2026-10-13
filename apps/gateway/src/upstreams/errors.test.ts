import { describe, expect, it } from 'vitest';
import { UrlNotAllowedError } from '../security/ssrf.ts';
import { classifyUpstreamError, isConnectionLevel } from './errors.ts';

const withCode = (message: string, code: string | number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });
const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });

describe('classifyUpstreamError', () => {
  it('finds the socket error inside the SDK wrapper (pod gone, NetworkPolicy)', () => {
    const err = Object.assign(new Error('Version negotiation probe failed: fetch failed'), {
      code: 'ERA_NEGOTIATION_FAILED',
      cause: fetchFailed(withCode('connect ECONNREFUSED 10.43.1.2:8080', 'ECONNREFUSED')),
    });
    const failure = classifyUpstreamError(err);
    expect(failure).toEqual({ kind: 'connection', reason: 'connection refused' });
    expect(isConnectionLevel(failure)).toBe(true);
  });

  it('recognises DNS failures and errors inside an AggregateError (Happy Eyeballs)', () => {
    expect(classifyUpstreamError(fetchFailed(withCode('getaddrinfo ENOTFOUND x', 'ENOTFOUND'))).reason).toBe('DNS lookup failed');
    const aggregate = new AggregateError([withCode('a', 'ECONNREFUSED'), withCode('b', 'ECONNREFUSED')], 'all failed');
    expect(classifyUpstreamError(fetchFailed(aggregate)).reason).toBe('connection refused');
  });

  it('reports SSRF blocks at connect time', () => {
    const failure = classifyUpstreamError(fetchFailed(new UrlNotAllowedError('rebind.example resolves to a non-public address')));
    expect(failure.kind).toBe('connection');
    expect(failure.reason).toMatch(/SSRF guard: rebind.example resolves to a non-public address/);
  });

  it('reports a rejected credential as auth (401 and 403)', () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { name: 'UnauthorizedError' });
    expect(classifyUpstreamError(unauthorized)).toMatchObject({ kind: 'auth', httpStatus: 401 });
    expect(classifyUpstreamError(withCode('forbidden', 'CLIENT_HTTP_FORBIDDEN', { status: 403 }))).toMatchObject({ kind: 'auth', httpStatus: 403 });
  });

  it('reports timeouts with the limit, and other HTTP statuses', () => {
    expect(classifyUpstreamError(withCode('Request timed out', 'REQUEST_TIMEOUT'), 10_000)).toEqual({ kind: 'timeout', reason: 'timed out after 10s' });
    expect(classifyUpstreamError(withCode('Error POSTing', 'CLIENT_HTTP_NOT_IMPLEMENTED', { status: 404 }))).toMatchObject({ kind: 'http', httpStatus: 404 });
  });

  it('reports JSON-RPC errors with their code', () => {
    expect(classifyUpstreamError(withCode('Tool nope not found', -32602))).toEqual({
      kind: 'rpc',
      reason: 'upstream error -32602: Tool nope not found',
      rpcCode: -32602,
    });
  });

  it('keeps unknown errors short and on one line', () => {
    const failure = classifyUpstreamError(new Error(`weird\n${'x'.repeat(1000)}`));
    expect(failure.kind).toBe('protocol');
    expect(failure.reason.length).toBeLessThanOrEqual(320);
    expect(failure.reason).not.toContain('\n');
  });
});
