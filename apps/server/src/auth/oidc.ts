import * as client from 'openid-client';
import { isRole, type Role } from '@firesafety/shared';
import type { AppConfig } from '../config.js';

export interface LoginTransaction {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface VerifiedIdentity {
  oid: string;
  tenantId: string;
  email: string;
  displayName: string;
  roles: Role[];
  amr: string[];
}

/** Abstraction over the identity provider so routes can be tested without Entra ID. */
export interface OidcProvider {
  beginLogin(redirectUri: string): Promise<LoginTransaction>;
  completeLogin(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<VerifiedIdentity>;
}

export class IdentityRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`Identity rejected: ${reason}`);
    this.name = 'IdentityRejectedError';
  }
}

/**
 * Maps verified ID-token claims to an identity and enforces tenant, role and MFA policy.
 * Exported separately so the policy can be unit-tested.
 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  policy: { tenantId: string; requireMfa: boolean },
): VerifiedIdentity {
  const str = (k: string) => (typeof claims[k] === 'string' ? (claims[k] as string) : undefined);
  const oid = str('oid');
  const tid = str('tid');
  if (!oid || !tid) throw new IdentityRejectedError('missing_oid_or_tid');
  if (tid.toLowerCase() !== policy.tenantId.toLowerCase()) throw new IdentityRejectedError('wrong_tenant');

  const roles = Array.isArray(claims.roles) ? claims.roles.filter(isRole) : [];
  if (roles.length === 0) throw new IdentityRejectedError('no_app_role');

  const amr = Array.isArray(claims.amr) ? claims.amr.filter((v): v is string => typeof v === 'string') : [];
  if (policy.requireMfa && !amr.includes('mfa')) throw new IdentityRejectedError('mfa_required');

  const email = str('email') ?? str('preferred_username');
  if (!email) throw new IdentityRejectedError('missing_email');

  return { oid, tenantId: tid, email, displayName: str('name') ?? email, roles, amr };
}

export class EntraOidcProvider implements OidcProvider {
  private configPromise: Promise<client.Configuration> | undefined;

  constructor(private readonly cfg: AppConfig) {}

  private configuration(): Promise<client.Configuration> {
    // Lazy discovery; on failure the cached promise is dropped so the next login retries.
    this.configPromise ??= client
      .discovery(new URL(this.cfg.OIDC_ISSUER!), this.cfg.OIDC_CLIENT_ID!, this.cfg.OIDC_CLIENT_SECRET!)
      .catch((err: unknown) => {
        this.configPromise = undefined;
        throw err;
      });
    return this.configPromise;
  }

  async beginLogin(redirectUri: string): Promise<LoginTransaction> {
    const config = await this.configuration();
    const codeVerifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: 'openid profile email',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url, state, nonce, codeVerifier };
  }

  async completeLogin(
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<VerifiedIdentity> {
    const config = await this.configuration();
    const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new IdentityRejectedError('missing_id_token');
    // Access/refresh tokens are intentionally discarded: the app needs only the identity.
    return identityFromClaims(claims as Record<string, unknown>, {
      tenantId: this.cfg.OIDC_TENANT_ID!,
      requireMfa: this.cfg.OIDC_REQUIRE_MFA,
    });
  }
}
