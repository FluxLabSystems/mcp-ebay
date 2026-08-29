/**
 * Agent-local batch job store — Phase 2 call-budget work, §18 (deadlines).
 *
 * A browser.extract_many batch that cannot finish inside one gateway
 * deadline becomes a job. The store lives here, on the agent, for the same
 * reason the executors do: this is the process that owns the browser, and a
 * job is a handle on work a single tab is still doing. Nothing about a job
 * is durable — an agent restart loses the browser too, so a job that
 * outlived its process would only ever be able to lie.
 *
 * The gateway routes a browser.job_status poll by browserSessionHandle
 * (apps/gateway/src/broker.ts call()), so the handle is part of a job's
 * identity here and a poll carrying the wrong one is a miss, not a leak.
 */
import { ulid } from '@browser-bridge/protocol';
import type { BatchExtractItem } from '@browser-bridge/protocol';

export type BatchJobStatus = 'running' | 'completed' | 'partial';

export interface BatchJob {
  jobId: string;
  browserSessionHandle: string;
  requested: number;
  compact: boolean;
  status: BatchJobStatus;
  results: BatchExtractItem[];
  warnings: string[];
  startedAt: number;
  finishedAt: number | null;
}

export interface BatchJobStoreOptions {
  /** How long a finished job stays readable; a poller has to be able to land. */
  retentionMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export function newJobId(): string {
  return `job_${ulid()}`;
}

export class BatchJobStore {
  private readonly jobs = new Map<string, BatchJob>();
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(options: BatchJobStoreOptions) {
    this.retentionMs = options.retentionMs;
    this.now = options.now ?? Date.now;
  }

  create(browserSessionHandle: string, requested: number, compact: boolean, warnings: string[] = []): BatchJob {
    this.prune();
    const job: BatchJob = {
      jobId: newJobId(),
      browserSessionHandle,
      requested,
      compact,
      status: 'running',
      results: [],
      warnings,
      startedAt: this.now(),
      finishedAt: null,
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  /**
   * Look a job up for a poll. The handle must match the one that created it:
   * job ids are unguessable, but a device that serves several sessions
   * should still never answer one session's poll from another's work.
   */
  get(jobId: string, browserSessionHandle: string): BatchJob | undefined {
    this.prune();
    const job = this.jobs.get(jobId);
    if (job === undefined || job.browserSessionHandle !== browserSessionHandle) return undefined;
    return job;
  }

  append(jobId: string, item: BatchExtractItem): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    job.results.push(item);
  }

  finish(jobId: string, status: Exclude<BatchJobStatus, 'running'>, warnings: string[] = []): void {
    const job = this.jobs.get(jobId);
    if (job === undefined) return;
    job.status = status;
    job.finishedAt = this.now();
    if (warnings.length > 0) job.warnings = [...job.warnings, ...warnings];
  }

  /** Finished jobs age out; a running job is never pruned out from under itself. */
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [jobId, job] of this.jobs) {
      if (job.finishedAt !== null && job.finishedAt < cutoff) this.jobs.delete(jobId);
    }
  }

  /** Test/diagnostic visibility only. */
  get size(): number {
    return this.jobs.size;
  }
}

/** Shape both browser.extract_many and browser.job_status return. */
export function jobProgress(job: BatchJob, sinceIndex = 0): Record<string, unknown> {
  const from = Math.min(Math.max(sinceIndex, 0), job.results.length);
  const slice = job.results.slice(from);
  return {
    mode: 'job',
    jobId: job.jobId,
    status: job.status,
    requested: job.requested,
    completed: job.results.length,
    succeeded: job.results.filter((item) => item.ok).length,
    failed: job.results.filter((item) => !item.ok).length,
    compact: job.compact,
    resultsFrom: from,
    results: slice,
    warnings: job.warnings,
  };
}
