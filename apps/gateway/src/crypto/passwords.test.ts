import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDecoy, verifyPassword } from './passwords.ts';

describe('scrypt passwords', () => {
  it('stores parameters, salt and hash, and verifies the right password only', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$16384\$8\$5\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
  });

  it('treats Unicode look-alike forms the same (NFKC)', async () => {
    const stored = await hashPassword('ﬁle-password'); // U+FB01 ligature
    expect(await verifyPassword('file-password', stored)).toBe(true);
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'bcrypt$whatever')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$1$2')).toBe(false);
  });

  it('the decoy check always fails', async () => {
    expect(await verifyAgainstDecoy('anything')).toBe(false);
  });
});
