import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Public origin of the web app, e.g. https://firesafety.campus.example */
    PUBLIC_ORIGIN: z.url(),
    TRUST_PROXY: bool.default(false),

    DATABASE_URL: z.string().min(1),
    DATABASE_SSL: bool.default(false),

    /** Secret used to hash IPs in the audit log. Min 32 chars. */
    AUDIT_IP_PEPPER: z.string().min(32),

    COOKIE_SECURE: bool.default(true),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(60),
    SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).max(7 * 24).default(12),

    AUTH_MODE: z.enum(['oidc', 'dev']).default('oidc'),
    OIDC_ISSUER: z.url().optional(),
    OIDC_TENANT_ID: z.string().optional(),
    OIDC_CLIENT_ID: z.string().optional(),
    OIDC_CLIENT_SECRET: z.string().optional(),
    /** Require the "mfa" value in the "amr" claim. Requires verification against the tenant's token configuration. */
    OIDC_REQUIRE_MFA: bool.default(false),

    /** A collector silent for longer than this raises a communication alarm. */
    COLLECTOR_STALE_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),

    /** Antivirus for uploads. Production requires clamav (clamd INSTREAM). */
    UPLOAD_SCANNER: z.enum(['clamav', 'none']).default('none'),
    CLAMAV_HOST: z.string().default('clamav'),
    CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
    CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

    /** 32 random bytes, base64. Encrypts provider secrets and phone numbers at rest. */
    SETTINGS_ENCRYPTION_KEY: z.string().optional(),
    /** Push endpoints the server may POST to (SSRF protection). Comma-separated host suffixes. */
    PUSH_ENDPOINT_ALLOWLIST: z
      .string()
      .default('fcm.googleapis.com,updates.push.services.mozilla.com,push.services.mozilla.com,push.apple.com,notify.windows.com'),
    /** Development/test only: allow http:// provider and push endpoints (e.g. local fakes). */
    NOTIFY_ALLOW_INSECURE_ENDPOINTS: bool.default(false),
    TWILIO_API_BASE: z.url().default('https://api.twilio.com'),
    WHATSAPP_API_BASE: z.url().default('https://graph.facebook.com'),
    /** Route outbound HTTPS (providers, Entra) through HTTPS_PROXY/NO_PROXY from the environment. */
    OUTBOUND_PROXY_FROM_ENV: bool.default(false),

    /** Data retention (days). Defaults require approval by the privacy officer / legal counsel. */
    RETENTION_EVENT_LOG_DAYS: z.coerce.number().int().min(30).max(3650).default(730),
    RETENTION_NOTIFICATIONS_DAYS: z.coerce.number().int().min(30).max(3650).default(365),
    RETENTION_ALARMS_DAYS: z.coerce.number().int().min(365).max(7300).default(2555),

    RATE_LIMIT_MAX: z.coerce.number().int().min(10).default(300),
  })
  .superRefine((env, ctx) => {
    if (env.SETTINGS_ENCRYPTION_KEY && Buffer.from(env.SETTINGS_ENCRYPTION_KEY, 'base64').length !== 32) {
      ctx.addIssue({ code: 'custom', path: ['SETTINGS_ENCRYPTION_KEY'], message: 'SETTINGS_ENCRYPTION_KEY must be 32 bytes, base64-encoded' });
    }
    if (env.AUTH_MODE === 'oidc') {
      for (const key of ['OIDC_ISSUER', 'OIDC_TENANT_ID', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when AUTH_MODE=oidc` });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_MODE === 'dev') {
        ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=dev is forbidden in production' });
      }
      if (!env.COOKIE_SECURE) {
        ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'COOKIE_SECURE must be true in production' });
      }
      if (!env.SETTINGS_ENCRYPTION_KEY) {
        ctx.addIssue({ code: 'custom', path: ['SETTINGS_ENCRYPTION_KEY'], message: 'SETTINGS_ENCRYPTION_KEY is required in production' });
      }
      if (env.NOTIFY_ALLOW_INSECURE_ENDPOINTS) {
        ctx.addIssue({ code: 'custom', path: ['NOTIFY_ALLOW_INSECURE_ENDPOINTS'], message: 'NOTIFY_ALLOW_INSECURE_ENDPOINTS is forbidden in production' });
      }
      if (env.UPLOAD_SCANNER !== 'clamav') {
        ctx.addIssue({ code: 'custom', path: ['UPLOAD_SCANNER'], message: 'UPLOAD_SCANNER must be clamav in production' });
      }
      if (!env.PUBLIC_ORIGIN.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'PUBLIC_ORIGIN must be https in production' });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Report only variable names and messages, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return parsed.data;
}
