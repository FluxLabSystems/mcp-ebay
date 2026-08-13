/**
 * Gateway HTTP surface — SDD v0.5 §9 (MCP), §10 (OAuth resource server,
 * RFC 9728 discovery), §11 (pairing), §16 (artifacts), §26 (health).
 */
import { Hono } from 'hono';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import {
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  bearerAuthChallengeResponse,
  type AuthInfo,
  type McpHttpHandler,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from 'pino';
import type { GatewayConfig } from '@browser-bridge/config';
import { getToolEntry, scopeSatisfies, SCOPE_INTERACT, SCOPE_READ, SCOPE_ADMIN, BridgeError } from '@browser-bridge/protocol';
import type { ArtifactTokenIssuer } from './agentAuth.js';
import type { ArtifactStore } from './artifacts/store.js';
import type { CommandBroker } from './broker.js';
import type { DeviceRegistry } from './devices/registry.js';
import { buildMcpServer } from './mcp/server.js';
import { handlePairRequest } from './pairing.js';
import type { Store } from './store/types.js';

export interface GatewayAppDeps {
  config: GatewayConfig;
  store: Store;
  registry: DeviceRegistry;
  broker: CommandBroker;
  artifacts: ArtifactStore;
  artifactTokens: ArtifactTokenIssuer;
  verifier: OAuthTokenVerifier | null;
  logger: Logger;
  serverVersion: string;
}

export interface GatewayApp {
  app: Hono;
  mcpHandler: McpHttpHandler;
  markReady: () => void;
}

const DEV_AUTH_INFO: AuthInfo = {
  token: 'local-development',
  clientId: 'local-dev',
  scopes: [SCOPE_READ, SCOPE_INTERACT, SCOPE_ADMIN],
  expiresAt: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
};

/** RFC 9728 Protected Resource Metadata document (§10.1). */
function protectedResourceMetadata(config: GatewayConfig): Record<string, unknown> {
  const resource = new URL('/mcp', config.publicBaseUrl).toString();
  return {
    resource,
    ...(config.oauth.mode === 'required' ? { authorization_servers: [config.oauth.issuer] } : {}),
    scopes_supported: [SCOPE_READ, SCOPE_INTERACT, SCOPE_ADMIN],
    bearer_methods_supported: ['header'],
    resource_name: 'Connected Browser Bridge MCP',
  };
}

export function buildGatewayApp(deps: GatewayAppDeps): GatewayApp {
  const { config, logger } = deps;
  let ready = false;

  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', config.publicBaseUrl).toString();

  const mcpHandler = createMcpHandler(
    ({ authInfo }) => buildMcpServer({ broker: deps.broker, serverVersion: deps.serverVersion }, authInfo),
    {
      // §9: only the 2026-07-28 modern profile unless compatibility is
      // explicitly enabled by configuration.
      legacy: config.mcpLegacyCompatibility ? 'stateless' : 'reject',
      onerror: (err) => logger.warn({ err: String(err) }, 'MCP handler error'),
    },
  );

  const bearerGate =
    deps.verifier === null
      ? null
      : requireBearerAuth({ verifier: deps.verifier, resourceMetadataUrl });

  const app = createMcpHonoApp({
    allowedHosts: config.allowedHosts,
    allowedOrigins: config.allowedHosts,
  });

  // ---- RFC 9728 discovery: endpoint-specific and root fallback (§10.1) ----
  const metadataBody = () => protectedResourceMetadata(config);
  app.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(metadataBody()));
  app.get('/.well-known/oauth-protected-resource', (c) => c.json(metadataBody()));

  // ---- MCP endpoint ----
  app.all('/mcp', async (c) => {
    let authInfo: AuthInfo;
    if (bearerGate === null) {
      authInfo = { ...DEV_AUTH_INFO };
    } else {
      const gateResult = await bearerGate(c.req.raw);
      if (gateResult instanceof Response) return gateResult;
      authInfo = gateResult;
    }

    // §10.2/§27.2: insufficient scope fails at the HTTP auth boundary.
    let parsedBody: unknown;
    try {
      parsedBody = c.req.method === 'POST' ? await c.req.raw.clone().json() : undefined;
    } catch {
      parsedBody = undefined;
    }
    if (parsedBody !== undefined && typeof parsedBody === 'object' && parsedBody !== null) {
      const body = parsedBody as { method?: unknown; params?: { name?: unknown } };
      if (body.method === 'tools/call' && typeof body.params?.name === 'string') {
        const entry = getToolEntry(body.params.name);
        if (entry !== undefined && !scopeSatisfies(authInfo.scopes, entry.scope)) {
          return bearerAuthChallengeResponse(
            new OAuthError(OAuthErrorCode.InsufficientScope, `Tool ${entry.name} requires scope ${entry.scope}`),
            { requiredScopes: [entry.scope], resourceMetadataUrl },
          );
        }
      }
    }

    const traceparent = c.req.header('traceparent') ?? null;
    const enriched: AuthInfo = {
      ...authInfo,
      extra: { ...(authInfo.extra ?? {}), traceparent },
    };
    return mcpHandler.fetch(c.req.raw, { authInfo: enriched, parsedBody });
  });

  // ---- Device pairing (§11.3) ----
  app.post('/agent/pair', async (c) => {
    const response = await handlePairRequest(c.req.raw, deps.store, logger);
    return response;
  });

  // ---- Agent artifact upload (§16) ----
  app.put('/agent/artifacts/:requestId/:artifactId', async (c) => {
    const authHeader = c.req.header('authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const verified = deps.artifactTokens.verify(token);
    if (verified === null) {
      return c.json({ error: 'invalid artifact token' }, 401);
    }
    const requestId = c.req.param('requestId');
    const artifactId = c.req.param('artifactId');
    const pendingDevice = deps.registry.pendingDevice(requestId);
    if (pendingDevice === undefined || pendingDevice !== verified.deviceId) {
      return c.json({ error: 'no pending command for this request/device' }, 403);
    }
    const mimeType = c.req.header('content-type') ?? 'application/octet-stream';
    const bytes = Buffer.from(await c.req.arrayBuffer());
    try {
      await deps.artifacts.put(artifactId, requestId, mimeType, bytes, null);
    } catch (err) {
      const bridgeError = BridgeError.from(err);
      const status = bridgeError.code === 'ARTIFACT_TOO_LARGE' ? 413 : 500;
      return c.json({ error: bridgeError.code, message: bridgeError.message }, status);
    }
    return c.json({ ok: true, artifactId, byteLength: bytes.length });
  });

  // ---- Signed artifact download (§16) ----
  app.get('/artifacts/:artifactId', async (c) => {
    const artifactId = c.req.param('artifactId');
    const exp = Number.parseInt(c.req.query('exp') ?? '', 10);
    const sig = c.req.query('sig') ?? '';
    if (!Number.isFinite(exp) || sig.length === 0 || !deps.artifacts.verifySignature(artifactId, exp, sig)) {
      return c.json({ error: 'ARTIFACT_EXPIRED', message: 'Invalid or expired artifact link.' }, 404);
    }
    const stored = await deps.artifacts.get(artifactId);
    if (stored === null) {
      return c.json({ error: 'ARTIFACT_EXPIRED', message: 'Artifact TTL elapsed.' }, 404);
    }
    return new Response(new Uint8Array(stored.bytes), {
      status: 200,
      headers: {
        'content-type': stored.row.mimeType,
        'content-length': String(stored.row.byteLength),
        'cache-control': 'private, no-store',
      },
    });
  });

  // ---- Health (§26): device availability is diagnostic, not readiness ----
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    const dbReady = await deps.store.ready();
    if (!ready || !dbReady) {
      return c.json({ status: 'unavailable', db: dbReady, started: ready }, 503);
    }
    return c.json({ status: 'ready' });
  });

  return {
    app,
    mcpHandler,
    markReady: () => {
      ready = true;
    },
  };
}
