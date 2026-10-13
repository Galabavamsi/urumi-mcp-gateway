// Turns whatever the MCP client threw into a short, precise reason for the dashboard, the audit log and the
// isError text a model sees ("supplier: unreachable (connection refused)").
//
// Shapes observed with @modelcontextprotocol/client 2.3.1 (spike, 2026-10-13):
//   refused / DNS:   TypeError('fetch failed') with cause.code ECONNREFUSED / ENOTFOUND (wrapped in an SdkError
//                    ERA_NEGOTIATION_FAILED while connecting)
//   timeout:         SdkError code REQUEST_TIMEOUT (also used when the caller's AbortSignal fires)
//   upstream 401:    UnauthorizedError (bearer via authProvider) or SdkHttpError with status 401/403
//   HTTP errors:     SdkHttpError with .status (e.g. 404 when a legacy session is gone)
//   JSON-RPC error:  ProtocolError with a numeric .code (e.g. -32602 unknown tool)

export type FailureKind = 'connection' | 'timeout' | 'auth' | 'http' | 'rpc' | 'protocol';

export interface UpstreamFailure {
  kind: FailureKind;
  /** Short and safe to show: never contains credentials or request arguments. */
  reason: string;
  /** HTTP status when the upstream answered with one. */
  httpStatus?: number;
  /** JSON-RPC error code when the upstream answered with a JSON-RPC error. */
  rpcCode?: number;
}

const CONNECTION_CODES: Record<string, string> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup failed',
  EAI_NONAME: 'DNS lookup failed',
  ECONNRESET: 'connection reset',
  EPIPE: 'connection reset',
  UND_ERR_SOCKET: 'connection reset',
  UND_ERR_CLOSED: 'connection reset',
  ETIMEDOUT: 'connect timeout',
  UND_ERR_CONNECT_TIMEOUT: 'connect timeout',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
};

type ErrorLike = Error & { code?: unknown; status?: unknown; cause?: unknown; errors?: unknown };

/** The error plus everything in its `cause` chain and inside AggregateErrors (Happy Eyeballs tries several IPs). */
function errorChain(err: unknown, depth = 0): ErrorLike[] {
  if (!(err instanceof Error) || depth > 6) return [];
  const e = err as ErrorLike;
  const nested = Array.isArray(e.errors) ? e.errors.flatMap((inner) => errorChain(inner, depth + 1)) : [];
  return [e, ...errorChain(e.cause, depth + 1), ...nested];
}

/** One line, bounded: upstream error texts can be long or multi-line. */
export function shortMessage(text: string, max = 300): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function classifyUpstreamError(err: unknown, timeoutMs?: number): UpstreamFailure {
  const chain = errorChain(err);

  const blocked = chain.find((e) => e.name === 'UrlNotAllowedError');
  if (blocked) return { kind: 'connection', reason: `blocked by the SSRF guard: ${shortMessage(blocked.message)}` };

  // The size cap in security/ssrf.ts fired. Checked before the connection codes (undici also destroys the socket),
  // and classified as 'protocol', not 'connection': one oversized result is an error for that call only and must
  // not flip the server to unreachable; an oversized tools/list fails the health check like any other bad answer.
  if (chain.some((e) => e.code === 'UND_ERR_RES_EXCEEDED_MAX_SIZE')) {
    return { kind: 'protocol', reason: 'upstream response too large (over 4 MB)' };
  }

  for (const e of chain) {
    const code = typeof e.code === 'string' ? e.code : undefined;
    if (code && CONNECTION_CODES[code]) return { kind: 'connection', reason: CONNECTION_CODES[code] };
    if (code && (code.startsWith('CERT_') || code.startsWith('ERR_TLS') || code.includes('SSL'))) {
      return { kind: 'connection', reason: `TLS error (${code})` };
    }
  }

  if (chain.some((e) => e.name === 'UnauthorizedError')) {
    return { kind: 'auth', reason: "upstream rejected the gateway's credential (HTTP 401)", httpStatus: 401 };
  }

  const first = chain[0];
  if (!first) return { kind: 'protocol', reason: shortMessage(String(err)) };

  if (typeof first.status === 'number') {
    const status = first.status;
    if (status === 401 || status === 403) {
      return { kind: 'auth', reason: `upstream rejected the gateway's credential (HTTP ${status})`, httpStatus: status };
    }
    return { kind: 'http', reason: `upstream answered HTTP ${status}`, httpStatus: status };
  }

  if (first.code === 'REQUEST_TIMEOUT') {
    const seconds = timeoutMs ? ` after ${Math.round(timeoutMs / 100) / 10}s` : '';
    return { kind: 'timeout', reason: `timed out${seconds}` };
  }

  if (typeof first.code === 'number') {
    return { kind: 'rpc', reason: `upstream error ${first.code}: ${shortMessage(first.message)}`, rpcCode: first.code };
  }

  return { kind: 'protocol', reason: `protocol error: ${shortMessage(first.message)}` };
}

/** Errors that mean "we cannot reach the server at all": the server is marked unreachable immediately. */
export function isConnectionLevel(failure: UpstreamFailure): boolean {
  return failure.kind === 'connection' || failure.kind === 'auth';
}
