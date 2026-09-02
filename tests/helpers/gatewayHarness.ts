/**
 * In-process gateway harness. Contract tests drive `app.fetch` directly;
 * integration/e2e tests start a real HTTP server with the WSS device
 * channel attached, exactly as production boot wires it.
 */
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { WebSocketServer } from 'ws';
import { serve } from '@hono/node-server';
import { loadGatewayConfig, type GatewayConfig } from '@browser-bridge/config';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import {
  ArtifactStore,
  ArtifactTokenIssuer,
  buildGatewayApp,
  CommandBroker,
  DeviceRegistry,
  handleAgentSocket,
  MemoryStore,
  type GatewayApp,
} from '@browser-bridge/gateway';

export interface GatewayHarness {
  config: GatewayConfig;
  app: GatewayApp['app'];
  store: MemoryStore;
  registry: DeviceRegistry;
  broker: CommandBroker;
  artifacts: ArtifactStore;
  artifactTokens: ArtifactTokenIssuer;
  fetch: (request: Request) => Promise<Response>;
  /** Start a real HTTP+WSS server; returns base URLs. */
  listen: () => Promise<{ httpUrl: string; wsUrl: string; port: number }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  verifier?: OAuthTokenVerifier | null;
  env?: Record<string, string>;
  heartbeatSeconds?: number;
  /** Stub the dashboard write-path's outbound fetch (dashboard.* tools). */
  dashboardFetch?: typeof fetch;
  /** Stub the Countdown API source's outbound fetch (ebay_api_* tools). */
  countdownFetch?: typeof fetch;
  /** Sets COUNTDOWN_API_KEY, which is what registers the ebay_api_* tools; unset by default. */
  countdownApiKey?: string;
}

export function buildGatewayHarness(options: HarnessOptions = {}): GatewayHarness {
  const artifactDir = mkdtempSync(join(tmpdir(), 'bridge-artifacts-'));
  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
    DATABASE_URL: 'postgres://unused-in-memory-tests',
    OAUTH_MODE: options.verifier === undefined || options.verifier === null ? 'disabled' : 'required',
    OAUTH_ISSUER: 'https://idp.test.example',
    OAUTH_AUDIENCE: 'https://browser-mcp.test.example/mcp',
    OAUTH_JWKS_URI: 'https://idp.test.example/.well-known/jwks.json',
    ARTIFACT_DIR: artifactDir,
    EXTRA_ALLOWED_HOSTS: 'browser-mcp.test.example',
    ...(options.countdownApiKey === undefined ? {} : { COUNTDOWN_API_KEY: options.countdownApiKey }),
    ...(options.env ?? {}),
  });
  const logger = pino({ level: 'silent' });
  const store = new MemoryStore();
  const registry = new DeviceRegistry();
  const artifactTokens = new ArtifactTokenIssuer('test-artifact-token-secret');
  const artifacts = new ArtifactStore({
    dir: config.artifactDir,
    ttlSeconds: config.artifactTtlSeconds,
    publicBaseUrl: config.publicBaseUrl,
    urlSecret: 'test-artifact-url-secret',
    meta: store.artifacts,
  });
  const broker = new CommandBroker({
    registry,
    store,
    artifacts,
    logger,
    ebayDestinationPostalCode: config.ebayDestinationPostalCode,
  });
  const gatewayApp = buildGatewayApp({
    config,
    store,
    registry,
    broker,
    artifacts,
    artifactTokens,
    verifier: options.verifier ?? null,
    logger,
    serverVersion: '0.1.0-test',
    ...(options.dashboardFetch === undefined ? {} : { dashboardFetch: options.dashboardFetch }),
    ...(options.countdownFetch === undefined ? {} : { countdownFetch: options.countdownFetch }),
  });
  gatewayApp.markReady();

  let server: Server | null = null;
  let wss: WebSocketServer | null = null;

  const harness: GatewayHarness = {
    config,
    app: gatewayApp.app,
    store,
    registry,
    broker,
    artifacts,
    artifactTokens,
    fetch: async (request) =>
      gatewayApp.app.fetch(
        new Request(request, { headers: withHost(request.headers, 'browser-mcp.test.example') }),
      ),
    listen: async () => {
      const port = await new Promise<number>((resolve) => {
        server = serve({ fetch: gatewayApp.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) =>
          resolve(info.port),
        ) as unknown as Server;
      });
      wss = new WebSocketServer({ noServer: true });
      server!.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== '/agent/ws') {
          socket.destroy();
          return;
        }
        wss!.handleUpgrade(request, socket, head, (ws) => {
          handleAgentSocket(ws, {
            store,
            registry,
            artifactTokens,
            logger,
            heartbeatSeconds: options.heartbeatSeconds ?? 20,
          });
        });
      });
      return { httpUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/agent/ws`, port };
    },
    close: async () => {
      wss?.close();
      if (server !== null) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
    },
  };
  return harness;
}

function withHost(headers: Headers, host: string): Headers {
  const out = new Headers(headers);
  out.set('host', host);
  return out;
}
