import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, otpauthUri, totpStep, verifyTotp } from '../src/lib/totp.js';
import { dummyPasswordHash, generatePassword, hashPassword, verifyPassword } from '../src/lib/password.js';

// RFC 6238 Appendix B (SHA-1 seed "12345678901234567890"), 8-digit values; we use the last 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    const secret = base32Decode(RFC_SECRET);
    for (const [t, expected] of RFC_VECTORS) {
      expect(hotp(secret, totpStep(t * 1000), 8)).toBe(expected);
      expect(verifyTotp(RFC_SECRET, expected.slice(-6), t * 1000, 0)).toBe(totpStep(t * 1000));
    }
  });

  it('RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('base32 round-trips', () => {
    for (const len of [0, 1, 5, 10, 20, 33]) {
      const b = Buffer.from(Array.from({ length: len }, (_, i) => (i * 37) & 255));
      expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    }
    expect(() => base32Decode('ABC1')).toThrow();
  });

  it('accepts +-1 step for clock drift, rejects beyond', () => {
    const t = 1_800_000_000_000;
    const code = hotp(base32Decode(RFC_SECRET), totpStep(t));
    expect(verifyTotp(RFC_SECRET, code, t + 30_000, 0)).toBe(totpStep(t));
    expect(verifyTotp(RFC_SECRET, code, t - 30_000, 0)).toBe(totpStep(t));
    expect(verifyTotp(RFC_SECRET, code, t + 61_000, 0)).toBeNull();
  });

  it('rejects replay of an already used step and malformed codes', () => {
    const t = 1_800_000_000_000;
    const step = totpStep(t);
    const code = hotp(base32Decode(RFC_SECRET), step);
    expect(verifyTotp(RFC_SECRET, code, t, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, code, t, step - 1)).toBe(step);
    for (const bad of ['', '12345', '1234567', 'abcdef', ' 12345']) expect(verifyTotp(RFC_SECRET, bad, t, 0)).toBeNull();
  });

  it('builds an otpauth URI without leaking anything but the label/issuer', () => {
    const uri = otpauthUri('FireSafety', 'bg-ops', 'JBSWY3DPEHPK3PXP');
    expect(uri).toBe('otpauth://totp/FireSafety%3Abg-ops?secret=JBSWY3DPEHPK3PXP&issuer=FireSafety&algorithm=SHA1&digits=6&period=30');
  });
});

describe('password hashing (scrypt)', () => {
  it('verifies correct, rejects wrong, uses unique salts', async () => {
    const h1 = await hashPassword('correct horse battery staple');
    const h2 = await hashPassword('correct horse battery staple');
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery staple', h1)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', h1)).toBe(false);
  });

  it('rejects malformed or tampered hashes without throwing', async () => {
    const h = await hashPassword('x');
    expect(await verifyPassword('x', 'plain')).toBe(false);
    expect(await verifyPassword('x', h.replace('$32768$', '$1073741824$'))).toBe(false); // memory bomb refused
    expect(await verifyPassword('x', h.replace(/\$[^$]+$/, '$AAAA'))).toBe(false);
  });

  it('dummy hash exists for timing equalisation', async () => {
    expect(await verifyPassword('anything', await dummyPasswordHash())).toBe(false);
  });

  it('generated passwords are long and free of look-alike characters', () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(24);
    expect(pw).not.toMatch(/[0O1lI]/);
    expect(new Set(Array.from({ length: 50 }, () => generatePassword())).size).toBe(50);
  });
});
