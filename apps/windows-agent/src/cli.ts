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
 *   node apps\\windows-agent\\dist\\cli.js run [--no-ui] [--launched-by logon-task]
 *
 * `run` on a real console renders the live dashboard (tui.ts); redirected
 * output — and --no-ui — keeps the historical pino JSON stream on stdout.
 */
import { join } from 'node:path';
import { buildChromeLaunchPlan, preflightBrowser } from '@browser-bridge/browser-core';
import { loadAgentConfig, type AgentConfig } from '@browser-bridge/config';
import { mergeSiteProfiles, type SitePolicyProfile } from '@browser-bridge/policy';
import { BridgeError, IDEMPOTENCY_WINDOW_SECONDS } from '@browser-bridge/protocol';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { kijijiSiteProfile } from '@browser-bridge/site-kijiji';
import { wardrobeVendorsSiteProfile } from '@browser-bridge/site-vendors';
import { zazzleSiteProfile } from '@browser-bridge/site-zazzle';
import { RotatingNdjsonLog } from '@browser-bridge/telemetry';
import { AgentConnection } from './connection.js';
import { IdentityStore, type DeviceIdentity } from './identity.js';
import { BatchJobStore } from './jobs.js';
import { createLogger, type Logger } from './logger.js';
import { queryLogonTask } from './logonTask.js';
import { AgentStatusStore, buildConfigEntries, type LaunchedBy } from './monitor.js';
import { pairDevice } from './pairing.js';
import { createPagePolicy } from './policyEngine.js';
import { SessionManager } from './sessionManager.js';
import { AgentTui, detectCharset, queryDefaultTerminal, resolveUiMode } from './tui.js';
import { AGENT_VERSION } from './version.js';

/** Site profiles compiled into this agent build, keyed by versioned id. */
const SITE_PROFILES: ReadonlyMap<string, SitePolicyProfile> = new Map(
  [ebaySiteProfile, kijijiSiteProfile, zazzleSiteProfile, wardrobeVendorsSiteProfile].map((profile) => [
    profile.id,
    profile,
  ]),
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

interface Dashboard {
  store: AgentStatusStore;
  logger: Logger;
  jobs: BatchJobStore;
  start(sessions: SessionManager, onQuit: () => void): void;
  stop(): Promise<void>;
}

/**
 * Assemble the dashboard mode of `run`: the pino stream keeps its §26
 * redaction but lands in a rotating NDJSON file under the state dir (and
 * the on-screen tail) instead of painting over the UI, and background
 * samplers keep the tab list, batch jobs, and Task Scheduler pane fresh.
 */
function createDashboard(config: AgentConfig, identity: DeviceIdentity, launchedBy: LaunchedBy): Dashboard {
  const fileLog = new RotatingNdjsonLog({ dir: join(config.stateDir, 'logs'), fileName: 'agent-run.ndjson' });
  const store = new AgentStatusStore({
    info: {
      version: AGENT_VERSION,
      deviceId: identity.deviceId ?? 'unpaired',
      fingerprint: identity.fingerprint,
      keyStoreKind: identity.keyStoreKind,
      gatewayWsUrl: config.gatewayWsUrl,
      agentName: config.agentName,
      siteProfiles: config.siteProfileIds,
      launchedBy,
      taskName: config.taskName,
      logPath: fileLog.path,
      pid: process.pid,
      startedAt: Date.now(),
    },
    config: buildConfigEntries(config),
  });
  const logger = createLogger(config.logLevel, 'browser-bridge-agent', {
    write: (line: string) => {
      fileLog.append(line);
      store.recordLogLine(line);
    },
  });
  const jobs = new BatchJobStore({ retentionMs: IDEMPOTENCY_WINDOW_SECONDS * 1000 });
  let tui: AgentTui | null = null;
  const timers: NodeJS.Timeout[] = [];

  const probeTask = (): void => {
    void queryLogonTask(config.taskName).then((status) => store.updateTaskStatus(status));
  };

  return {
    store,
    logger,
    jobs,
    start(sessions: SessionManager, onQuit: () => void): void {
      // Resolve glyphs here rather than by env markers alone: a
      // Task-Scheduler-launched window has none, but the machine's
      // default-terminal setting still says whether Windows Terminal will
      // be the one drawing it.
      tui = new AgentTui({
        store,
        onQuit,
        onRefreshTask: probeTask,
        charset: detectCharset(process.env, process.platform, {
          preference: config.uiGlyphs,
          defaultTerminal: queryDefaultTerminal(),
        }),
      });
      tui.start();
      probeTask();
      const sampler = setInterval(() => {
        store.updateJobs(jobs.snapshotJobs());
        const session = sessions.listActive()[0];
        if (session === undefined) return;
        void session
          .listTabs()
          .then((tabs) =>
            store.updateTabs(tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title, active: tab.active }))),
          )
          .catch(() => {});
      }, 2000);
      sampler.unref?.();
      const taskTimer = setInterval(probeTask, 60_000);
      taskTimer.unref?.();
      timers.push(sampler, taskTimer);
    },
    async stop(): Promise<void> {
      for (const timer of timers) clearInterval(timer);
      tui?.stop();
      await fileLog.close();
    },
  };
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
      const unknownIds = config.siteProfileIds.filter((id) => !SITE_PROFILES.has(id));
      if (unknownIds.length > 0) {
        console.error(
          `Unknown site profile id(s) in AGENT_SITE_PROFILES: ${unknownIds.join(', ')}. ` +
            `Available: ${[...SITE_PROFILES.keys()].join(', ')}`,
        );
        return 2;
      }
      const uiMode = resolveUiMode(flags, process.stdout.isTTY === true);
      const launchedBy: LaunchedBy = flags.get('launched-by') === 'logon-task' ? 'logon-task' : 'interactive';
      const dashboard = uiMode === 'dashboard' ? createDashboard(config, identity, launchedBy) : null;
      const runLogger = dashboard?.logger ?? logger;
      if (process.platform !== 'win32') {
        runLogger.warn({}, 'Running on a non-Windows host: development/test mode only');
      }
      const policy = createPagePolicy(
        mergeSiteProfiles(config.siteProfileIds.map((id) => SITE_PROFILES.get(id)!)),
      );
      const sessions = new SessionManager({
        profileDir: config.profileDir,
        policy,
        logger: runLogger,
        ...(dashboard === null ? {} : { monitor: dashboard.store }),
      });
      const connection = new AgentConnection({
        gatewayWsUrl: config.gatewayWsUrl,
        gatewayHttpUrl: config.gatewayHttpUrl,
        identity,
        host: {
          sessions,
          logger: runLogger,
          expectedPostalCode: config.ebayDestinationPostalCode,
          ...(dashboard === null ? {} : { jobs: dashboard.jobs }),
        },
        logger: runLogger,
        heartbeatSeconds: config.heartbeatSeconds,
        ...(dashboard === null ? {} : { monitor: dashboard.store }),
      });
      connection.start();
      runLogger.info(
        { agentVersion: AGENT_VERSION, deviceId: identity.deviceId, siteProfiles: config.siteProfileIds },
        'Agent running',
      );
      await new Promise<void>((resolve) => {
        let shuttingDown = false;
        const shutdown = () => {
          // Idempotent: [q] on the dashboard and SIGINT/SIGTERM can race.
          if (shuttingDown) return;
          shuttingDown = true;
          runLogger.info({}, 'Shutting down');
          void connection.stop().then(() => sessions.close()).then(resolve);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
        dashboard?.start(sessions, shutdown);
      });
      if (dashboard !== null) {
        await dashboard.stop();
        console.log(`Agent stopped. JSON logs: ${join(config.stateDir, 'logs', 'agent-run.ndjson')}`);
      }
      return 0;
    }
    default:
      console.error(
        'Usage: node apps\\windows-agent\\dist\\cli.js <pair|preflight|run> [flags]\n' +
          '  run flags: --no-ui (plain JSON logs on stdout), --launched-by logon-task',
      );
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
