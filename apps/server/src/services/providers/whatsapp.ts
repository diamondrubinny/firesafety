import type { NotificationSettings } from '@firesafety/shared';
import { httpError, postWithTimeout, ProviderError } from './types.js';

/**
 * WhatsApp Business Cloud API (official). Business-initiated messages must use an
 * approved template. Expected template body with two parameters, e.g.:
 *   "התרעת מערכת ניטור אש: {{1}}. פרטים: {{2}}"
 * Request format requires verification against Meta's current documentation.
 */
export async function sendWhatsApp(
  cfg: NotificationSettings['whatsapp'],
  token: string | undefined,
  to: string,
  summary: string,
  url: string,
  apiBase: string,
): Promise<void> {
  if (!cfg.phoneNumberId || !cfg.templateName || !cfg.apiVersion || !token) throw new ProviderError('WhatsApp is not configured', false);
  if (!/^\d{5,30}$/.test(cfg.phoneNumberId)) throw new ProviderError('invalid WhatsApp phone number id', false);
  // Template parameters may not contain new lines, tabs or more than 4 consecutive spaces.
  const param = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, 900);
  const res = await postWithTimeout(`${apiBase}/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: cfg.templateName,
        language: { code: cfg.templateLanguage || 'he' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: param(summary) }, { type: 'text', text: param(url) }] }],
      },
    }),
  });
  if (!res.ok) throw httpError(res.status);
}
