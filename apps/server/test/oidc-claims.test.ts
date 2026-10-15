import { describe, expect, it } from 'vitest';
import { IdentityRejectedError, identityFromClaims } from '../src/auth/oidc.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const valid = {
  oid: 'oid-1',
  tid: TENANT,
  preferred_username: 'officer@campus.example',
  name: 'Safety Officer',
  roles: ['SafetyOfficer', 'SomethingElse'],
  amr: ['pwd', 'mfa'],
};

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof IdentityRejectedError ? err.reason : 'unexpected';
  }
  return 'accepted';
};

describe('identityFromClaims', () => {
  it('accepts valid claims and keeps only known roles', () => {
    const id = identityFromClaims(valid, { tenantId: TENANT, requireMfa: true });
    expect(id).toMatchObject({ oid: 'oid-1', email: 'officer@campus.example', roles: ['SafetyOfficer'] });
  });

  it('rejects a foreign tenant', () => {
    expect(reason(() => identityFromClaims({ ...valid, tid: 'other' }, { tenantId: TENANT, requireMfa: false }))).toBe('wrong_tenant');
  });

  it('rejects users without an app role', () => {
    expect(reason(() => identityFromClaims({ ...valid, roles: ['Random'] }, { tenantId: TENANT, requireMfa: false }))).toBe('no_app_role');
  });

  it('enforces MFA when required', () => {
    expect(reason(() => identityFromClaims({ ...valid, amr: ['pwd'] }, { tenantId: TENANT, requireMfa: true }))).toBe('mfa_required');
    expect(reason(() => identityFromClaims({ ...valid, amr: ['pwd'] }, { tenantId: TENANT, requireMfa: false }))).toBe('accepted');
  });

  it('rejects missing oid', () => {
    expect(reason(() => identityFromClaims({ ...valid, oid: undefined }, { tenantId: TENANT, requireMfa: false }))).toBe('missing_oid_or_tid');
  });
});
