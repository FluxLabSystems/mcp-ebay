#!/usr/bin/env node
/**
 * Windows Browser Agent CLI — SDD v0.5 §11, §13, §32.
 *
 * Invoked from the repo checkout as
 *   node apps\\windows-agent\\dist\\cli.js <command>
 * (LANE-B-RUNBOOK.md [33]-[34], scripts/windows/lane-a-run.ps1). The
 * `browser-bridge-agent` bin name in package.json resolves only under a global
 * install, which nothing here performs, so the usage strings below spell out
 * the checkout-relative form an operator can paste.
 *
 *   node apps\\windows-agent\\dist\\cli.js pair --token <one-time-token> [--name <device-name>]
 *   node apps\\windows-agent\\dist\\cli.js preflight
 *   node apps\\windows-agent\\dist\\cli.js run
 */
import { buildChromeLaunchPlan, preflightBrowser } from '@browser-bridge/browser-core';
import { loadAgentConfig } from '@browser-bridge/config';
import { mergeSiteProfiles, type SitePolicyProfile } from '@browser-bridge/policy';
import { BridgeError } from '@browser-bridge/protocol';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { kijijiSiteProfile } from '@browser-bridge/site-kijiji';
import { zazzleSiteProfile } from '@browser-bridge/site-zazzle';
import { AgentConnection } from './connection.js';
import { IdentityStore } from './identity.js';
import { createLogger } from './logger.js';
import { pairDevice } from './pairing.js';
import { createPagePolicy } from './policyEngine.js';
import { SessionManager } from './sessionManager.js';
import { AGENT_VERSION } from './version.js';

/** Site profiles compiled into this agent build, keyed by versioned id. */
const SITE_PROFILES: ReadonlyMap<string, SitePolicyProfile> = new Map(
  [ebaySiteProfile, kijijiSiteProfile, zazzleSiteProfile].map((profile) => [profile.id, profile]),
);

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, 'true');
      }
    }
  }
  return flags;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const flags = parseFlags(rest);
  const config = loadAgentConfig();
  const logger = createLogger(config.logLevel, 'browser-bridge-agent');

  switch (command) {
    case 'pair': {
      const token = flags.get('token');
      if (token === undefined) {
        console.error(
          'Usage: node apps\\windows-agent\\dist\\cli.js pair --token <one-time-token> [--name <device-name>]',
        );
        return 2;
      }
      const identityStore = new IdentityStore(config.stateDir);
      const identity = identityStore.loadOrCreate();
      logger.info({ fingerprint: identity.fingerprint, keyStore: identity.keyStoreKind }, 'Device key ready');
      const result = await pairDevice(
        config.gatewayHttpUrl,
        token,
        identity.publicKeyPem,
        flags.get('name') ?? config.agentName,
      );
      identityStore.saveDeviceId(result.deviceId);
      console.log(`Paired. deviceId=${result.deviceId}`);
      return 0;
    }
    case 'preflight': {
      // §30: fails closed with BROWSER_UNAVAILABLE when branded Chrome
      // channel "chrome" is unavailable; no fallback browser is attempted.
      try {
        await preflightBrowser(buildChromeLaunchPlan(config.profileDir));
        console.log('Preflight OK: branded Google Chrome (channel "chrome") launched with the dedicated automation profile.');
        return 0;
      } catch (err) {
        const bridgeError = BridgeError.from(err, 'BROWSER_UNAVAILABLE');
        console.error(`${bridgeError.code}: ${bridgeError.message}`);
        return 1;
      }
    }
    case 'run': {
      const identityStore = new IdentityStore(config.stateDir);
      const identity = identityStore.loadOrCreate();
      if (identity.deviceId === null) {
        console.error(
          'Device is not paired. Run: node apps\\windows-agent\\dist\\cli.js pair --token <one-time-token>',
        );
        return 2;
      }
      if (process.platform !== 'win32') {
        logger.warn({}, 'Running on a non-Windows host: development/test mode only');
      }
      const unknownIds = config.siteProfileIds.filter((id) => !SITE_PROFILES.has(id));
      if (unknownIds.length > 0) {
        console.error(
          `Unknown site profile id(s) in AGENT_SITE_PROFILES: ${unknownIds.join(', ')}. ` +
            `Available: ${[...SITE_PROFILES.keys()].join(', ')}`,
        );
        return 2;
      }
      const policy = createPagePolicy(
        mergeSiteProfiles(config.siteProfileIds.map((id) => SITE_PROFILES.get(id)!)),
      );
      const sessions = new SessionManager({ profileDir: config.profileDir, policy, logger });
      const connection = new AgentConnection({
        gatewayWsUrl: config.gatewayWsUrl,
        gatewayHttpUrl: config.gatewayHttpUrl,
        identity,
        host: { sessions, logger, expectedPostalCode: config.ebayDestinationPostalCode },
        logger,
        heartbeatSeconds: config.heartbeatSeconds,
      });
      connection.start();
      logger.info(
        { agentVersion: AGENT_VERSION, deviceId: identity.deviceId, siteProfiles: config.siteProfileIds },
        'Agent running',
      );
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          logger.info({}, 'Shutting down');
          void connection.stop().then(() => sessions.close()).then(resolve);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
      return 0;
    }
    default:
      console.error('Usage: node apps\\windows-agent\\dist\\cli.js <pair|preflight|run> [flags]');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
