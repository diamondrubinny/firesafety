import nodemailer from 'nodemailer';
import type { NotificationSettings } from '@firesafety/shared';
import { ProviderError, type OutboundMessage } from './types.js';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function sendEmail(
  cfg: NotificationSettings['email'],
  password: string | undefined,
  to: string,
  msg: OutboundMessage,
  /** Development/test only: allow SMTP without TLS. */
  allowInsecure = false,
): Promise<void> {
  if (!cfg.host || !cfg.from) throw new ProviderError('email is not configured', false);
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    // Never send credentials or alert content over plaintext SMTP in production.
    requireTLS: !cfg.secure && !allowInsecure,
    ignoreTLS: allowInsecure && !cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: cfg.from,
      to,
      subject: msg.title,
      text: `${msg.text}\n\n${msg.url}\n\nמערכת משלימה לניטור בלבד. אינה מחליפה את נהלי החירום.`,
      html:
        `<div dir="rtl" lang="he" style="font-family:Arial,sans-serif">` +
        `<p style="font-size:16px"><strong>${escapeHtml(msg.text)}</strong></p>` +
        `<p><a href="${escapeHtml(msg.url)}">פתיחה במערכת</a></p>` +
        `<p style="color:#555;font-size:12px">מערכת משלימה לניטור בלבד. אינה מחליפה את נהלי החירום.</p></div>`,
      priority: msg.urgent ? 'high' : 'normal',
    });
  } catch (err) {
    const code = (err as { responseCode?: number; code?: string }).responseCode;
    throw new ProviderError(`smtp error${code ? ` ${code}` : ` (${(err as { code?: string }).code ?? 'unknown'})`}`, !code || code >= 400 && code < 500);
  } finally {
    transport.close();
  }
}
