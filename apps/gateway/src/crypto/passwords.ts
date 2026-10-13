// Password hashing with scrypt from node:crypto (no native modules to compile in the image).
//
// Parameters: OWASP's Password Storage Cheat Sheet lists equal-strength scrypt settings that trade memory for CPU.
// We use the N=2^14, r=8, p=5 row: 16 MiB per hash instead of 128 MiB for N=2^17, so a burst of logins cannot
// run a small gateway pod out of memory. The parameters are stored inside each hash, so they can be raised later
// without invalidating existing passwords.
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const DEFAULT_PARAMS = { N: 16_384, r: 8, p: 5 };
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_MEMORY = 64 * 1024 * 1024; // must exceed 128 * N * r = 16 MiB

function scryptAsync(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, { ...options, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$<salt b64>$<hash b64>`; a fresh random salt per password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = DEFAULT_PARAMS;
  const key = await scryptAsync(password, salt, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Recomputes the hash with the stored salt and parameters and compares in constant time. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  try {
    const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false; // corrupt parameters in the stored hash
  }
}

// A hash of a random password, computed once. Logins for unknown emails are checked against it so they take as
// long as real ones: response timing then does not reveal which emails have accounts.
let decoyHash: Promise<string> | undefined;

export async function verifyAgainstDecoy(password: string): Promise<false> {
  decoyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await decoyHash);
  return false;
}
