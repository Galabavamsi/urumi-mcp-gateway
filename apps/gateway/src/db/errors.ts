// Database errors, made safe to log and easy to test for.
//
// Drizzle wraps every failed query in a DrizzleQueryError whose MESSAGE is "Failed query: <sql>\nparams: <values>":
// every bound value, so emails, names and password hashes would end up in the logs. Postgres's own messages are
// not safe either (e.g. 22P02 "invalid input syntax for type uuid: <the input>"), and `detail` holds row values.
// So for a database error we log only its SQLSTATE code and the constraint/table names.
import { DrizzleQueryError } from 'drizzle-orm';

/** The driver's error inside a Drizzle wrapper (or the error itself). */
function driverError(err: unknown): unknown {
  return err instanceof DrizzleQueryError ? err.cause : err;
}

/** Postgres SQLSTATE of a failed query (e.g. '23505' unique violation), or undefined for anything else. */
export function pgErrorCode(err: unknown): string | undefined {
  const code = (driverError(err) as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Fields to put in a log line for any error, never a bound value:
 *   - a Postgres error: { pgCode, constraint, table }
 *   - a failed query that never reached Postgres (e.g. connection refused): { err: the driver's message }
 *   - anything else: { err: its message }
 */
export function errorForLog(err: unknown): Record<string, unknown> {
  const inner = driverError(err) as { name?: unknown; code?: unknown; constraint_name?: unknown; table_name?: unknown } | undefined;
  if (inner?.name === 'PostgresError') return { pgCode: inner.code, constraint: inner.constraint_name, table: inner.table_name };
  if (err instanceof DrizzleQueryError) return { err: inner instanceof Error ? inner.message : 'database query failed' };
  return { err: err instanceof Error ? err.message : String(err) };
}
