/**
 * Browser launch plans, no-fallback preflight, and profile locking —
 * SDD v0.5 §13. MVP controls the user-provisioned branded Google Chrome
 * through Playwright channel `chrome` with a dedicated persistent
 * automation user-data directory. Edge, bundled Chromium, Firefox, and
 * WebKit are never substituted; a failed `chrome` launch is
 * BROWSER_UNAVAILABLE.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type LaunchOptions } from 'playwright';
import { BridgeError } from '@browser-bridge/protocol';

export interface BrowserLaunchPlan {
  /** Dedicated automation user-data directory (never Chrome's main profile). */
  userDataDir: string;
  /** Frozen to 'chrome' for production plans (§4, §13). */
  channel: 'chrome' | undefined;
  headless: boolean;
  acceptDownloads: true;
  viewport: null;
  /**
   * TEST-ONLY: explicit browser binary for CI/container fixtures. Never set
   * by production plan builders and rejected unless testOnly is true.
   */
  executablePath?: string;
  /** Marks a plan produced by buildTestLaunchPlan. */
  testOnly?: boolean;
}

/**
 * The one production plan. Channel is a literal here on purpose: no
 * configuration surface can change the browser family (§13 "frozen").
 */
export function buildChromeLaunchPlan(userDataDir: string): BrowserLaunchPlan {
  return {
    userDataDir,
    channel: 'chrome',
    headless: false,
    acceptDownloads: true,
    viewport: null,
  };
}

/**
 * TEST-ONLY plan for integration tests running against a local test
 * browser build (bundled Chromium or an explicit executable). Not
 * reachable from agent configuration; production always uses
 * buildChromeLaunchPlan (channel "chrome").
 */
export function buildTestLaunchPlan(userDataDir: string, executablePath?: string): BrowserLaunchPlan {
  return {
    userDataDir,
    channel: undefined,
    headless: true,
    acceptDownloads: true,
    viewport: null,
    ...(executablePath === undefined ? {} : { executablePath }),
    testOnly: true,
  };
}

export type PersistentContextLauncher = (
  userDataDir: string,
  options: LaunchOptions & {
    acceptDownloads?: boolean;
    viewport?: null;
  },
) => Promise<BrowserContext>;

export const defaultLauncher: PersistentContextLauncher = (userDataDir, options) =>
  chromium.launchPersistentContext(userDataDir, options);

/** Error text fragments that identify a missing/broken branded Chrome install. */
const CHROME_MISSING_MARKERS = [
  'chrome distribution',
  "distribution 'chrome'",
  'distribution "chrome"',
  "channel 'chrome'",
  'channel "chrome"',
  'executable doesn’t exist',
  "executable doesn't exist",
  'failed to launch',
  'enoent',
  'cannot find',
  'no usable sandbox',
];

export function toBrowserUnavailable(err: unknown): BridgeError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const chromeMissing = CHROME_MISSING_MARKERS.some((marker) => lower.includes(marker));
  return new BridgeError(
    'BROWSER_UNAVAILABLE',
    chromeMissing
      ? `Branded Google Chrome (Playwright channel "chrome") could not be launched: ${message}. ` +
        'Install/repair the provisioned Google Chrome Stable installation; the agent never falls back to Edge, bundled Chromium, Firefox, or WebKit.'
      : `Browser context could not be launched: ${message}`,
    { cause: message },
  );
}

export async function launchPersistent(
  plan: BrowserLaunchPlan,
  launcher: PersistentContextLauncher = defaultLauncher,
): Promise<BrowserContext> {
  if (plan.executablePath !== undefined && plan.testOnly !== true) {
    throw new BridgeError(
      'BROWSER_UNAVAILABLE',
      'executablePath overrides are test-only; production launches use Playwright channel "chrome".',
    );
  }
  mkdirSync(plan.userDataDir, { recursive: true });
  try {
    return await launcher(plan.userDataDir, {
      ...(plan.channel !== undefined ? { channel: plan.channel } : {}),
      ...(plan.executablePath !== undefined ? { executablePath: plan.executablePath } : {}),
      headless: plan.headless,
      acceptDownloads: plan.acceptDownloads,
      viewport: plan.viewport,
    });
  } catch (err) {
    throw toBrowserUnavailable(err);
  }
}

/**
 * Preflight (§13, §30): verify the branded Chrome channel launches, then
 * close. Fails closed with BROWSER_UNAVAILABLE; performs no fallback and
 * never invokes Playwright browser installation.
 */
export async function preflightBrowser(
  plan: BrowserLaunchPlan,
  launcher: PersistentContextLauncher = defaultLauncher,
): Promise<{ ok: true }> {
  const lock = acquireProfileLock(plan.userDataDir);
  try {
    const context = await launchPersistent(plan, launcher);
    await context.close();
    return { ok: true };
  } finally {
    lock.release();
  }
}

export interface ProfileLock {
  release: () => void;
  lockFilePath: string;
}

export const PROFILE_LOCK_FILENAME = '.browser-bridge.lock';

/**
 * How often a held lock rewrites its heartbeat, and how old a heartbeat may
 * be before the owner is presumed unable to refresh it (hung, or the pid
 * belongs to some other program by now). Ten heartbeats of slack: a healthy
 * agent under load refreshes every 30 s; one whose event loop has been
 * blocked for five minutes is not serving the profile whatever its pid says.
 */
export const PROFILE_LOCK_HEARTBEAT_MS = 30_000;
export const PROFILE_LOCK_STALE_AFTER_MS = 5 * 60_000;

/**
 * Random per-process id written into every lock this process takes. A pid
 * is not an identity: Windows hands a dead process's pid to the next
 * process that asks, so "pid alive" proved nothing about WHO holds the
 * lock — and "pid === process.pid" could not tell our own earlier
 * acquisition from a reused number.
 */
export const PROFILE_LOCK_INSTANCE_ID = randomUUID();

interface LockPayload {
  pid: number;
  hostname: string;
  acquiredAt: string;
  /** Absent on locks written by agents before 2026-09-15. */
  instanceId?: string;
  /** Refreshed every PROFILE_LOCK_HEARTBEAT_MS while held; absent on older locks. */
  heartbeatAt?: string;
}

export type LockOwnerLiveness = 'alive' | 'dead' | 'unknown';

export type ProfileLockVerdict =
  | 'no_lock'
  | 'unreadable'
  | 'self'
  | 'foreign_host'
  | 'owner_dead'
  | 'pid_reused'
  | 'owner_silent'
  | 'owner_live';

/**
 * What the lock file says about its owner, read without touching it. This
 * is the join PROFILE_IN_USE carries since 2026-09-15 (deals fire 10:0xZ,
 * windows-agent+coverage_gap+stale-profile-lock-blocks-the-signed-in-ebay-
 * research-profile-after-an-agent-reconnect; wardrobe and office fires the
 * same day, windows-agent+connector_defect+agent-death-leaves-stale-profile-
 * lock-so-browser-session-open-fails-profile-in-use): three routine profiles
 * refused PROFILE_IN_USE for four hours after one agent death, with only a
 * lockFilePath to show for it, and neither the routine nor the operator could
 * tell "another routine is using it right now" from "the lock outlived its
 * process".
 */
export interface ProfileLockInspection {
  lockFilePath: string;
  verdict: ProfileLockVerdict;
  /** True when the verdict lets a new owner take the lock. */
  stale: boolean;
  lockOwnerPid: number | null;
  lockOwnerHostname: string | null;
  lockAcquiredAt: string | null;
  lockHeartbeatAt: string | null;
  /** Age of the freshest timestamp the lock carries (heartbeatAt, else acquiredAt). */
  lockHeartbeatAgeMs: number | null;
  /** Liveness of the owning pid on THIS host; 'unknown' for a foreign host or a pid we may not probe (EPERM). */
  lockOwnerAlive: LockOwnerLiveness;
  ownerIsThisProcess: boolean;
}

export type PidProbe = (pid: number) => LockOwnerLiveness;

/** process.kill(pid, 0): ESRCH means gone; EPERM means it exists but is not ours to signal. */
export const defaultPidProbe: PidProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
};

export interface ProfileLockOptions {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable pid liveness probe (tests). */
  probe?: PidProbe;
  /** Heartbeat period; 0 disables the timer (tests, preflight). */
  heartbeatMs?: number;
  /** Staleness threshold for a silent owner. */
  staleAfterMs?: number;
  /** Called once when an existing lock is reclaimed, with what it said. */
  onReclaim?: (inspection: ProfileLockInspection) => void;
}

function readLockPayload(lockFilePath: string): LockPayload | null | 'unreadable' {
  let raw: string;
  try {
    raw = readFileSync(lockFilePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid !== 'number' || typeof parsed.hostname !== 'string') return 'unreadable';
    return parsed as LockPayload;
  } catch {
    return 'unreadable';
  }
}

export function inspectProfileLock(profileDir: string, options: ProfileLockOptions = {}): ProfileLockInspection {
  const lockFilePath = join(profileDir, PROFILE_LOCK_FILENAME);
  const now = options.now ?? Date.now;
  const probe = options.probe ?? defaultPidProbe;
  const staleAfterMs = options.staleAfterMs ?? PROFILE_LOCK_STALE_AFTER_MS;
  const base: Omit<ProfileLockInspection, 'verdict' | 'stale'> = {
    lockFilePath,
    lockOwnerPid: null,
    lockOwnerHostname: null,
    lockAcquiredAt: null,
    lockHeartbeatAt: null,
    lockHeartbeatAgeMs: null,
    lockOwnerAlive: 'unknown',
    ownerIsThisProcess: false,
  };
  const payload = readLockPayload(lockFilePath);
  if (payload === null) return { ...base, verdict: 'no_lock', stale: true };
  if (payload === 'unreadable') return { ...base, verdict: 'unreadable', stale: true };

  const freshest = payload.heartbeatAt ?? payload.acquiredAt ?? null;
  const freshestMs = freshest === null ? Number.NaN : Date.parse(freshest);
  const heartbeatAgeMs = Number.isFinite(freshestMs) ? Math.max(0, now() - freshestMs) : null;
  const facts: Omit<ProfileLockInspection, 'verdict' | 'stale'> = {
    ...base,
    lockOwnerPid: payload.pid,
    lockOwnerHostname: payload.hostname,
    lockAcquiredAt: payload.acquiredAt ?? null,
    lockHeartbeatAt: payload.heartbeatAt ?? null,
    lockHeartbeatAgeMs: heartbeatAgeMs,
  };

  if (payload.hostname !== hostname()) {
    // A lock from another machine (synced or copied profile dir): the LOCAL
    // process table can prove nothing about that owner's liveness, so this
    // fails closed — the payload records hostname for exactly this
    // comparison. (Before 2026-09-05 the pid was probed locally anyway,
    // which "worked" on Linux only because pid 1 always exists there and
    // reclaimed foreign locks on Windows, where it usually does not.)
    return { ...facts, verdict: 'foreign_host', stale: false };
  }
  if (payload.pid === process.pid) {
    if (payload.instanceId === undefined || payload.instanceId === PROFILE_LOCK_INSTANCE_ID) {
      // Our own earlier acquisition in-process (re-entrant). A lock with no
      // instanceId and our pid is treated the same way: it predates the id
      // and no other live process can share our pid.
      return { ...facts, lockOwnerAlive: 'alive', ownerIsThisProcess: true, verdict: 'self', stale: true };
    }
    // Our pid, somebody else's instance id: the number was recycled onto us
    // after its owner died. Nothing is holding this profile.
    return { ...facts, lockOwnerAlive: 'dead', verdict: 'pid_reused', stale: true };
  }
  const liveness = probe(payload.pid);
  if (liveness === 'dead') return { ...facts, lockOwnerAlive: 'dead', verdict: 'owner_dead', stale: true };
  // Alive, or a process we may not signal: the pid proves nothing about
  // whether the OWNER still serves the profile — a hung agent stays alive
  // and a recycled pid is alive as something else. The heartbeat does: a
  // lock nobody has refreshed inside the threshold is reclaimed.
  if (heartbeatAgeMs === null || heartbeatAgeMs > staleAfterMs) {
    return { ...facts, lockOwnerAlive: liveness, verdict: 'owner_silent', stale: true };
  }
  return { ...facts, lockOwnerAlive: liveness, verdict: 'owner_live', stale: false };
}

function profileInUse(inspection: ProfileLockInspection): BridgeError {
  const hint =
    inspection.verdict === 'foreign_host'
      ? `The lock was written on host ${inspection.lockOwnerHostname ?? '?'}, not this one; the local process table cannot vouch for it. Remove ${inspection.lockFilePath} on the desktop if that owner is gone.`
      : `Process ${inspection.lockOwnerPid ?? '?'} on this host refreshed the lock ${
          inspection.lockHeartbeatAgeMs === null ? 'at an unknown time' : `${Math.round(inspection.lockHeartbeatAgeMs / 1000)} s ago`
        } and is ${inspection.lockOwnerAlive === 'alive' ? 'alive' : 'not one this agent may probe'}: another agent process is serving this profile right now. A lock its owner stops refreshing for ${Math.round(PROFILE_LOCK_STALE_AFTER_MS / 60_000)} minutes is reclaimed on the next open.`;
  return new BridgeError('PROFILE_IN_USE', undefined, {
    lockFilePath: inspection.lockFilePath,
    lockOwnerPid: inspection.lockOwnerPid,
    lockOwnerHostname: inspection.lockOwnerHostname,
    lockAcquiredAt: inspection.lockAcquiredAt,
    lockHeartbeatAt: inspection.lockHeartbeatAt,
    lockHeartbeatAgeMs: inspection.lockHeartbeatAgeMs,
    lockOwnerAlive: inspection.lockOwnerAlive,
    ownerIsThisProcess: inspection.ownerIsThisProcess,
    reason: inspection.verdict,
    staleAfterMs: PROFILE_LOCK_STALE_AFTER_MS,
    hint,
  });
}

/** Atomic rewrite: a reader never sees a torn payload (which would read as 'unreadable' → reclaimable). */
function writeLockAtomically(lockFilePath: string, payload: LockPayload): void {
  const tmp = `${lockFilePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, lockFilePath);
}

/**
 * Exclusive profile ownership (§13): exactly one browser process may own
 * the profile directory. Implemented as an O_EXCL lock file with liveness
 * checking — the portable equivalent of a named OS mutex for a per-user
 * Node agent. A live owner that is still refreshing the lock's heartbeat
 * means PROFILE_IN_USE, with the owner's facts in the error details; a dead
 * owner, a recycled pid, a foreign instance on our pid, or an owner silent
 * past PROFILE_LOCK_STALE_AFTER_MS is reclaimed (2026-09-15: before this,
 * only a pid that answered ESRCH was reclaimed, so one agent death whose
 * pid Windows reused — or a hung agent that stayed alive — locked every
 * routine profile on the device until a human deleted the files).
 */
export function acquireProfileLock(profileDir: string, options: ProfileLockOptions = {}): ProfileLock {
  mkdirSync(profileDir, { recursive: true });
  const lockFilePath = join(profileDir, PROFILE_LOCK_FILENAME);
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? PROFILE_LOCK_HEARTBEAT_MS;
  const payload = (): LockPayload => ({
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date(now()).toISOString(),
    instanceId: PROFILE_LOCK_INSTANCE_ID,
    heartbeatAt: new Date(now()).toISOString(),
  });

  const tryWrite = (): boolean => {
    try {
      writeFileSync(lockFilePath, JSON.stringify(payload()), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryWrite()) {
    const inspection = inspectProfileLock(profileDir, options);
    if (!inspection.stale) throw profileInUse(inspection);
    if (inspection.verdict !== 'self' && inspection.verdict !== 'no_lock') options.onReclaim?.(inspection);
    rmSync(lockFilePath, { force: true });
    if (!tryWrite()) {
      throw profileInUse(inspectProfileLock(profileDir, options));
    }
  }

  const ownsLock = (): boolean => {
    const current = readLockPayload(lockFilePath);
    if (current === null || current === 'unreadable') return false;
    return current.pid === process.pid && (current.instanceId ?? PROFILE_LOCK_INSTANCE_ID) === PROFILE_LOCK_INSTANCE_ID;
  };

  let heartbeat: NodeJS.Timeout | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      try {
        if (!ownsLock()) return;
        const current = readLockPayload(lockFilePath) as LockPayload;
        writeLockAtomically(lockFilePath, { ...current, heartbeatAt: new Date(now()).toISOString() });
      } catch {
        // A failed refresh is not fatal; the next tick tries again and a
        // lock left unrefreshed is exactly what the staleness rule is for.
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  return {
    lockFilePath,
    release: () => {
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
      try {
        if (ownsLock()) rmSync(lockFilePath, { force: true });
      } catch {
        // already gone
      }
    },
  };
}

export interface ProfileLockSweepEntry {
  profileDir: string;
  inspection: ProfileLockInspection;
  action: 'removed' | 'kept' | 'none';
}

/**
 * Agent-startup sweep: inspect every profile directory this agent could
 * open and delete the locks whose owner is gone or silent, so a restart of
 * the agent is enough to recover from its own crash — a crashed agent never
 * runs release(), and its locks name a pid that may by now be alive as
 * something else. Live, heartbeating owners (another agent instance still
 * running) and foreign-host locks are kept, and the caller logs each entry.
 */
export function sweepStaleProfileLocks(profileDirs: readonly string[], options: ProfileLockOptions = {}): ProfileLockSweepEntry[] {
  const out: ProfileLockSweepEntry[] = [];
  for (const profileDir of profileDirs) {
    const inspection = inspectProfileLock(profileDir, options);
    if (inspection.verdict === 'no_lock') {
      out.push({ profileDir, inspection, action: 'none' });
      continue;
    }
    if (!inspection.stale || inspection.verdict === 'self') {
      out.push({ profileDir, inspection, action: 'kept' });
      continue;
    }
    rmSync(inspection.lockFilePath, { force: true });
    out.push({ profileDir, inspection, action: 'removed' });
  }
  return out;
}
