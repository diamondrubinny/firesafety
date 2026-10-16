import type { NotificationSettings } from '@firesafety/shared';
import { assertPublicHost } from '../../lib/net-guard.js';
import { httpError, postWithTimeout, ProviderError } from './types.js';

export interface SmsOptions {
  twilioBase: string;
  allowInsecure: boolean;
}

export async function sendSms(
  cfg: NotificationSettings['sms'],
  secrets: { twilioAuthToken?: string; smsHttpHeaders?: string },
  to: string,
  text: string,
  opts: SmsOptions,
): Promise<void> {
  if (cfg.provider === 'twilio') {
    const { accountSid, from } = cfg.twilio;
    if (!accountSid || !from || !secrets.twilioAuthToken) throw new ProviderError('Twilio is not configured', false);
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) throw new ProviderError('invalid Twilio Account SID', false);
    const res = await postWithTimeout(`${opts.twilioBase}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${secrets.twilioAuthToken}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }).toString(),
    });
    if (!res.ok) throw httpError(res.status);
    return;
  }

  // Generic HTTP provider: lets the organisation use any SMS gateway documented by its vendor.
  const { url, method, contentType, bodyTemplate } = cfg.http;
  if (!url) throw new ProviderError('SMS HTTP provider is not configured', false);
  if (!url.startsWith('https://') && !opts.allowInsecure) throw new ProviderError('SMS provider URL must use https', false);
  if (!opts.allowInsecure) {
    // SSRF guard: the configured gateway must be a public internet host.
    await assertPublicHost(new URL(url).hostname).catch(() => {
      throw new ProviderError('SMS provider URL must point to a public host', false);
    });
  }
  let headers: Record<string, string> = {};
  if (secrets.smsHttpHeaders) {
    try {
      const parsed = JSON.parse(secrets.smsHttpHeaders) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
      headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      throw new ProviderError('SMS provider headers must be a JSON object', false);
    }
  }
  const render = (tpl: string, enc: (s: string) => string) => tpl.replaceAll('{{to}}', enc(to)).replaceAll('{{text}}', enc(text));
  const finalUrl = render(url, encodeURIComponent);
  const body =
    method === 'GET'
      ? undefined
      : contentType === 'application/json'
        ? render(bodyTemplate, (s) => JSON.stringify(s).slice(1, -1))
        : render(bodyTemplate, encodeURIComponent);
  const res = await postWithTimeout(finalUrl, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': contentType } : {}), ...headers },
    body,
  });
  if (!res.ok) throw httpError(res.status);
}
