/**
 * Per-call instrumentation for the MCP tool surface.
 *
 * The deals routine exhausts its per-turn tool-call budget before it ever
 * reaches dashboard_upsert, and "which call spent the budget" is not a
 * question the audit trail answers: audit records that a call happened,
 * not how many bytes it moved. This records the shape of each call —
 * name, argument size, response size, wall time, outcome — so a call
 * budget can be reasoned about from measurements instead of impressions.
 *
 * Values in, sizes out. A caller hands the recorder the actual argument
 * and response objects and gets back nothing; only their JSON byte counts
 * reach the log. That is deliberate: the alternative — asking every call
 * site to compute its own sizes — puts the raw values one typo away from
 * the log line, and §26's rule is that secrets never appear in logs.
 *
 * Off unless BRIDGE_TELEMETRY is set. A disabled recorder does not
 * serialize anything, so the production path pays one branch per call.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingNdjsonLog, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES } from './rotatingLog.js';

export { RotatingNdjsonLog, DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILES } from './rotatingLog.js';

export type CallOutcome = 'ok' | 'error' | 'denied';

/**
 * One tool call as the caller sees it. `args` and `response` are measured
 * and discarded; nothing derived from their contents is written.
 */
export interface ToolCallObservation {
  toolName: string;
  args: unknown;
  response: unknown;
  durationMs: number;
  outcome: CallOutcome;
  errorCode?: string | null;
  /** Correlation only: the browser session handle the call ran against. */
  sessionId?: string | null;
  requestId?: string | null;
}

/** One NDJSON line. Sizes and identifiers; no payload, no argument names. */
export interface ToolCallRecord {
  ts: string;
  runId: string;
  tool: string;
  argBytes: number | null;
  responseBytes: number | null;
  durationMs: number;
  outcome: CallOutcome;
  errorCode: string | null;
  sessionId: string | null;
  requestId: string | null;
}

export interface CallRecorder {
  readonly enabled: boolean;
  readonly runId: string;
  /** Path of the live log file, or null when disabled. */
  readonly logPath: string | null;
  record(observation: ToolCallObservation): void;
  close(): Promise<void>;
}

export interface CallRecorderOptions {
  enabled?: boolean;
  dir?: string;
  fileName?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  runId?: string;
  /** Injectable for tests. */
  now?: () => Date;
}

export const TELEMETRY_ENV = {
  enabled: 'BRIDGE_TELEMETRY',
  dir: 'BRIDGE_TELEMETRY_DIR',
  maxFileBytes: 'BRIDGE_TELEMETRY_MAX_BYTES',
  maxFiles: 'BRIDGE_TELEMETRY_MAX_FILES',
  runId: 'BRIDGE_TELEMETRY_RUN_ID',
} as const;

/** Outside the repo tree by default: telemetry must never land in a commit. */
export const DEFAULT_TELEMETRY_DIR = join(tmpdir(), 'browser-bridge-telemetry');
export const DEFAULT_TELEMETRY_FILE = 'tool-calls.ndjson';

/**
 * Identifiers are the only free-form strings that reach a log line, so
 * they are shape-checked rather than trusted: a caller cannot smuggle a
 * bearer token through sessionId, and an upstream error message pasted
 * into errorCode cannot drag a URL with a signature in it along.
 */
const SAFE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;

function safeIdentifier(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return SAFE_IDENTIFIER.test(value) ? value : '[unsafe]';
}

/**
 * JSON byte size of a value, or null when it has no JSON form (circular
 * references, BigInt). Null is a real answer here — "not measurable" is
 * information, and a zero would read as "empty".
 */
export function jsonByteLength(value: unknown): number | null {
  if (value === undefined) return 0;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? null : Buffer.byteLength(text, 'utf8');
  } catch {
    return null;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Enabled only by an explicit affirmative; anything else, including unset, is off. */
function parseEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

export function recorderOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): CallRecorderOptions {
  return {
    enabled: parseEnabled(env[TELEMETRY_ENV.enabled]),
    dir: env[TELEMETRY_ENV.dir] ?? DEFAULT_TELEMETRY_DIR,
    maxFileBytes: parsePositiveInt(env[TELEMETRY_ENV.maxFileBytes], DEFAULT_MAX_FILE_BYTES),
    maxFiles: parsePositiveInt(env[TELEMETRY_ENV.maxFiles], DEFAULT_MAX_FILES),
    ...(env[TELEMETRY_ENV.runId] === undefined ? {} : { runId: env[TELEMETRY_ENV.runId] }),
  };
}

const NOOP_RECORDER: CallRecorder = {
  enabled: false,
  runId: 'disabled',
  logPath: null,
  record: () => {},
  close: () => Promise.resolve(),
};

class NdjsonCallRecorder implements CallRecorder {
  readonly enabled = true;
  readonly runId: string;
  private readonly log: RotatingNdjsonLog;
  private readonly now: () => Date;

  constructor(options: CallRecorderOptions) {
    this.runId = safeIdentifier(options.runId) ?? `run_${Date.now().toString(36)}`;
    this.now = options.now ?? (() => new Date());
    this.log = new RotatingNdjsonLog({
      dir: options.dir ?? DEFAULT_TELEMETRY_DIR,
      fileName: options.fileName ?? DEFAULT_TELEMETRY_FILE,
      ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
      ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
    });
  }

  get logPath(): string {
    return this.log.path;
  }

  record(observation: ToolCallObservation): void {
    const line = buildRecord(observation, this.runId, this.now());
    this.log.append(`${JSON.stringify(line)}\n`);
  }

  close(): Promise<void> {
    return this.log.close();
  }
}

/** The record a given observation would produce; exported for tests and the measure harness. */
export function buildRecord(
  observation: ToolCallObservation,
  runId: string,
  now: Date = new Date(),
): ToolCallRecord {
  return {
    ts: now.toISOString(),
    runId,
    tool: safeIdentifier(observation.toolName) ?? '[unknown]',
    argBytes: jsonByteLength(observation.args),
    responseBytes: jsonByteLength(observation.response),
    durationMs: Math.round(observation.durationMs),
    outcome: observation.outcome,
    errorCode: safeIdentifier(observation.errorCode),
    sessionId: safeIdentifier(observation.sessionId),
    requestId: safeIdentifier(observation.requestId),
  };
}

/**
 * A recorder, or a no-op when telemetry is off. Callers hold the result
 * unconditionally and never branch on it themselves.
 */
export function createCallRecorder(options: CallRecorderOptions = {}): CallRecorder {
  if (options.enabled !== true) return NOOP_RECORDER;
  return new NdjsonCallRecorder(options);
}

export function createCallRecorderFromEnv(env: NodeJS.ProcessEnv = process.env): CallRecorder {
  return createCallRecorder(recorderOptionsFromEnv(env));
}
