// One error shape for the whole REST API (docs/API.md): HTTP status + { error: { code, message } }.
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { log } from '@urumi/mcp-common';
import { errorForLog } from '../db/errors.ts';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new ApiError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'you are not allowed to do this') => new ApiError(403, 'forbidden', message);

export function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/**
 * Hono onError handler: known errors keep their status, anything else is a logged 500 without details. The log line
 * never carries a failed query's bound values (db/errors.ts).
 */
export function handleApiError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(errorBody(err.code, err.message), err.status);
  if (err instanceof HTTPException) return c.json(errorBody('http_error', err.message || 'request rejected'), err.status);
  log('error', 'unhandled API error', { path: c.req.path, method: c.req.method, ...errorForLog(err) });
  return c.json(errorBody('internal_error', 'something went wrong'), 500);
}

/**
 * Reads and validates a JSON body. Messages name the offending fields, never their values (a password that
 * fails validation must not be echoed back or logged).
 */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'request body must be JSON');
  }
  return validate(schema, body);
}

export function validate<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
    throw new ApiError(400, 'invalid_request', fields.join('; '));
  }
  return parsed.data;
}

/** Path ids are UUIDs; anything else cannot exist, and must not reach Postgres as a malformed uuid. */
export function uuidParam(c: Context, name = 'id'): string {
  const value = c.req.param(name);
  if (!value || !z.uuid().safeParse(value).success) throw notFound();
  return value;
}
