import { describe, expect, it } from 'vitest';
import { buildAuditEvent, redactMetadata } from '@browser-bridge/audit';
import { defaultAgentDirs, loadAgentConfig, loadGatewayConfig } from '@browser-bridge/config';
import {
  CommandEnvelopeSchema,
  parseWireMessage,
  ResultEnvelopeSchema,
  WIRE_PROTOCOL_VERSION,
} from '@browser-bridge/protocol';

const BASE_ENV = {
  PUBLIC_BASE_URL: 'https://browser-mcp.example.com',
  DATABASE_URL: 'postgres://x',
};

describe('gateway configuration contract (§25)', () => {
  it('applies defaults', () => {
    const config = loadGatewayConfig({ ...BASE_ENV, NODE_ENV: 'development' });
    expect(config.port).toBe(3000);
    expect(config.artifactTtlSeconds).toBe(900);
    expect(config.deviceHeartbeatSeconds).toBe(20);
    expect(config.ebayDestinationPostalCode).toBe('M6H 2W9');
    expect(config.mcpLegacyCompatibility).toBe(false);
    expect(config.oauth.mode).toBe('disabled');
    expect(config.allowedHosts).toContain('browser-mcp-gateway');
  });

  it('production requires the OAuth resource-server variables (§10)', () => {
    expect(() => loadGatewayConfig({ ...BASE_ENV, NODE_ENV: 'production' })).toThrow();
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, NODE_ENV: 'production', OAUTH_MODE: 'disabled' }),
    ).toThrow();
    const config = loadGatewayConfig({
      ...BASE_ENV,
      NODE_ENV: 'production',
      OAUTH_ISSUER: 'https://idp.example.com',
      OAUTH_AUDIENCE: 'https://browser-mcp.example.com',
      OAUTH_JWKS_URI: 'https://idp.example.com/.well-known/jwks.json',
    });
    expect(config.oauth).toMatchObject({ mode: 'required', issuer: 'https://idp.example.com' });
  });

  it('rejects non-https issuer/jwks and caps artifact TTL (§16)', () => {
    expect(() =>
      loadGatewayConfig({
        ...BASE_ENV,
        OAUTH_MODE: 'required',
        OAUTH_ISSUER: 'http://insecure.example.com',
        OAUTH_AUDIENCE: 'x',
        OAUTH_JWKS_URI: 'https://idp.example.com/jwks',
      }),
    ).toThrow();
    expect(() => loadGatewayConfig({ ...BASE_ENV, ARTIFACT_TTL_SECONDS: '7200' })).toThrow();
  });
});

describe('agent configuration (§25)', () => {
  it('derives the HTTPS base from the WSS URL', () => {
    const config = loadAgentConfig(
      { AGENT_GATEWAY_URL: 'wss://browser-mcp.example.com/agent/ws', HOME: '/home/tester' },
      'linux',
    );
    expect(config.gatewayHttpUrl).toBe('https://browser-mcp.example.com');
    expect(config.profileDir).toBe('/home/tester/.local/share/Fluxology/BrowserBridge/profiles/ebay-research');
  });

  it('uses %LOCALAPPDATA% defaults on Windows (§4)', () => {
    const dirs = defaultAgentDirs('win32', { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' });
    expect(dirs.profileDir).toBe('C:\\Users\\Tester\\AppData\\Local\\Fluxology\\BrowserBridge\\profiles\\ebay-research');
  });
});

describe('audit redaction (§26)', () => {
  it('redacts secret-bearing keys recursively', () => {
    const event = buildAuditEvent({
      actionClass: 'read',
      outcome: 'ok',
      metadata: {
        url: 'https://www.ebay.ca/itm/1',
        authorization: 'Bearer abc',
        nested: { pairingToken: 'xyz', fine: 1 },
      },
    });
    expect(event.metadata.authorization).toBe('[REDACTED]');
    expect((event.metadata.nested as Record<string, unknown>).pairingToken).toBe('[REDACTED]');
    expect((event.metadata.nested as Record<string, unknown>).fine).toBe(1);
    expect(event.metadata.url).toBe('https://www.ebay.ca/itm/1');
    expect(redactMetadata({ privateKeyPem: 'x' }).privateKeyPem).toBe('[REDACTED]');
  });
});

describe('wire envelopes (Appendix B, §12)', () => {
  const command = {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: '01JTESTREQUEST0000000000',
    deviceId: 'dev_1',
    browserSessionHandle: 'bs_0123456789abcdef',
    tabId: 'tab_0123456789',
    command: 'snapshot',
    arguments: {},
    issuedAt: '2026-08-12T21:00:00Z',
    expiresAt: '2026-08-12T21:00:30Z',
    idempotencyKey: 'idem_1',
    policyClass: 'read',
    traceparent: null,
  };

  it('accepts the normative command envelope and rejects unknown fields', () => {
    expect(CommandEnvelopeSchema.parse(command)).toBeTruthy();
    expect(() => CommandEnvelopeSchema.parse({ ...command, extra: 1 })).toThrow();
    expect(() => CommandEnvelopeSchema.parse({ ...command, policyClass: 'destructive' })).toThrow();
  });

  it('rejects unknown wire protocol major versions before shape validation', () => {
    expect(() => parseWireMessage(JSON.stringify({ ...command, protocolVersion: '2.0' }), CommandEnvelopeSchema)).toThrow(
      /major version/,
    );
  });

  it('validates result envelopes including error payloads (§12.3)', () => {
    const result = {
      protocolVersion: WIRE_PROTOCOL_VERSION,
      type: 'result',
      requestId: '01JTESTREQUEST0000000000',
      status: 'error',
      pageRevision: null,
      result: null,
      artifacts: [],
      error: {
        code: 'STALE_ELEMENT',
        message: 'Element reference belongs to page revision 41; current revision is 42.',
        retryable: true,
        details: {},
      },
      durationMs: 24,
    };
    expect(ResultEnvelopeSchema.parse(result)).toBeTruthy();
    expect(() =>
      ResultEnvelopeSchema.parse({ ...result, error: { ...result.error, code: 'MADE_UP_CODE' } }),
    ).toThrow();
  });
});
