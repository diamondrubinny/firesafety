import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM authenticated encryption for secrets at rest.
 * Layout: 12-byte IV | 16-byte auth tag | ciphertext. The key lives only in the environment.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32) throw new Error('encryption key must be 32 bytes');
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  decrypt(box: Buffer): string {
    const iv = box.subarray(0, 12);
    const tag = box.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(box.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** Deterministic, clearly insecure key used only when NODE_ENV != production and no key is configured. */
export const DEV_ONLY_KEY = Buffer.alloc(32, 7).toString('base64');
