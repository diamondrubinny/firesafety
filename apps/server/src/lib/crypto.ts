import { createHash, createHmac, randomBytes } from 'node:crypto';

/** 256-bit random token, base64url encoded. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Keyed hash so audit rows can be correlated by source without storing raw IPs. */
export function hashIp(ip: string, pepper: string): string {
  return createHmac('sha256', pepper).update(ip, 'utf8').digest('base64url').slice(0, 22);
}
