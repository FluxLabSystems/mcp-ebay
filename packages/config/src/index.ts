/**
 * Typed configuration contract — SDD v0.5 §25. Values come from the
 * environment; `deploy/env.example` documents placeholders. Production
 * requires the OAuth resource-server variables; a static bearer token or
 * query-string credential is never accepted.
 */
import * as z from 'zod/v4';
import {
  ARTIFACT_TTL_DEFAULT_SECONDS,
  ARTIFACT_TTL_MAX_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS,
  type DashboardId,
} from '@browser-bridge/protocol';

const httpsUrl = z
  .url()
  .refine((value) => value.startsWith('https://'), { message: 'must be an https:// URL' });

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

export const GatewayEnvSchema = z
  .object({
    NODE_ENV: z.enum(['production', 'development', 'test']).default('development'),
    PUBLIC_BASE_URL: z.url(),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1),
    /**
     * OAuth resource-server mode. Production MUST be 'required'. 'disabled'
     * exists only for local Inspector/SDK development and test harnesses.
     */
    OAUTH_MODE: z.enum(['required', 'disabled']).optional(),
    OAUTH_ISSUER: httpsUrl.optional(),
    OAUTH_AUDIENCE: z.string().min(1).optional(),
    OAUTH_JWKS_URI: httpsUrl.optional(),
    ARTIFACT_DIR: z.string().default('/var/lib/browser-bridge/artifacts'),
    ARTIFACT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(ARTIFACT_TTL_MAX_SECONDS)
      .default(ARTIFACT_TTL_DEFAULT_SECONDS),
    /** Secret for signing short-TTL artifact URLs; generated when absent (single-replica MVP). */
    ARTIFACT_URL_SECRET: z.string().min(16).optional(),
    DEVICE_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(120).default(HEARTBEAT_INTERVAL_SECONDS),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    EBAY_DESTINATION_POSTAL_CODE: z.string().default('M6H 2W9'),
    /**
     * §9: production accepts only MCP-Protocol-Version 2026-07-28 unless
     * compatibility is explicitly enabled by configuration.
     */
    MCP_LEGACY_COMPATIBILITY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    /** Extra Host header values accepted besides the PUBLIC_BASE_URL host. */
    EXTRA_ALLOWED_HOSTS: z.string().default(''),
    /** Tool calls per minute per OAuth client on /mcp; 0 disables (audit F-05). */
    RATE_LIMIT_MCP_PER_MINUTE: z.coerce.number().int().min(0).max(100000).default(120),
    /** Pairing attempts per minute per remote address; 0 disables. */
    RATE_LIMIT_PAIR_PER_MINUTE: z.coerce.number().int().min(0).max(1000).default(10),
    /**
     * Fluxology dashboard-api root (serves /v1/{scope}/feed|upsert). When
     * unset the dashboard.* tools are not registered. Plain http is fine on
     * the internal docker network; https for a public hostname.
     */
    DASHBOARD_API_BASE_URL: z.url().optional(),
    /** Per-dashboard ingest tokens; dashboard.upsert requires the matching one. */
    DEALS_INGEST_TOKEN: z.string().min(1).optional(),
    OFFICE_INGEST_TOKEN: z.string().min(1).optional(),
    JOBS_INGEST_TOKEN: z.string().min(1).optional(),
    VACATION_INGEST_TOKEN: z.string().min(1).optional(),
    WARDROBE_INGEST_TOKEN: z.string().min(1).optional(),
  })
  .check((ctx) => {
    const env = ctx.value;
    const mode = env.OAUTH_MODE ?? (env.NODE_ENV === 'production' ? 'required' : 'disabled');
    if (env.NODE_ENV === 'production' && mode !== 'required') {
      ctx.issues.push({
        code: 'custom',
        message: 'OAUTH_MODE must be "required" in production (SDD §10)',
        input: env,
        path: ['OAUTH_MODE'],
      });
    }
    if (mode === 'required') {
      for (const key of ['OAUTH_ISSUER', 'OAUTH_AUDIENCE', 'OAUTH_JWKS_URI'] as const) {
        if (env[key] === undefined) {
          ctx.issues.push({
            code: 'custom',
            message: `${key} is required when OAuth is enabled (SDD §10.1, §25)`,
            input: env,
            path: [key],
          });
        }
      }
    }
    // Audit F-19: a per-boot random secret would invalidate signed artifact
    // URLs on every restart; production must pin one.
    if (env.NODE_ENV === 'production' && env.ARTIFACT_URL_SECRET === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'ARTIFACT_URL_SECRET is required in production (signed artifact URLs must survive restarts)',
        input: env,
        path: ['ARTIFACT_URL_SECRET'],
      });
    }
    // A configured ingest token with no API base URL is a misconfiguration
    // that would otherwise fail silently (tools simply absent).
    const anyIngestToken =
      env.DEALS_INGEST_TOKEN !== undefined ||
      env.OFFICE_INGEST_TOKEN !== undefined ||
      env.JOBS_INGEST_TOKEN !== undefined ||
      env.VACATION_INGEST_TOKEN !== undefined ||
      env.WARDROBE_INGEST_TOKEN !== undefined;
    if (anyIngestToken && env.DASHBOARD_API_BASE_URL === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'DASHBOARD_API_BASE_URL is required when any *_INGEST_TOKEN is set',
        input: env,
        path: ['DASHBOARD_API_BASE_URL'],
      });
    }
  });

export interface GatewayConfig {
  nodeEnv: 'production' | 'development' | 'test';
  publicBaseUrl: URL;
  port: number;
  databaseUrl: string;
  oauth:
    | { mode: 'required'; issuer: string; audience: string; jwksUri: string }
    | { mode: 'disabled' };
  artifactDir: string;
  artifactTtlSeconds: number;
  artifactUrlSecret: string | undefined;
  deviceHeartbeatSeconds: number;
  logLevel: (typeof LOG_LEVELS)[number];
  ebayDestinationPostalCode: string;
  mcpLegacyCompatibility: boolean;
  allowedHosts: string[];
  rateLimitMcpPerMinute: number;
  rateLimitPairPerMinute: number;
  /** Fluxology dashboard write-path; null when DASHBOARD_API_BASE_URL is unset. */
  dashboards: {
    baseUrl: string;
    /**
     * Derived from DASHBOARD_IDS rather than written out by hand: this was a
     * literal listing deals/office/jobs, and it silently went stale when the
     * vacation dashboard shipped — the token reached the object at run time
     * but never existed on the declared type, so anything reading it through
     * GatewayConfig failed to compile. Keyed off the id list, it cannot drift
     * again.
     */
    tokens: Partial<Record<DashboardId, string>>;
  } | null;
}

export function loadGatewayConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const parsed = GatewayEnvSchema.parse(env);
  const publicBaseUrl = new URL(parsed.PUBLIC_BASE_URL);
  const mode = parsed.OAUTH_MODE ?? (parsed.NODE_ENV === 'production' ? 'required' : 'disabled');
  const extraHosts = parsed.EXTRA_ALLOWED_HOSTS.split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return {
    nodeEnv: parsed.NODE_ENV,
    publicBaseUrl,
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    oauth:
      mode === 'required'
        ? {
            mode,
            issuer: parsed.OAUTH_ISSUER!,
            audience: parsed.OAUTH_AUDIENCE!,
            jwksUri: parsed.OAUTH_JWKS_URI!,
          }
        : { mode: 'disabled' },
    artifactDir: parsed.ARTIFACT_DIR,
    artifactTtlSeconds: parsed.ARTIFACT_TTL_SECONDS,
    artifactUrlSecret: parsed.ARTIFACT_URL_SECRET,
    deviceHeartbeatSeconds: parsed.DEVICE_HEARTBEAT_SECONDS,
    logLevel: parsed.LOG_LEVEL,
    ebayDestinationPostalCode: parsed.EBAY_DESTINATION_POSTAL_CODE,
    mcpLegacyCompatibility: parsed.MCP_LEGACY_COMPATIBILITY,
    rateLimitMcpPerMinute: parsed.RATE_LIMIT_MCP_PER_MINUTE,
    rateLimitPairPerMinute: parsed.RATE_LIMIT_PAIR_PER_MINUTE,
    dashboards:
      parsed.DASHBOARD_API_BASE_URL === undefined
        ? null
        : {
            baseUrl: parsed.DASHBOARD_API_BASE_URL.replace(/\/+$/, ''),
            tokens: {
              ...(parsed.DEALS_INGEST_TOKEN === undefined ? {} : { deals: parsed.DEALS_INGEST_TOKEN }),
              ...(parsed.OFFICE_INGEST_TOKEN === undefined ? {} : { office: parsed.OFFICE_INGEST_TOKEN }),
              ...(parsed.JOBS_INGEST_TOKEN === undefined ? {} : { jobs: parsed.JOBS_INGEST_TOKEN }),
              ...(parsed.VACATION_INGEST_TOKEN === undefined ? {} : { vacation: parsed.VACATION_INGEST_TOKEN }),
              ...(parsed.WARDROBE_INGEST_TOKEN === undefined ? {} : { wardrobe: parsed.WARDROBE_INGEST_TOKEN }),
            },
          },
    allowedHosts: [
      publicBaseUrl.hostname,
      'browser-mcp-gateway',
      'localhost',
      '127.0.0.1',
      ...extraHosts,
    ],
  };
}

/** Default per-user logon task name; install-logon-task.ps1's -TaskName default. */
export const DEFAULT_LOGON_TASK_NAME = 'FluxologyBrowserBridgeAgent';

export const AgentEnvSchema = z.object({
  AGENT_GATEWAY_URL: z
    .url()
    .refine((value) => value.startsWith('wss://') || value.startsWith('ws://'), {
      message: 'must be a ws:// or wss:// URL',
    }),
  /** Dedicated Chrome automation profile dir; %LOCALAPPDATA% default applied on Windows. */
  AGENT_PROFILE_DIR: z.string().optional(),
  AGENT_STATE_DIR: z.string().optional(),
  AGENT_NAME: z.string().default('windows-browser-agent'),
  /** WSS heartbeat cadence; keep aligned with the gateway's DEVICE_HEARTBEAT_SECONDS (audit F-15). */
  AGENT_HEARTBEAT_SECONDS: z.coerce.number().int().min(5).max(120).default(HEARTBEAT_INTERVAL_SECONDS),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  /** Fallback destination when a command envelope does not carry one (audit F-09). */
  EBAY_DESTINATION_POSTAL_CODE: z.string().default('M6H 2W9'),
  /**
   * Comma-separated versioned site-profile ids the agent enables. The
   * default enables every profile compiled into the agent; narrow it to
   * e.g. "ebay.ca.v1" to pin a session to one marketplace.
   */
  AGENT_SITE_PROFILES: z.string().default('ebay.ca.v1,kijiji.ca.v1'),
  /**
   * Scheduled-task name the console dashboard probes for install/run state.
   * Override only when install-logon-task.ps1 was run with -TaskName.
   */
  AGENT_TASK_NAME: z.string().min(1).default(DEFAULT_LOGON_TASK_NAME),
});

export interface AgentConfig {
  gatewayWsUrl: string;
  /** HTTPS base derived from the WS URL for /agent/pair and artifact uploads. */
  gatewayHttpUrl: string;
  profileDir: string;
  stateDir: string;
  agentName: string;
  heartbeatSeconds: number;
  logLevel: (typeof LOG_LEVELS)[number];
  ebayDestinationPostalCode: string;
  /** Ordered, deduplicated site-profile ids from AGENT_SITE_PROFILES. */
  siteProfileIds: string[];
  /** Windows scheduled-task name the dashboard's TASK pane probes. */
  taskName: string;
}

export const DEFAULT_PROFILE_LEAF = ['Fluxology', 'BrowserBridge', 'profiles', 'ebay-research'] as const;
export const DEFAULT_STATE_LEAF = ['Fluxology', 'BrowserBridge', 'state'] as const;

function joinPath(base: string, parts: readonly string[], sep: string): string {
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

/**
 * Default agent directories. On Windows they live under %LOCALAPPDATA%
 * (§4, §13); elsewhere (development/test only) under ~/.local/share.
 */
export function defaultAgentDirs(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): { profileDir: string; stateDir: string } {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? 'C:\\Users\\Default\\AppData\\Local';
    return {
      profileDir: joinPath(localAppData, DEFAULT_PROFILE_LEAF, '\\'),
      stateDir: joinPath(localAppData, DEFAULT_STATE_LEAF, '\\'),
    };
  }
  const home = env.HOME ?? '/tmp';
  const base = `${home}/.local/share`;
  return {
    profileDir: joinPath(base, DEFAULT_PROFILE_LEAF, '/'),
    stateDir: joinPath(base, DEFAULT_STATE_LEAF, '/'),
  };
}

export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentConfig {
  const parsed = AgentEnvSchema.parse(env);
  const defaults = defaultAgentDirs(platform, env);
  const ws = new URL(parsed.AGENT_GATEWAY_URL);
  const httpProtocol = ws.protocol === 'wss:' ? 'https:' : 'http:';
  const httpBase = `${httpProtocol}//${ws.host}`;
  const siteProfileIds = [
    ...new Set(
      parsed.AGENT_SITE_PROFILES.split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  ];
  if (siteProfileIds.length === 0) {
    throw new Error('AGENT_SITE_PROFILES must name at least one site profile id');
  }
  return {
    gatewayWsUrl: parsed.AGENT_GATEWAY_URL,
    gatewayHttpUrl: httpBase,
    profileDir: parsed.AGENT_PROFILE_DIR ?? defaults.profileDir,
    stateDir: parsed.AGENT_STATE_DIR ?? defaults.stateDir,
    agentName: parsed.AGENT_NAME,
    heartbeatSeconds: parsed.AGENT_HEARTBEAT_SECONDS,
    logLevel: parsed.LOG_LEVEL,
    ebayDestinationPostalCode: parsed.EBAY_DESTINATION_POSTAL_CODE,
    siteProfileIds,
    taskName: parsed.AGENT_TASK_NAME,
  };
}
