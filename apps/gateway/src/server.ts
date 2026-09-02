/**
 * Gateway boot — SDD v0.5 §23 (container), §26 (health/observability).
 * Binds inside the container only; fluxology-caddy is the sole public
 * TLS edge. The WSS device channel attaches to the same HTTP server at
 * /agent/ws.
 */
import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { WebSocketServer } from 'ws';
import { loadGatewayConfig } from '@browser-bridge/config';
import { ARTIFACT_CLEANUP_INTERVAL_SECONDS } from '@browser-bridge/protocol';
import { ArtifactTokenIssuer } from './agentAuth.js';
import { ArtifactStore } from './artifacts/store.js';
import { buildGatewayApp } from './app.js';
import { CommandBroker } from './broker.js';
import { DeviceRegistry } from './devices/registry.js';
import { handleAgentSocket } from './devices/wsHandler.js';
import { JwtTokenVerifier } from './auth/verifier.js';
import { PgStore } from './store/pg.js';

const SERVER_VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadGatewayConfig();
  const logger = pino({
    name: 'browser-mcp-gateway',
    level: config.logLevel,
    redact: {
      paths: [
        'authorization',
        '*.authorization',
        'token',
        '*.token',
        'artifactToken',
        '*.artifactToken',
        // The Countdown API key (docs/COUNTDOWN-API-PLAN.md §2, Credits).
        // pino wildcards match one level each, so the deeper paths cover a
        // config or client object logged whole (nothing does today; belt
        // and braces).
        'api_key',
        '*.api_key',
        '*.*.api_key',
        'apiKey',
        '*.apiKey',
        '*.*.apiKey',
        '*.*.*.apiKey',
        'config.countdown.apiKey',
      ],
      censor: '[REDACTED]',
    },
  });

  const store = new PgStore(config.databaseUrl);
  const registry = new DeviceRegistry();
  const artifactTokens = new ArtifactTokenIssuer(config.artifactUrlSecret);
  const artifacts = new ArtifactStore({
    dir: config.artifactDir,
    ttlSeconds: config.artifactTtlSeconds,
    publicBaseUrl: config.publicBaseUrl,
    ...(config.artifactUrlSecret === undefined ? {} : { urlSecret: config.artifactUrlSecret }),
    meta: store.artifacts,
  });
  const broker = new CommandBroker({
    registry,
    store,
    artifacts,
    logger,
    ebayDestinationPostalCode: config.ebayDestinationPostalCode,
  });
  const verifier =
    config.oauth.mode === 'required'
      ? new JwtTokenVerifier({
          issuer: config.oauth.issuer,
          audience: config.oauth.audience,
          jwksUri: config.oauth.jwksUri,
        })
      : null;
  if (verifier === null) {
    logger.warn({}, 'OAuth is DISABLED (development mode); production requires OAUTH_MODE=required (SDD §10)');
  }

  const gatewayApp = buildGatewayApp({
    config,
    store,
    registry,
    broker,
    artifacts,
    artifactTokens,
    verifier,
    logger,
    serverVersion: SERVER_VERSION,
  });

  const server = serve({ fetch: gatewayApp.app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port }, 'Gateway listening');
    gatewayApp.markReady();
  });

  // WSS device channel (§12): single outbound WebSocket per agent.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/agent/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      handleAgentSocket(ws, {
        store,
        registry,
        artifactTokens,
        logger,
        heartbeatSeconds: config.deviceHeartbeatSeconds,
      });
    });
  });

  // §16/§21: cleanup expired artifacts, pairing tokens and run checkpoints
  // every 5 minutes. Run checkpoints already read as absent once expired;
  // this is the retention half of the same rule — a run that is never
  // completed does not leave a row behind forever.
  const cleanupTimer = setInterval(() => {
    void artifacts.cleanupExpired().then((count) => {
      if (count > 0) logger.info({ count }, 'Expired artifacts deleted');
    });
    void store.pairingTokens.purgeExpired(new Date());
    void store.runCheckpoints.purgeExpired(new Date());
  }, ARTIFACT_CLEANUP_INTERVAL_SECONDS * 1000);
  cleanupTimer.unref?.();

  const shutdown = async (): Promise<void> => {
    logger.info({}, 'Shutting down');
    clearInterval(cleanupTimer);
    await gatewayApp.mcpHandler.close();
    wss.close();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
