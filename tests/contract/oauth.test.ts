/**
 * OAuth 2.1 resource-server boundary (§10, §27.2): signature/issuer/
 * audience/expiry validation against a local JWKS, WWW-Authenticate
 * challenges with resource_metadata, and scope failures at the HTTP
 * boundary.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '@browser-bridge/gateway';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const ISSUER = 'https://idp.test.example';
const AUDIENCE = 'https://browser-mcp.test.example/mcp';

let harness: GatewayHarness;
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;

async function mintToken(options: {
  issuer?: string;
  audience?: string;
  scope?: string;
  expired?: boolean;
  key?: CryptoKey;
  notYetValid?: boolean;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({
    scope: options.scope ?? 'browser:read browser:interact',
    client_id: 'test-client',
  })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setSubject('user-1')
    .setIssuedAt(options.expired ? now - 7200 : now)
    .setExpirationTime(options.expired ? now - 3600 : now + 3600);
  if (options.notYetValid) {
    jwt = jwt.setNotBefore(now + 3600);
  }
  return jwt.sign(options.key ?? privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk = (await exportJWK(pair.publicKey)) as JWK;
  publicJwk.alg = 'ES256';

  const rogue = await generateKeyPair('ES256');
  otherPrivateKey = rogue.privateKey as CryptoKey;

  const verifier = new JwtTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: 'https://idp.test.example/.well-known/jwks.json',
    jwks: createLocalJWKSet({ keys: [publicJwk] }) as never,
  });
  harness = buildGatewayHarness({ verifier });
});
afterAll(async () => {
  await harness.close();
});

function clientWith(token?: string): ModernMcpClient {
  return new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch, token);
}

describe('bearer authentication (§10.1)', () => {
  it('401 with WWW-Authenticate and resource_metadata when the token is missing', async () => {
    const response = await harness.fetch(
      new Request('https://browser-mcp.test.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer/);
    expect(challenge).toContain('resource_metadata="https://browser-mcp.test.example/.well-known/oauth-protected-resource/mcp"');
  });

  it('accepts a valid token end to end', async () => {
    const response = await clientWith(await mintToken({})).listTools();
    expect(response.status).toBe(200);
    expect(response.body.result?.tools).toHaveLength(15);
  });

  it.each([
    ['wrong issuer', { issuer: 'https://evil.example' }],
    ['wrong audience', { audience: 'https://other-resource.example' }],
    ['expired', { expired: true }],
    ['not yet valid', { notYetValid: true }],
  ] as const)('rejects %s tokens with 401', async (_label, overrides) => {
    const token = await mintToken(overrides as Parameters<typeof mintToken>[0]);
    const response = await clientWith(token).listTools();
    expect(response.status).toBe(401);
  });

  it('rejects tokens signed by an unknown key with 401', async () => {
    const response = await clientWith(await mintToken({ key: otherPrivateKey })).listTools();
    expect(response.status).toBe(401);
  });
});

describe('scope enforcement at the HTTP boundary (§10.2, §27.2)', () => {
  it('403 insufficient_scope when calling interact tools with browser:read only', async () => {
    const token = await mintToken({ scope: 'browser:read' });
    const response = await clientWith(token).callTool('browser.navigate', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
      tabId: 'tab_1',
      url: 'https://www.ebay.ca/',
    });
    expect(response.status).toBe(403);
  });

  it('browser:read allows read tools', async () => {
    const token = await mintToken({ scope: 'browser:read' });
    const response = await clientWith(token).callTool('browser.tabs', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
    });
    expect(response.status).toBe(200); // reaches the broker → SESSION_NOT_FOUND result
    const text = response.body.result?.content?.[0]?.text ?? '{}';
    expect(JSON.parse(text).error.code).toBe('SESSION_NOT_FOUND');
  });

  it('browser:interact satisfies read tools (§10.2)', async () => {
    const token = await mintToken({ scope: 'browser:interact' });
    const response = await clientWith(token).callTool('browser.snapshot', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
      tabId: 'tab_1',
    });
    expect(response.status).toBe(200);
  });

  it('browser:admin alone cannot use browser tools (§10.2)', async () => {
    const token = await mintToken({ scope: 'browser:admin' });
    const response = await clientWith(token).callTool('browser.tabs', {
      browserSessionHandle: 'bs_0123456789abcdefgh',
    });
    expect(response.status).toBe(403);
  });
});
