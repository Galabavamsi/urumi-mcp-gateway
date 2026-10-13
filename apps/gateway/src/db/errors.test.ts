import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { errorForLog, pgErrorCode } from './errors.ts';

/** What postgres.js throws for a unique violation (only the fields we read). */
function postgresError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('duplicate key value violates unique constraint "users_email_unique"'), {
    name: 'PostgresError',
    code,
    constraint_name: 'users_email_unique',
    table_name: 'users',
    detail: 'Key (email)=(asha@example.test) already exists.',
    ...extra,
  });
}

const secretParams = ['asha@example.test', 'Asha', 'scrypt$16384$8$5$salt$hash'];

describe('errorForLog', () => {
  it('never contains the bound values of a failed query', () => {
    const err = new DrizzleQueryError('insert into "users" ("email", "name", "password_hash") values ($1, $2, $3)', secretParams, postgresError('23505'));
    expect(String(err)).toContain('asha@example.test'); // why this helper exists
    const fields = errorForLog(err);
    expect(fields).toEqual({ pgCode: '23505', constraint: 'users_email_unique', table: 'users' });
    for (const value of secretParams) expect(JSON.stringify(fields)).not.toContain(value);
  });

  it('keeps the driver message of a query that never reached Postgres', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.43.0.10:5432'), { code: 'ECONNREFUSED' });
    expect(errorForLog(new DrizzleQueryError('select 1', secretParams, refused))).toEqual({ err: 'connect ECONNREFUSED 10.43.0.10:5432' });
  });

  it('passes other errors through as their message', () => {
    expect(errorForLog(new Error('boom'))).toEqual({ err: 'boom' });
    expect(errorForLog('plain')).toEqual({ err: 'plain' });
  });
});

describe('pgErrorCode', () => {
  it('reads the SQLSTATE through the Drizzle wrapper', () => {
    expect(pgErrorCode(new DrizzleQueryError('insert ...', [], postgresError('23505')))).toBe('23505');
    expect(pgErrorCode(postgresError('23503'))).toBe('23503');
    expect(pgErrorCode(new Error('no code'))).toBeUndefined();
  });
});
