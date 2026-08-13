/**
 * Browser launch plans, no-fallback preflight, and profile locking —
 * SDD v0.5 §13. MVP controls the user-provisioned branded Google Chrome
 * through Playwright channel `chrome` with a dedicated persistent
 * automation user-data directory. Edge, bundled Chromium, Firefox, and
 * WebKit are never substituted; a failed `chrome` launch is
 * BROWSER_UNAVAILABLE.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * browser build. Not reachable from agent configuration.
 */
export function buildTestLaunchPlan(userDataDir: string, executablePath?: string): BrowserLaunchPlan {
  return {
    userDataDir,
    channel: executablePath === undefined ? 'chrome' : undefined,
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

interface LockPayload {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * Exclusive profile ownership (§13): exactly one browser process may own
 * the profile directory. Implemented as an O_EXCL lock file with liveness
 * checking — the portable equivalent of a named OS mutex for a per-user
 * Node agent. A live owning pid means PROFILE_IN_USE.
 */
export function acquireProfileLock(profileDir: string): ProfileLock {
  mkdirSync(profileDir, { recursive: true });
  const lockFilePath = join(profileDir, '.browser-bridge.lock');
  const payload: LockPayload = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() };

  const tryWrite = (): boolean => {
    try {
      writeFileSync(lockFilePath, JSON.stringify(payload), { flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryWrite()) {
    let stale = false;
    try {
      const existing = JSON.parse(readFileSync(lockFilePath, 'utf8')) as LockPayload;
      if (existing.pid === process.pid) {
        stale = true; // our own previous acquisition in-process (re-entrant)
      } else {
        try {
          process.kill(existing.pid, 0);
          stale = false;
        } catch {
          stale = true; // owner is gone
        }
      }
    } catch {
      stale = true; // unreadable lock file
    }
    if (!stale) {
      throw new BridgeError('PROFILE_IN_USE', undefined, { lockFilePath });
    }
    rmSync(lockFilePath, { force: true });
    if (!tryWrite()) {
      throw new BridgeError('PROFILE_IN_USE', undefined, { lockFilePath });
    }
  }

  return {
    lockFilePath,
    release: () => {
      try {
        const current = JSON.parse(readFileSync(lockFilePath, 'utf8')) as LockPayload;
        if (current.pid === process.pid) rmSync(lockFilePath, { force: true });
      } catch {
        // already gone
      }
    },
  };
}
