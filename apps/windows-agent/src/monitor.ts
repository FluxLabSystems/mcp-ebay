/**
 * Live agent status model behind the console dashboard (tui.ts).
 *
 * The agent's stdout is not a protocol channel — MCP terminates at the
 * gateway and the device link is an outbound WebSocket — so the console is
 * free to be a UI. This module is the state that UI renders: connection
 * phase, in-flight and recent commands, browser/tab snapshot, batch jobs,
 * policy-block counters, and a bounded tail of the structured log stream.
 *
 * Producers (AgentConnection, SessionManager, the CLI) push events through
 * the narrow AgentMonitor interface; the store is the only consumer-facing
 * surface and hands out immutable snapshots. Everything here is plain data
 * with an injectable clock — the renderer stays a pure function of a
 * snapshot, which is what makes the dashboard testable without a terminal.
 */
import type { AgentEnvSchema, AgentConfig } from '@browser-bridge/config';

export type ConnectionPhase = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

export type CommandRowStatus = 'running' | 'ok' | 'error';

export interface CommandRow {
  requestId: string;
  command: string;
  status: CommandRowStatus;
  startedAt: number;
  durationMs: number | null;
  errorCode: string | null;
}

/** One parsed pino line. `fields` is already flattened to "k=v k=v" text. */
export interface LogRow {
  at: number;
  /** pino numeric level (10 trace … 60 fatal); unparseable lines become 30. */
  level: number;
  msg: string;
  fields: string;
}

export type PolicyBlockKind = 'request_aborted' | 'popup_denied' | 'download_blocked';

export interface SessionSnapshot {
  handle: string;
  profileName: string;
  degraded: boolean;
  tabs: TabSnapshot[];
}

export interface TabSnapshot {
  tabId: string;
  url: string;
  title: string;
  active: boolean;
}

export interface JobRow {
  jobId: string;
  status: 'running' | 'completed' | 'partial';
  requested: number;
  completed: number;
  failed: number;
  startedAt: number;
}

/** How this `run` process was started; the logon task passes --launched-by. */
export type LaunchedBy = 'interactive' | 'logon-task';

/** Result of probing Windows Task Scheduler for the logon task (logonTask.ts). */
export interface LogonTaskStatus {
  /** false on non-Windows hosts, where there is nothing to probe. */
  supported: boolean;
  installed: boolean;
  /** Task Scheduler state (Ready, Running, Disabled, …) when installed. */
  state: string | null;
  /** Last scheduled-run exit code; 0x80070002 here is the classic bad-path install. */
  lastTaskResult: number | null;
  checkedAt: number;
  /** Probe failure (PowerShell missing, timeout); distinct from "not installed". */
  error: string | null;
}

/** One effective configuration entry shown on the config screen. */
export interface ConfigEntry {
  key: string;
  value: string;
  source: 'env' | 'default';
}

/**
 * The dashboard's CONFIG screen: every AgentEnvSchema variable with its
 * effective value and whether the environment or the default supplied it.
 * The mapping is written out by hand so a renamed AgentConfig field is a
 * compile error here instead of a silently stale screen. Agent env holds
 * no secrets by design (tokens and OAuth live gateway-side, §25), so
 * effective values are safe to display.
 */
export function buildConfigEntries(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): ConfigEntry[] {
  const effective: Record<keyof typeof AgentEnvSchema.shape, string> = {
    AGENT_GATEWAY_URL: config.gatewayWsUrl,
    AGENT_PROFILE_DIR: config.profileDir,
    AGENT_STATE_DIR: config.stateDir,
    AGENT_NAME: config.agentName,
    AGENT_HEARTBEAT_SECONDS: String(config.heartbeatSeconds),
    LOG_LEVEL: config.logLevel,
    EBAY_DESTINATION_POSTAL_CODE: config.ebayDestinationPostalCode,
    AGENT_SITE_PROFILES: config.siteProfileIds.join(','),
    AGENT_TASK_NAME: config.taskName,
  };
  return (Object.keys(effective) as Array<keyof typeof effective>).map((key) => ({
    key,
    value: effective[key],
    source: env[key] === undefined ? 'default' : 'env',
  }));
}

export interface AgentStaticInfo {
  version: string;
  deviceId: string;
  fingerprint: string;
  keyStoreKind: string;
  gatewayWsUrl: string;
  agentName: string;
  siteProfiles: string[];
  launchedBy: LaunchedBy;
  taskName: string;
  /** Where the JSON log stream lands while the dashboard owns the console. */
  logPath: string | null;
  pid: number;
  startedAt: number;
}

export interface AgentStatusSnapshot {
  info: AgentStaticInfo;
  phase: ConnectionPhase;
  connectionId: string | null;
  reconnects: number;
  /** Delay the next reconnect attempt is waiting out, when phase = waiting. */
  retryDelayMs: number | null;
  lastGatewayActivityAt: number | null;
  totals: { ok: number; error: number };
  inFlight: number;
  /** Finished commands per minute over the last 60 s. */
  commandsPerMinute: number;
  /**
   * Finished-command counts per 15 s bucket over the last 10 minutes,
   * oldest first — the dashboard's activity sparkline.
   */
  activityBuckets: number[];
  commands: CommandRow[];
  logs: LogRow[];
  session: SessionSnapshot | null;
  jobs: JobRow[];
  policy: Record<PolicyBlockKind, number>;
  task: LogonTaskStatus | null;
  config: ConfigEntry[];
}

/**
 * Event sink the connection and session manager report into. Optional on
 * both — production without the dashboard and every existing test run with
 * no monitor and lose nothing.
 */
export interface AgentMonitor {
  connectionConnecting(url: string): void;
  connectionReady(connectionId: string): void;
  connectionLost(reason: string, retryDelayMs: number): void;
  connectionStopped(): void;
  /** Any frame from the gateway; drives the "rx …s ago" health readout. */
  gatewayActivity(): void;
  commandStarted(requestId: string, command: string): void;
  commandFinished(requestId: string, status: 'ok' | 'error', durationMs: number, errorCode: string | null): void;
  sessionOpened(handle: string, profileName: string): void;
  sessionClosed(): void;
  sessionDegraded(): void;
  policyBlocked(kind: PolicyBlockKind): void;
}

const MAX_LOG_ROWS = 400;
const MAX_COMMAND_ROWS = 120;
const MAX_FINISH_TIMESTAMPS = 600;
const ACTIVITY_BUCKET_MS = 15_000;
const ACTIVITY_BUCKETS = 40;

/** pino standard keys that are rendered structurally, not as k=v noise. */
const PINO_META_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg']);

function formatFieldValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Parse one pino NDJSON line into a display row. The line has already been
 * through pino's redaction, so nothing here needs to re-censor; a line that
 * is not JSON (e.g. a stray console.log from a dependency) is kept verbatim
 * rather than dropped — losing operator-visible output would be worse than
 * an unstyled row.
 */
export function parseLogLine(line: string, fallbackNow: number): LogRow | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const record = JSON.parse(trimmed) as Record<string, unknown>;
    const fields = Object.entries(record)
      .filter(([key]) => !PINO_META_KEYS.has(key))
      .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
      .join(' ');
    return {
      at: typeof record.time === 'number' ? record.time : fallbackNow,
      level: typeof record.level === 'number' ? record.level : 30,
      msg: typeof record.msg === 'string' ? record.msg : '',
      fields,
    };
  } catch {
    return { at: fallbackNow, level: 30, msg: trimmed, fields: '' };
  }
}

export interface AgentStatusStoreOptions {
  info: AgentStaticInfo;
  config?: ConfigEntry[];
  now?: () => number;
}

/**
 * Mutable status accumulator with change notification. Subscribers get a
 * plain "something changed" signal; they re-read via snapshot(). That keeps
 * producers decoupled from render timing — the TUI coalesces bursts into
 * one frame instead of drawing per event.
 */
export class AgentStatusStore implements AgentMonitor {
  private readonly info: AgentStaticInfo;
  private readonly config: ConfigEntry[];
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  private phase: ConnectionPhase = 'idle';
  private connectionId: string | null = null;
  private reconnects = 0;
  private retryDelayMs: number | null = null;
  private lastGatewayActivityAt: number | null = null;
  private totals = { ok: 0, error: 0 };
  private commands: CommandRow[] = [];
  private finishTimestamps: number[] = [];
  private logs: LogRow[] = [];
  private session: SessionSnapshot | null = null;
  private degraded = false;
  private jobs: JobRow[] = [];
  private policy: Record<PolicyBlockKind, number> = {
    request_aborted: 0,
    popup_denied: 0,
    download_blocked: 0,
  };
  private task: LogonTaskStatus | null = null;

  constructor(options: AgentStatusStoreOptions) {
    this.info = options.info;
    this.config = options.config ?? [];
    this.now = options.now ?? Date.now;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- AgentMonitor ----

  connectionConnecting(_url: string): void {
    this.phase = 'connecting';
    this.retryDelayMs = null;
    this.emit();
  }

  connectionReady(connectionId: string): void {
    this.phase = 'connected';
    this.connectionId = connectionId;
    this.retryDelayMs = null;
    this.emit();
  }

  connectionLost(_reason: string, retryDelayMs: number): void {
    if (this.phase === 'connected') this.reconnects += 1;
    this.phase = 'waiting';
    this.connectionId = null;
    this.retryDelayMs = retryDelayMs;
    this.emit();
  }

  connectionStopped(): void {
    this.phase = 'stopped';
    this.connectionId = null;
    this.emit();
  }

  gatewayActivity(): void {
    // No emit: this fires on every frame, and the 1 Hz repaint already
    // keeps the age readout honest.
    this.lastGatewayActivityAt = this.now();
  }

  commandStarted(requestId: string, command: string): void {
    this.commands.unshift({
      requestId,
      command,
      status: 'running',
      startedAt: this.now(),
      durationMs: null,
      errorCode: null,
    });
    if (this.commands.length > MAX_COMMAND_ROWS) this.commands.length = MAX_COMMAND_ROWS;
    this.emit();
  }

  commandFinished(requestId: string, status: 'ok' | 'error', durationMs: number, errorCode: string | null): void {
    const row = this.commands.find((entry) => entry.requestId === requestId);
    if (row !== undefined) {
      row.status = status;
      row.durationMs = durationMs;
      row.errorCode = errorCode;
    }
    this.totals[status] += 1;
    this.finishTimestamps.push(this.now());
    if (this.finishTimestamps.length > MAX_FINISH_TIMESTAMPS) {
      this.finishTimestamps.splice(0, this.finishTimestamps.length - MAX_FINISH_TIMESTAMPS);
    }
    this.emit();
  }

  sessionOpened(handle: string, profileName: string): void {
    this.session = { handle, profileName, degraded: this.degraded, tabs: this.session?.tabs ?? [] };
    this.emit();
  }

  sessionClosed(): void {
    this.session = null;
    this.emit();
  }

  sessionDegraded(): void {
    this.degraded = true;
    if (this.session !== null) this.session.degraded = true;
    this.emit();
  }

  policyBlocked(kind: PolicyBlockKind): void {
    this.policy[kind] += 1;
    this.emit();
  }

  // ---- sampled/pushed data outside the monitor interface ----

  /** Raw pino destination hook; the same line also lands in the NDJSON file. */
  recordLogLine(line: string): void {
    const row = parseLogLine(line, this.now());
    if (row === null) return;
    this.logs.push(row);
    if (this.logs.length > MAX_LOG_ROWS) this.logs.splice(0, this.logs.length - MAX_LOG_ROWS);
    this.emit();
  }

  updateTabs(tabs: TabSnapshot[]): void {
    if (this.session === null) return;
    this.session.tabs = tabs;
    this.emit();
  }

  updateJobs(jobs: JobRow[]): void {
    this.jobs = jobs;
    this.emit();
  }

  updateTaskStatus(status: LogonTaskStatus): void {
    this.task = status;
    this.emit();
  }

  /** [c]lear on the dashboard: history and counters, never identity/state. */
  clearHistory(): void {
    this.commands = [];
    this.logs = [];
    this.finishTimestamps = [];
    this.totals = { ok: 0, error: 0 };
    this.policy = { request_aborted: 0, popup_denied: 0, download_blocked: 0 };
    this.emit();
  }

  snapshot(): AgentStatusSnapshot {
    const now = this.now();
    const minuteAgo = now - 60_000;
    const buckets = new Array<number>(ACTIVITY_BUCKETS).fill(0);
    for (const at of this.finishTimestamps) {
      const index = ACTIVITY_BUCKETS - 1 - Math.floor((now - at) / ACTIVITY_BUCKET_MS);
      if (index >= 0 && index < ACTIVITY_BUCKETS) buckets[index] = buckets[index]! + 1;
    }
    return {
      info: this.info,
      phase: this.phase,
      connectionId: this.connectionId,
      reconnects: this.reconnects,
      retryDelayMs: this.retryDelayMs,
      lastGatewayActivityAt: this.lastGatewayActivityAt,
      totals: { ...this.totals },
      inFlight: this.commands.filter((row) => row.status === 'running').length,
      commandsPerMinute: this.finishTimestamps.filter((at) => at > minuteAgo).length,
      activityBuckets: buckets,
      commands: this.commands.map((row) => ({ ...row })),
      logs: this.logs.map((row) => ({ ...row })),
      session:
        this.session === null
          ? null
          : { ...this.session, tabs: this.session.tabs.map((tab) => ({ ...tab })) },
      jobs: this.jobs.map((job) => ({ ...job })),
      policy: { ...this.policy },
      task: this.task === null ? null : { ...this.task },
      config: this.config.map((entry) => ({ ...entry })),
    };
  }
}
