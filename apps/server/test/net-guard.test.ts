import { describe, expect, it } from 'vitest';
import { assertPublicHost, isPublicAddress } from '../src/lib/net-guard.js';
import { sendSms } from '../src/services/providers/sms.js';
import { sendEmail, smtpError } from '../src/services/providers/email.js';
import { DEFAULT_NOTIFICATION_SETTINGS } from '@firesafety/shared';

describe('net guard', () => {
  it.each([
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['10.1.2.3', false],
    ['172.20.0.1', false],
    ['192.168.1.1', false],
    ['127.0.0.1', false],
    ['169.254.169.254', false],
    ['100.64.0.1', false],
    ['::1', false],
    ['fd00::1', false],
    ['::ffff:10.0.0.1', false],
    ['2606:4700:4700::1111', true],
    ['not-an-ip', false],
  ])('%s public=%s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it('rejects hosts resolving to private addresses', async () => {
    await expect(assertPublicHost('localhost')).rejects.toThrow(/non-public/);
    await expect(assertPublicHost('127.0.0.1')).rejects.toThrow(/non-public/);
  });
});

describe('provider guards outside development', () => {
  const sms = { ...DEFAULT_NOTIFICATION_SETTINGS.sms, enabled: true, provider: 'http' as const, http: { ...DEFAULT_NOTIFICATION_SETTINGS.sms.http, url: 'https://127.0.0.1:8443/send' } };

  it('generic SMS gateway must be a public host (SSRF)', async () => {
    await expect(sendSms(sms, {}, '+972500000000', 'x', { twilioBase: 'https://api.twilio.com', allowInsecure: false })).rejects.toThrow(/public host/);
  });

  it('SMTP is limited to standard ports and reports coarse errors only', async () => {
    const email = { ...DEFAULT_NOTIFICATION_SETTINGS.email, enabled: true, host: '127.0.0.1', port: 22, from: 'a@b.example' };
    await expect(sendEmail(email, undefined, 'x@y.example', { title: 't', text: 't', url: 'u', urgent: false }, false)).rejects.toThrow(/port must be/);
    // Socket-level details (ECONNREFUSED, EHOSTUNREACH, …) are never exposed.
    expect(smtpError(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:2525'), { code: 'ECONNREFUSED' }))).toMatchObject({ message: 'smtp connection failed', retryable: true });
    expect(smtpError({ responseCode: 535 })).toMatchObject({ message: 'smtp authentication failed', retryable: false });
    expect(smtpError({ responseCode: 451 })).toMatchObject({ message: 'smtp rejected the message (451)', retryable: true });
  });
});
