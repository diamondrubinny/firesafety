import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM authenticated encryption for secrets at rest.
 * Layout: 12-byte IV | 16-byte auth tag | ciphertext. Keys live only in the environment.
 *
 * Keyring: new data is always encrypted with the primary key; decryption also accepts previous keys,
 * so the key can be rotated without downtime (see cli/rotate-key.ts).
 */
export class SecretBox {
  private readonly key: Buffer;
  private readonly previous: Buffer[];

  constructor(keyBase64: string, previousBase64: string[] = []) {
    this.key = parseKey(keyBase64);
    this.previous = previousBase64.map(parseKey);
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  decrypt(box: Buffer): string {
    return this.decryptWithInfo(box).plaintext;
  }

  /** Throws if no key in the ring authenticates the ciphertext. */
  decryptWithInfo(box: Buffer): { plaintext: string; primary: boolean } {
    for (const [i, key] of [this.key, ...this.previous].entries()) {
      const plaintext = tryDecrypt(key, box);
      if (plaintext !== null) return { plaintext, primary: i === 0 };
    }
    throw new Error('decryption failed: no matching key');
  }
}

function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
  return key;
}

function tryDecrypt(key: Buffer, box: Buffer): string | null {
  if (box.length < 28) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
    decipher.setAuthTag(box.subarray(12, 28));
    return Buffer.concat([decipher.update(box.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Deterministic, clearly insecure key used only when NODE_ENV != production and no key is configured. */
export const DEV_ONLY_KEY = Buffer.alloc(32, 7).toString('base64');

export function createSecretBox(config: { SETTINGS_ENCRYPTION_KEY?: string; SETTINGS_ENCRYPTION_KEY_PREVIOUS?: string }): SecretBox {
  const previous = (config.SETTINGS_ENCRYPTION_KEY_PREVIOUS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  return new SecretBox(config.SETTINGS_ENCRYPTION_KEY ?? DEV_ONLY_KEY, previous);
}
