import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  PUBLIC_ORIGIN: 'https://fs.example',
  DATABASE_URL: 'postgres://x',
  AUDIT_IP_PEPPER: 'x'.repeat(32),
};

describe('config', () => {
  it('treats an empty MONITORING_TOKEN (as in .env.example) as disabled, rejects a short one', () => {
    expect(loadConfig({ ...base, AUTH_MODE: 'dev', MONITORING_TOKEN: '' }).MONITORING_TOKEN).toBeUndefined();
    expect(() => loadConfig({ ...base, AUTH_MODE: 'dev', MONITORING_TOKEN: 'short' })).toThrow(/MONITORING_TOKEN/);
  });

  it('rejects dev auth mode in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE=dev is forbidden/);
  });

  it('requires OIDC settings when AUTH_MODE=oidc', () => {
    expect(() => loadConfig({ ...base, AUTH_MODE: 'oidc' })).toThrow(/OIDC_CLIENT_ID is required/);
  });

  it('rejects insecure cookies and http origin in production', () => {
    const env = {
      ...base,
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'http://fs.example',
      COOKIE_SECURE: 'false',
      OIDC_ISSUER: 'https://login.microsoftonline.com/t/v2.0',
      OIDC_TENANT_ID: 't',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
    };
    expect(() => loadConfig(env)).toThrow(/COOKIE_SECURE must be true[\s\S]*must be https/);
  });

  it('never echoes secret values in errors', () => {
    try {
      loadConfig({ ...base, AUDIT_IP_PEPPER: 'short-secret-value' });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('short-secret-value');
    }
  });
});
