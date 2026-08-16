/**
 * OAuth 2.1 resource-server token verification — SDD v0.5 §10.1. JWT
 * signature against the configured JWKS, issuer, audience/resource,
 * expiration, not-before, and scope parsing. The inbound MCP token is
 * never forwarded to the Windows agent or any website.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';

export interface JwtVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Injectable for tests (local JWKS). */
  jwks?: ReturnType<typeof createRemoteJWKSet>;
}

export function parseScopes(payload: JWTPayload): string[] {
  const raw = payload.scope ?? payload.scp;
  if (typeof raw === 'string') return raw.split(/\s+/).filter((scope) => scope.length > 0);
  if (Array.isArray(raw)) return raw.filter((scope): scope is string => typeof scope === 'string');
  return [];
}

export class JwtTokenVerifier implements OAuthTokenVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;
  private readonly options: JwtVerifierOptions;

  constructor(options: JwtVerifierOptions) {
    this.options = options;
    this.jwks = options.jwks ?? createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
      });
      payload = result.payload;
    } catch (err) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, err instanceof Error ? err.message : 'Token validation failed');
    }
    if (payload.exp === undefined) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has no expiration');
    }
    return {
      token,
      clientId: typeof payload.client_id === 'string' ? payload.client_id : (payload.azp as string | undefined) ?? 'unknown',
      scopes: parseScopes(payload),
      expiresAt: payload.exp,
      resource: new URL(this.options.audience),
      extra: { subject: payload.sub ?? null },
    };
  }
}
