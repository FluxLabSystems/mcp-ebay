/**
 * Browser session ownership — SDD v0.5 §13, §18. One persistent context
 * per device/profile; crash triggers one automatic relaunch; >3 launches
 * in 5 minutes enters DEGRADED and requires user intervention.
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
import { BridgeError, type Tab } from '@browser-bridge/protocol';
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
  /** TEST-ONLY plan override; production always uses buildChromeLaunchPlan. */
  planOverride?: BrowserLaunchPlan;
  /** Optional dashboard sink (monitor.ts); absent in tests and plain mode. */
  monitor?: AgentMonitor;
}

export class SessionManager {
  private readonly options: SessionManagerOptions;
  private session: BrowserSessionRuntime | null = null;
  private lock: ProfileLock | null = null;
  private launchTimestamps: number[] = [];
  private degraded = false;
  private opening: Promise<BrowserSessionRuntime> | null = null;

  constructor(options: SessionManagerOptions) {
    this.options = options;
  }

  get isDegraded(): boolean {
    return this.degraded;
  }

  current(): BrowserSessionRuntime | null {
    return this.session !== null && !this.session.isClosed ? this.session : null;
  }

  /** Launch or reuse the dedicated persistent context (browser_session_open). */
  async open(profileName: string): Promise<SessionOpenResult> {
    const existing = this.current();
    if (existing !== null) {
      return {
        browserSessionHandle: existing.handle,
        profileName: existing.profileName,
        status: this.degraded ? 'degraded' : 'ready',
        tabs: await existing.listTabs(),
      };
    }
    if (this.opening === null) {
      this.opening = this.launch(profileName).finally(() => {
        this.opening = null;
      });
    }
    const session = await this.opening;
    return {
      browserSessionHandle: session.handle,
      profileName: session.profileName,
      status: this.degraded ? 'degraded' : 'ready',
      tabs: await session.listTabs(),
    };
  }

  /** Resolve a handle to the live session (SESSION_NOT_FOUND otherwise). */
  resolve(browserSessionHandle: string): BrowserSessionRuntime {
    const session = this.current();
    if (session === null || session.handle !== browserSessionHandle) {
      throw new BridgeError('SESSION_NOT_FOUND', undefined, { browserSessionHandle });
    }
    return session;
  }

  listActive(): BrowserSessionRuntime[] {
    const session = this.current();
    return session === null ? [] : [session];
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

  private async launch(profileName: string): Promise<BrowserSessionRuntime> {
    if (this.degraded) {
      throw new BridgeError('BROWSER_UNAVAILABLE', 'Agent is DEGRADED after repeated browser crashes; user intervention required.');
    }
    if (this.lock === null) {
      this.lock = acquireProfileLock(this.options.profileDir);
    }
    this.recordLaunch();
    const plan = this.options.planOverride ?? buildChromeLaunchPlan(this.options.profileDir);
    const context = await launchPersistent(plan, this.options.launcher ?? defaultLauncher);
    const session = await BrowserSessionRuntime.create(context, profileName, this.options.policy, {
      onContextClosed: () => {
        this.options.logger.warn({ handle: session?.handle }, 'Browser context closed');
        this.session = null;
        this.options.monitor?.sessionClosed();
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
    this.session = session;
    this.options.monitor?.sessionOpened(session.handle, session.profileName);
    return session;
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
    const session = this.session;
    this.session = null;
    if (session !== null) {
      await session.close();
      this.options.monitor?.sessionClosed();
    }
    this.lock?.release();
    this.lock = null;
  }
}
