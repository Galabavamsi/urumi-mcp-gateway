// The one place the dashboard talks HTTP to the gateway. Every request goes through `apiFetch`, which:
//  - sends the session cookie (same origin only; we never call another origin),
//  - adds the CSRF header to every non-GET request (docs/API.md: the gateway rejects them without it),
//  - turns every failure into an `ApiError` with the gateway's `{ error: { code, message } }` shape,
//  - reports 401s so the app can send the user back to the login page.

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got a response (network down, DNS, gateway unreachable). */
  readonly status: number;
  /** Machine-readable code from the gateway (`invalid_credentials`, `slug_taken`, ...). */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export const CSRF_HEADER = 'X-Urumi-CSRF';

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

/** Registered once by the app: what to do when the session is gone (clear state, show the login page). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. */
  body?: unknown;
  signal?: AbortSignal;
  accept?: string;
  /**
   * When false, a 401 is only thrown, not reported to the unauthorized handler. Used where a 401 is an
   * expected answer rather than an expired session: the login form ("wrong password") and the
   * "who am I" probe on page load.
   */
  redirectOn401?: boolean;
}

/** Low-level request: returns the successful Response (status 2xx) or throws ApiError. */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Same-origin is all we ever call, so the cookie is never attached to another site's request.
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    // We cancelled it ourselves (Stop button, page left): pass the abort through untouched.
    if (options.signal?.aborted) throw err;
    throw new ApiError(0, 'network_error', 'Cannot reach the gateway. Check your connection and try again.');
  }

  if (response.ok) return response;

  const error = await readError(response);
  if (response.status === 401 && options.redirectOn401 !== false) onUnauthorized?.();
  throw error;
}

/** JSON request: parses the body, or returns undefined for 204 No Content. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Builds an ApiError from a failed response. The gateway always sends `{ error: { code, message } }`;
 * anything else (an HTML 502 from Traefik while the gateway restarts, an empty body) gets a generic message.
 */
export async function readError(response: Response): Promise<ApiError> {
  const fallback = new ApiError(response.status, `http_${response.status}`, genericMessage(response.status));
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return fallback;
  }
  if (typeof body !== 'object' || body === null || !('error' in body)) return fallback;
  const { error } = body as { error: unknown };
  if (typeof error !== 'object' || error === null) return fallback;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return new ApiError(
    response.status,
    typeof code === 'string' ? code : fallback.code,
    typeof message === 'string' && message.length > 0 ? message : fallback.message,
  );
}

function genericMessage(status: number): string {
  if (status === 401) return 'Your session has ended. Sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'Not found.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return `The gateway could not handle the request (HTTP ${status}). Try again in a moment.`;
  return `Request failed (HTTP ${status}).`;
}

/** Human-readable message for any thrown value, for showing in the UI. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
