/**
 * Size-rotated NDJSON appender for call telemetry.
 *
 * Two properties matter more than completeness here. First, a telemetry
 * write must never fail a tool call: every filesystem operation is
 * wrapped, and the first failure retires the writer permanently rather
 * than re-attempting a doomed open on every subsequent call. Second, it
 * must never block one: lines are buffered in memory and flushed from an
 * unref'd timer, so the caller pays a string append and nothing else.
 *
 * Losing the tail of a log when a process exits without close() is an
 * acceptable trade for those two; this is a measurement aid, not an
 * audit trail (audit events go to the store, see @browser-bridge/audit).
 */
import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** 5 MiB per file, 5 files retained: ~25 MiB ceiling for a run's telemetry. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 5;
export const DEFAULT_FLUSH_INTERVAL_MS = 250;

export interface RotatingLogOptions {
  dir: string;
  fileName: string;
  maxFileBytes?: number;
  /** Retained files including the live one; 1 means never rotate, just truncate. */
  maxFiles?: number;
  flushIntervalMs?: number;
}

export class RotatingNdjsonLog {
  private readonly dir: string;
  private readonly fileName: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly flushIntervalMs: number;

  private pending: string[] = [];
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Tracked rather than stat()ed per line; only has to be close enough to rotate on time. */
  private liveBytes: number | null = null;
  private retired: string | null = null;

  constructor(options: RotatingLogOptions) {
    this.dir = options.dir;
    this.fileName = options.fileName;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Non-null once the log has given up, naming the failure that retired it. */
  get retiredReason(): string | null {
    return this.retired;
  }

  get path(): string {
    return join(this.dir, this.fileName);
  }

  append(line: string): void {
    if (this.retired !== null) return;
    this.pending.push(line);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Telemetry must not be the reason a process stays alive.
    this.timer.unref?.();
  }

  /** Drain the buffer. Safe to call concurrently; overlapping calls queue. */
  async flush(): Promise<void> {
    if (this.retired !== null) {
      this.pending = [];
      return;
    }
    const inFlight = this.flushing ?? Promise.resolve();
    this.flushing = inFlight.then(() => this.drain());
    return this.flushing;
  }

  async close(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0 || this.retired !== null) return;
    const batch = this.pending;
    this.pending = [];
    const payload = batch.join('');
    const payloadBytes = Buffer.byteLength(payload);
    try {
      if (this.liveBytes === null) {
        await mkdir(this.dir, { recursive: true });
        this.liveBytes = await this.currentSize();
      }
      // Rotate on the batch boundary: a single oversized batch overshoots
      // the cap once rather than being split, which keeps a JSON line whole.
      if (this.liveBytes > 0 && this.liveBytes + payloadBytes > this.maxFileBytes) {
        await this.rotate();
        this.liveBytes = 0;
      }
      await appendFile(this.path, payload, 'utf8');
      this.liveBytes += payloadBytes;
    } catch (err) {
      // Unwritable directory, full disk, revoked permission: stop trying.
      this.retired = err instanceof Error ? err.message : String(err);
      this.pending = [];
    }
  }

  private async currentSize(): Promise<number> {
    try {
      return (await stat(this.path)).size;
    } catch {
      return 0;
    }
  }

  private async rotate(): Promise<void> {
    if (this.maxFiles === 1) {
      await rm(this.path, { force: true });
      return;
    }
    // Oldest first, so nothing is overwritten before it has been shifted.
    await rm(`${this.path}.${this.maxFiles - 1}`, { force: true });
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      await this.renameIfPresent(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    await this.renameIfPresent(this.path, `${this.path}.1`);
  }

  private async renameIfPresent(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (err) {
      // ENOENT just means that generation does not exist yet.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
