// Upstream credentials (Firecrawl key, AgentMail key, internal bearer tokens) are encrypted at rest with
// AES-256-GCM. The key comes from the Secret `gateway-internal/credentials-key`, never from the database, so a
// database dump or backup alone reveals nothing.
//
// Stored format: `v1:` + base64(iv[12] | authTag[16] | ciphertext). The version prefix leaves room for key rotation.
// AAD (additional authenticated data) = the server's id: a ciphertext copied onto another server's row fails to
// decrypt, so nobody with database write access can move the Firecrawl key onto a server they control.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1:';
const IV_BYTES = 12; // the GCM standard nonce size; random per encryption
const TAG_BYTES = 16;

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key');
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return VERSION + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  /** Throws if the blob was tampered with, belongs to another AAD, or was made with another key. */
  decrypt(blob: string, aad: string): string {
    if (!blob.startsWith(VERSION)) throw new Error('unknown credential format');
    const raw = Buffer.from(blob.slice(VERSION.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('credential blob too short');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
  }
}
