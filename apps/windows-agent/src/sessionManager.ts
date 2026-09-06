/**
 * Browser session ownership — SDD v0.5 §13, §18. One persistent context
 * per device/profile; crash triggers one automatic relaunch; >3 launches
 * in 5 minutes enters DEGRADED and requires user intervention.
 *
 * profileName is honoured (2026-09-03, gateway+connector_defect+browser-
 * session-open-ignores-profilename-shared-context): before that date this
 * manager kept ONE context whatever name was asked for, so the Wardrobe
 * routine's browser_session_open({profileName:'wardrobe-research'}) was
 * handed the Deals routine's 'ebay-research' handle and tab, and the two
 * concurrently scheduled fires navigated each other's page (browser_images
 * and browser_screenshot then returned the other site's content). Now each
 * profileName owns its own persistent user-data directory, Chrome instance,
 * lock, handle and tabs. The default profile keeps the configured
 * AGENT_PROFILE_DIR (the logged-in eBay research profile); any other name
 * lives in a sibling directory `<profileDir>.<profileName>`.
 */
import {
  acquireProfileLock,
  BrowserSessionRuntime,
  buildChromeLaunchPlan,
  launchPersistent,
  type BrowserLaunchPlan,
  type PagePolicy,
  type PersistentContextLauncher,
  type ProfileLock,
  defaultLauncher,
} from '@browser-bridge/browser-core';
import { BridgeError, DEFAULT_PROFILE_NAME, PROFILE_NAME_RE, type Tab } from '@browser-bridge/protocol';
import type { Logger } from './logger.js';
import type { AgentMonitor } from './monitor.js';

export interface SessionOpenResult {
  browserSessionHandle: string;
  profileName: string;
  status: 'ready' | 'degraded';
  tabs: Tab[];
}

export interface SessionManagerOptions {
  profileDir: string;
  policy: PagePolicy;
  logger: Logger;
  launcher?: PersistentContextLauncher;
  /**
   * TEST-ONLY plan override; production always uses buildChromeLaunchPlan.
   * Applies to the default profile as given; other profiles derive a
   * sibling userDataDir from it the same way production does from profileDir.
   */
  planOverride?: BrowserLaunchPlan;
  /** Optional dashboard sink (monitor.ts); absent in tests and plain mode. */
  monitor?: AgentMonitor;
}

/**
 * The directory a profile owns: the configured one for the default profile
 * (so an existing logged-in profile is never moved), a sibling for the rest.
 */
export function profileDirectoryFor(baseDir: string, profileName: string): string {
  if (profileName === DEFAULT_PROFILE_NAME) return baseDir;
  return `${baseDir.replace(/[\\/]+$/, '')}.${profileName}`;
}

interface ProfileSlot {
  session: BrowserSessionRuntime;
  lock: ProfileLock;
}

/** The crash-loop window (§13): more than CRASH_LOOP_MAX_LAUNCHES launches inside it is DEGRADED. */
const CRASH_LOOP_WINDOW_MS = 5 * 60 * 1000;
const CRASH_LOOP_MAX_LAUNCHES = 3;

interface LaunchRecord {
  profileName: string;
  at: number;
}

/**
 * What a DEGRADED refusal tells the caller (2026-09-05, gateway+defect+
 * bridge-agent-degraded-blocks-new-session-creation, read as the
 * windows-agent connector_defect it is): before this the
 * BROWSER_UNAVAILABLE for a new profile on a degraded agent carried
 * details {}, so a routine could not tell a crash loop from a box that
 * needs a human, did not know which profiles had crashed, and did not
 * know its already-open sessions keep working.
 */
export interface DegradedDetails {
  degraded: true;
  launchesInWindow: number;
  windowMs: number;
  /** Profiles launched inside the window, in first-launch order, each once. */
  crashedProfiles: string[];
  /** Profiles whose session is still live and serving. */
  openSessions: string[];
  recovery: 'manual';
  hint: string;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly slots = new Map<string, ProfileSlot>();
  private readonly opening = new Map<string, Promise<BrowserSessionRuntime>>();
  private launches: LaunchRecord[] = [];
  private degraded = false;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  /** The live session for a profile, or null when none is open. */
  current(profileName: string = DEFAULT_PROFILE_NAME): BrowserSessionRuntime | null {
    const slot = this.slots.get(profileName);
    if (slot === undefined) return null;
    if (slot.session.isClosed) {
      this.forget(profileName);
      return null;
    }
    return slot.session;
  }

  /** Launch or reuse the persistent context that owns profileName (browser_session_open). */
  async open(profileName: string): Promise<SessionOpenResult> {
    if (!PROFILE_NAME_RE.test(profileName)) {
      throw new BridgeError('BROWSER_UNAVAILABLE', `profileName "${profileName}" is not a valid profile name.`, {
        profileName,
      });
    }
    const existing = this.current(profileName);
    if (existing !== null) {
      return this.describe(existing);
    }
    let pending = this.opening.get(profileName);
    if (pending === undefined) {
      pending = this.launch(profileName).finally(() => {
        this.opening.delete(profileName);
      });
      this.opening.set(profileName, pending);
    }
    return this.describe(await pending);
  }

  private async describe(session: BrowserSessionRuntime): Promise<SessionOpenResult> {
    return {
      browserSessionHandle: session.handle,
      profileName: session.profileName,
      status: this.degraded ? 'degraded' : 'ready',
      tabs: await session.listTabs(),
    };
  }

  /** Resolve a handle to the live session that owns it (SESSION_NOT_FOUND otherwise). */
  resolve(browserSessionHandle: string): BrowserSessionRuntime {
    for (const session of this.listActive()) {
      if (session.handle === browserSessionHandle) return session;
    }
    throw new BridgeError('SESSION_NOT_FOUND', undefined, { browserSessionHandle });
  }

  listActive(): BrowserSessionRuntime[] {
    const out: BrowserSessionRuntime[] = [];
    for (const profileName of Array.from(this.slots.keys())) {
      const session = this.current(profileName);
      if (session !== null) out.push(session);
    }
    return out;
  }

  private forget(profileName: string): void {
    const slot = this.slots.get(profileName);
    if (slot === undefined) return;
    this.slots.delete(profileName);
    slot.lock.release();
  }

  /** The launches still inside the crash-loop window, oldest first. */
  private launchesInWindow(now: number): LaunchRecord[] {
    this.launches = this.launches.filter((launch) => now - launch.at < CRASH_LOOP_WINDOW_MS);
    return this.launches;
  }

  private recordLaunch(profileName: string): void {
    const now = Date.now();
    const launches = this.launchesInWindow(now);
    launches.push({ profileName, at: now });
    if (launches.length > CRASH_LOOP_MAX_LAUNCHES) {
      this.degraded = true;
      this.options.logger.error(
        { launchesInWindow: launches.length, crashedProfiles: this.degradedDetails().crashedProfiles },
        'Browser crash loop detected; entering DEGRADED state',
      );
      this.options.monitor?.sessionDegraded();
    }
  }

  /** The diagnosis a DEGRADED refusal carries; built at refusal time, so it names the sessions still open then. */
  private degradedDetails(): DegradedDetails {
    const launches = this.launchesInWindow(Date.now());
    const crashedProfiles = Array.from(new Set(launches.map((launch) => launch.profileName)));
    const openSessions = this.listActive().map((session) => session.profileName);
    return {
      degraded: true,
      launchesInWindow: launches.length,
      windowMs: CRASH_LOOP_WINDOW_MS,
      crashedProfiles,
      openSessions,
      recovery: 'manual',
      hint:
        `The agent counted ${launches.length} browser launches in ${CRASH_LOOP_WINDOW_MS / 60_000} minutes (profiles: ${crashedProfiles.join(', ') || 'none'}) and will not launch another. ` +
        `Existing sessions keep working (${openSessions.length === 0 ? 'none open' : `open: ${openSessions.join(', ')}`}); ` +
        'new sessions need the operator to restart the agent after checking the crashed profile(s). Not a transient condition: do not retry the open.',
    };
  }

  private planFor(profileName: string): BrowserLaunchPlan {
    const base = this.options.planOverride ?? buildChromeLaunchPlan(this.options.profileDir);
    return { ...base, userDataDir: profileDirectoryFor(base.userDataDir, profileName) };
  }

  private async launch(profileName: string): Promise<BrowserSessionRuntime> {
    if (this.degraded) {
      throw new BridgeError(
        'BROWSER_UNAVAILABLE',
        'Agent is DEGRADED after repeated browser crashes; user intervention required.',
        { ...this.degradedDetails(), profileName },
      );
    }
    const lock = acquireProfileLock(profileDirectoryFor(this.options.profileDir, profileName));
    try {
      this.recordLaunch(profileName);
      const context = await launchPersistent(this.planFor(profileName), this.options.launcher ?? defaultLauncher);
      const session = await BrowserSessionRuntime.create(context, profileName, this.options.policy, {
        onContextClosed: () => {
          this.options.logger.warn({ handle: session?.handle, profileName }, 'Browser context closed');
          this.forget(profileName);
          if (this.listActive().length === 0) this.options.monitor?.sessionClosed();
        },
        onDownloadBlocked: (url) => {
          this.options.logger.warn({ url }, 'Download blocked (DOWNLOAD_BLOCKED policy)');
          this.options.monitor?.policyBlocked('download_blocked');
        },
        onPopupDenied: (url) => {
          this.options.logger.warn({ url }, 'Popup denied by URL policy');
          this.options.monitor?.policyBlocked('popup_denied');
        },
        onRequestAborted: (url, reason) => {
          this.options.logger.info({ url, reason }, 'Request aborted by policy');
          this.options.monitor?.policyBlocked('request_aborted');
        },
      });
      this.slots.set(profileName, { session, lock });
      this.options.monitor?.sessionOpened(session.handle, session.profileName);
      return session;
    } catch (err) {
      lock.release();
      throw err;
    }
  }

  /** One automatic relaunch after a crash (§13); crash loops go DEGRADED. */
  async relaunchAfterCrash(profileName: string): Promise<SessionOpenResult | null> {
    if (this.degraded) return null;
    try {
      return await this.open(profileName);
    } catch (err) {
      this.options.logger.error({ err: String(err) }, 'Automatic browser relaunch failed');
      return null;
    }
  }

  async close(): Promise<void> {
    const slots = Array.from(this.slots.entries());
    this.slots.clear();
    for (const [, slot] of slots) {
      await slot.session.close();
      slot.lock.release();
    }
    if (slots.length > 0) this.options.monitor?.sessionClosed();
  }
}
