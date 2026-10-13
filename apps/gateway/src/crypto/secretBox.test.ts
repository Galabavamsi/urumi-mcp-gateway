import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox } from './secretBox.ts';

const box = new SecretBox(randomBytes(32));
const SERVER_A = '6b1d3c2e-0000-4000-8000-00000000000a';
const SERVER_B = '6b1d3c2e-0000-4000-8000-00000000000b';

describe('SecretBox (AES-256-GCM)', () => {
  it('round-trips a credential', () => {
    const blob = box.encrypt('fc-secret-key', SERVER_A);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(blob).not.toContain('fc-secret-key');
    expect(box.decrypt(blob, SERVER_A)).toBe('fc-secret-key');
  });

  it('uses a fresh IV every time', () => {
    expect(box.encrypt('same', SERVER_A)).not.toBe(box.encrypt('same', SERVER_A));
  });

  it('refuses a ciphertext moved to another server (AAD = server id)', () => {
    const blob = box.encrypt('fc-secret-key', SERVER_A);
    expect(() => box.decrypt(blob, SERVER_B)).toThrow();
  });

  it('refuses a tampered ciphertext', () => {
    const raw = Buffer.from(box.encrypt('fc-secret-key', SERVER_A).slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0x01;
    expect(() => box.decrypt(`v1:${raw.toString('base64')}`, SERVER_A)).toThrow();
  });

  it('refuses another key, unknown formats and truncated blobs', () => {
    const blob = box.encrypt('fc-secret-key', SERVER_A);
    expect(() => new SecretBox(randomBytes(32)).decrypt(blob, SERVER_A)).toThrow();
    expect(() => box.decrypt('v0:abc', SERVER_A)).toThrow(/unknown credential format/);
    expect(() => box.decrypt('v1:AAAA', SERVER_A)).toThrow(/too short/);
  });

  it('insists on a 32-byte key', () => {
    expect(() => new SecretBox(randomBytes(16))).toThrow();
  });
});
