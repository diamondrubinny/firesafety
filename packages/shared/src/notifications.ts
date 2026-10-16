import { z } from 'zod';

export const CHANNELS = ['push', 'email', 'sms', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS_HE: Record<Channel, string> = {
  push: 'התראה בדפדפן / בטלפון (Push)',
  email: 'דוא"ל',
  sms: 'SMS',
  whatsapp: 'WhatsApp',
};

/**
 * Normalises phone numbers to E.164. Israeli local formats (05x-xxxxxxx) are converted
 * to +972. Returns null when the input is not a plausible number.
 */
export function normalizePhone(input: string): string | null {
  const raw = input.replace(/[\s\-().]/g, '');
  let digits: string;
  if (raw.startsWith('+')) digits = raw.slice(1);
  else if (raw.startsWith('00')) digits = raw.slice(2);
  else if (raw.startsWith('0')) digits = `972${raw.slice(1)}`;
  else digits = raw;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  return `+${digits}`;
}

/** "+972501234567" -> "+97250•••4567" (for logs and lists). */
export function maskPhone(e164: string): string {
  return e164.length <= 8 ? '•••' : `${e164.slice(0, 6)}•••${e164.slice(-4)}`;
}

const channelList = z.array(z.enum(CHANNELS)).max(4);
const httpsUrl = z.url().max(500);

/** Non-secret notification settings (stored as JSON). Secrets are handled separately and are write-only. */
export const notificationSettingsSchema = z.object({
  enabled: z.boolean(),
  push: z.object({ enabled: z.boolean(), subject: z.string().max(200) }),
  email: z.object({
    enabled: z.boolean(),
    host: z.string().max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().max(200),
    from: z.string().max(200),
  }),
  sms: z.object({
    enabled: z.boolean(),
    provider: z.enum(['twilio', 'http']),
    twilio: z.object({ accountSid: z.string().max(64), from: z.string().max(32) }),
    http: z.object({
      url: z.union([httpsUrl, z.literal('')]),
      method: z.enum(['POST', 'GET']),
      contentType: z.enum(['application/json', 'application/x-www-form-urlencoded']),
      bodyTemplate: z.string().max(4000),
    }),
  }),
  whatsapp: z.object({
    enabled: z.boolean(),
    provider: z.literal('meta-cloud'),
    phoneNumberId: z.string().max(64),
    apiVersion: z.string().regex(/^v\d{1,3}\.\d$/).or(z.literal('')),
    templateName: z.string().max(100),
    templateLanguage: z.string().max(10),
  }),
  policy: z.object({
    fire: channelList,
    prealarm: channelList,
    fault: channelList,
    comm: channelList,
    escalationSeconds: z.number().int().min(30).max(3600),
    escalationChannels: channelList,
    groupingSeconds: z.number().int().min(0).max(300),
  }),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/** Secret fields: undefined = keep current, '' = clear, string = replace. Never returned by the API. */
export const notificationSecretsSchema = z
  .object({
    emailPassword: z.string().max(500),
    twilioAuthToken: z.string().max(200),
    /** JSON object of extra HTTP headers for the generic SMS provider (e.g. API key). */
    smsHttpHeaders: z.string().max(4000),
    whatsappAccessToken: z.string().max(1000),
  })
  .partial();
export type NotificationSecrets = z.infer<typeof notificationSecretsSchema>;
export type SecretName = keyof NotificationSecrets;

export const notificationSettingsUpdateSchema = z.object({
  settings: notificationSettingsSchema,
  secrets: notificationSecretsSchema.default({}),
});

export interface NotificationSettingsView {
  settings: NotificationSettings;
  secretsConfigured: Record<SecretName, boolean>;
  pushPublicKey: string | null;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: false,
  push: { enabled: true, subject: '' },
  email: { enabled: false, host: '', port: 587, secure: false, user: '', from: '' },
  sms: {
    enabled: false,
    provider: 'http',
    twilio: { accountSid: '', from: '' },
    http: { url: '', method: 'POST', contentType: 'application/json', bodyTemplate: '{"to":"{{to}}","text":"{{text}}"}' },
  },
  whatsapp: { enabled: false, provider: 'meta-cloud', phoneNumberId: '', apiVersion: '', templateName: '', templateLanguage: 'he' },
  policy: {
    fire: ['push', 'sms', 'whatsapp', 'email'],
    prealarm: ['push', 'email'],
    fault: ['push', 'email'],
    comm: ['push', 'sms', 'email'],
    escalationSeconds: 180,
    escalationChannels: ['push', 'sms', 'whatsapp'],
    groupingSeconds: 10,
  },
};

export const testNotificationSchema = z.object({
  channel: z.enum(CHANNELS),
  /** Phone (sms/whatsapp) or e-mail; push goes to the admin's own subscriptions. */
  to: z.string().trim().max(254).optional(),
});

export const myNotificationsSchema = z.object({
  /** null = keep, '' = delete. A new number must go through /me/phone/verify. */
  phone: z.literal('').nullable(),
  channels: channelList,
  whatsappOptIn: z.boolean(),
});

export interface MyNotificationsView {
  /** Whether this user's role receives alarm notifications at all. */
  eligible: boolean;
  phoneHint: string | null;
  pendingPhoneHint: string | null;
  email: string;
  channels: Channel[];
  whatsappOptIn: boolean;
  pushSubscriptions: number;
  available: Record<Channel, boolean>;
}

export const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

export interface NotificationLogEntry {
  id: string;
  createdAt: string;
  sentAt: string | null;
  alarmId: string | null;
  userName: string | null;
  channel: Channel;
  stage: 'initial' | 'escalation';
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  recipientHint: string | null;
  lastError: string | null;
}

export const phoneVerifyStartSchema = z.object({ phone: z.string().trim().min(6).max(32) });
export const phoneVerifyConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export interface PhoneVerifyStartResult {
  sentVia: 'sms' | 'whatsapp';
  phoneHint: string;
  expiresInSeconds: number;
}
