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

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private readonly slots = new Map<string, ProfileSlot>();
  private readonly opening = new Map<string, Promise<BrowserSessionRuntime>>();
  private launchTimestamps: number[] = [];
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

  private recordLaunch(): void {
    const now = Date.now();
    this.launchTimestamps = this.launchTimestamps.filter((ts) => now - ts < 5 * 60 * 1000);
    this.launchTimestamps.push(now);
    if (this.launchTimestamps.length > 3) {
      this.degraded = true;
      this.options.logger.error(
        { launchesInWindow: this.launchTimestamps.length },
        'Browser crash loop detected; entering DEGRADED state',
      );
      this.options.monitor?.sessionDegraded();
    }
  }

  private planFor(profileName: string): BrowserLaunchPlan {
    const base = this.options.planOverride ?? buildChromeLaunchPlan(this.options.profileDir);
    return { ...base, userDataDir: profileDirectoryFor(base.userDataDir, profileName) };
  }

  private async launch(profileName: string): Promise<BrowserSessionRuntime> {
    if (this.degraded) {
      throw new BridgeError('BROWSER_UNAVAILABLE', 'Agent is DEGRADED after repeated browser crashes; user intervention required.');
    }
    const lock = acquireProfileLock(profileDirectoryFor(this.options.profileDir, profileName));
    try {
      this.recordLaunch();
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
