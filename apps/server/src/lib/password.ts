import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt cost: N=2^15, r=8, p=1 (~32 MiB, tens of ms per hash). Parameters are stored with each hash.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, len, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Refuse absurd parameters from a tampered row (memory exhaustion).
  if (!(n >= 16384 && n <= 1 << 20 && r >= 1 && r <= 16 && p >= 1 && p <= 4)) return false;
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  if (expected.length < 16) return false;
  const key = await derive(password, salt, n, r, p, expected.length);
  return timingSafeEqual(key, expected);
}

/** A hash of a random password: verifying against it costs the same as a real account (no user enumeration by timing). */
let dummy: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

// No look-alike characters (0/O, 1/l/I) so a printed copy can be typed reliably.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 24 characters from a 57-symbol alphabet: ~140 bits of entropy. */
export function generatePassword(length = 24): string {
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}
