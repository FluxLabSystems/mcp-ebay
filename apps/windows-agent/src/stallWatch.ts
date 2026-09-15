/**
 * Event-loop stall watch (2026-09-15, windows-agent+coverage_gap+agent-
 * stops-acknowledging-commands-mid-fire-then-disconnects, re-filed by the
 * wardrobe fire 10:0xZ): the agent went silent under the FIRST navigation
 * of a fresh session — no ack, no heartbeat, no frame of any kind for 80 s
 * with the socket OPEN — and then the socket dropped. An ack is sent
 * synchronously at the top of every command, so a missing ack means the
 * event loop itself was not turning. The gateway side of that episode is
 * legible since mcp-ebay#78 (AGENT_UNRESPONSIVE); the agent side was not:
 * the log said nothing about what it was doing when it stopped.
 *
 * This timer measures how late it fires. A tick that arrives more than
 * `thresholdMs` late means the loop was blocked for about that long, and
 * the warning names the last command the connection accepted before the
 * silence — the fact the next occurrence needs. It cannot prevent a stall
 * (nothing in-process can, while the loop is blocked); it makes the stall
 * observable from the agent's own log, which is what the report asked for.
 */
import type { Logger } from './logger.js';

export interface StallWatchOptions {
  logger: Logger;
  /** Timer period; default 1 s. */
  intervalMs?: number;
  /** Lateness that counts as a stall; default 5 s. */
  thresholdMs?: number;
  /** What the agent was doing: the last command accepted, if any. */
  context?: () => object | null;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface StallWatch {
  stop: () => void;
  /** Stalls observed so far (tests, dashboard). */
  readonly stalls: number;
}

export function startEventLoopStallWatch(options: StallWatchOptions): StallWatch {
  const intervalMs = options.intervalMs ?? 1_000;
  const thresholdMs = options.thresholdMs ?? 5_000;
  const now = options.now ?? Date.now;
  let expectedAt = now() + intervalMs;
  let stalls = 0;
  const timer = setInterval(() => {
    const at = now();
    const lateMs = at - expectedAt;
    expectedAt = at + intervalMs;
    if (lateMs < thresholdMs) return;
    stalls += 1;
    options.logger.warn(
      {
        blockedForMs: lateMs,
        thresholdMs,
        resumedAt: new Date(at).toISOString(),
        lastAcceptedCommand: options.context?.() ?? null,
      },
      'Event loop was blocked; the agent could not ack, heartbeat or answer during this window',
    );
  }, intervalMs);
  timer.unref?.();
  return {
    stop: () => clearInterval(timer),
    get stalls() {
      return stalls;
    },
  };
}
