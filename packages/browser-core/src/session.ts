/**
 * Application browser session runtime — SDD v0.5 §14 (handles, revisions),
 * §18 (serial FIFO execution), §19 (network-layer enforcement). A session
 * wraps one persistent Chrome context; tabs and element refs are explicit
 * application state, never MCP transport state.
 */
import type { BrowserContext, Page, Route, Request } from 'playwright';
import { BridgeError, newBrowserSessionHandle, newTabId, type Tab } from '@browser-bridge/protocol';
import type { PagePolicy } from './policyHooks.js';

export interface ImageRegistryEntry {
  imageId: string;
  order: number;
  sourceUrl: string | null;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  pageRevision: number;
}

export interface TabState {
  tabId: string;
  page: Page;
  revision: number;
  /** Set by mutating actions; next snapshot bumps the revision (§14). */
  dirty: boolean;
  /** Last network-policy block observed for a main-frame navigation. */
  lastBlock: { url: string; code: 'ORIGIN_DENIED' | 'PRIVATE_NETWORK_DENIED' | 'SCHEME_DENIED' | 'ACTION_BLOCKED' } | null;
  imageRegistry: Map<string, ImageRegistryEntry>;
}

class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface SessionEvents {
  onContextClosed?: (handle: string) => void;
  onDownloadBlocked?: (url: string) => void;
  onPopupDenied?: (url: string) => void;
  onRequestAborted?: (url: string, reason: string) => void;
}

export class BrowserSessionRuntime {
  readonly handle: string;
  readonly profileName: string;
  readonly policy: PagePolicy;
  private readonly context: BrowserContext;
  private readonly tabs = new Map<string, TabState>();
  private readonly pageToTab = new WeakMap<Page, TabState>();
  private readonly queue = new SerialQueue();
  private closed = false;
  private readonly events: SessionEvents;

  private constructor(
    context: BrowserContext,
    profileName: string,
    policy: PagePolicy,
    events: SessionEvents,
    handle?: string,
  ) {
    this.context = context;
    this.profileName = profileName;
    this.policy = policy;
    this.events = events;
    this.handle = handle ?? newBrowserSessionHandle();
  }

  static async create(
    context: BrowserContext,
    profileName: string,
    policy: PagePolicy,
    events: SessionEvents = {},
  ): Promise<BrowserSessionRuntime> {
    const runtime = new BrowserSessionRuntime(context, profileName, policy, events);
    await runtime.installInterception();
    runtime.installContextHandlers();
    for (const page of context.pages()) {
      runtime.adoptPage(page);
    }
    if (context.pages().length === 0) {
      runtime.adoptPage(await context.newPage());
    }
    context.on('close', () => {
      runtime.closed = true;
      events.onContextClosed?.(runtime.handle);
    });
    return runtime;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** §18 / NFR-10: all commands for one session run serially, FIFO. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.queue.run(fn);
  }

  private installContextHandlers(): void {
    this.context.on('page', (page) => {
      // Popup / window.open: validate the target before adopting (§19.1).
      void (async () => {
        const url = page.url();
        if (url && url !== 'about:blank') {
          const decision = await this.policy.checkUrl(url, 'popup');
          if (!decision.allowed) {
            this.events.onPopupDenied?.(url);
            await page.close().catch(() => undefined);
            return;
          }
        }
        this.adoptPage(page);
      })();
    });
  }

  private adoptPage(page: Page): TabState {
    const existing = this.pageToTab.get(page);
    if (existing) return existing;
    const tab: TabState = {
      tabId: newTabId(),
      page,
      revision: 0,
      dirty: false,
      lastBlock: null,
      imageRegistry: new Map(),
    };
    this.tabs.set(tab.tabId, tab);
    this.pageToTab.set(page, tab);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        tab.revision += 1;
        tab.dirty = false;
        tab.imageRegistry.clear();
      }
    });
    page.on('download', (download) => {
      // MVP: no tool produces browser downloads; cancel and surface (§17 DOWNLOAD_BLOCKED).
      this.events.onDownloadBlocked?.(download.url());
      void download.cancel().catch(() => undefined);
    });
    page.on('close', () => {
      this.tabs.delete(tab.tabId);
    });
    return tab;
  }

  /**
   * Network-layer enforcement (§19.1/§19.2): every main-frame navigation
   * request (including each redirect hop) is revalidated; protected
   * transaction/account endpoint requests are aborted for all resource
   * types; subresources are constrained by scheme + allowlist.
   */
  private async installInterception(): Promise<void> {
    await this.context.route('**/*', async (route: Route, request: Request) => {
      const url = request.url();
      const scheme = url.split(':', 1)[0];
      const isHttp = scheme === 'http' || scheme === 'https';
      if (!isHttp) {
        // Non-HTTP subresources (data: images etc.) stay inside the page;
        // top-level non-HTTP navigation is blocked by policy pre-checks.
        await route.continue().catch(() => undefined);
        return;
      }

      if (this.policy.isProtectedEndpoint(url)) {
        this.events.onRequestAborted?.(url, 'protected-endpoint');
        const frame = request.frame();
        const page = frame.page();
        const tab = this.pageToTab.get(page);
        if (tab) tab.lastBlock = { url, code: 'ACTION_BLOCKED' };
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }

      const frame = request.frame();
      const page = frame.page();
      const isMainNavigation = request.isNavigationRequest() && frame === page.mainFrame();
      const context = isMainNavigation ? (request.redirectedFrom() ? 'redirect' : 'navigation') : 'subresource';
      const decision = await this.policy.checkUrl(url, context);
      if (!decision.allowed) {
        const tab = this.pageToTab.get(page);
        if (tab && isMainNavigation) {
          tab.lastBlock = {
            url,
            code: decision.errorCode ?? 'ORIGIN_DENIED',
          };
        }
        this.events.onRequestAborted?.(url, decision.errorCode ?? 'ORIGIN_DENIED');
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.continue().catch(() => undefined);
    });
  }

  getTab(tabId: string): TabState {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.page.isClosed()) {
      if (tab) this.tabs.delete(tabId);
      throw new BridgeError('TAB_NOT_FOUND', undefined, { tabId });
    }
    return tab;
  }

  async listTabs(): Promise<Tab[]> {
    const out: Tab[] = [];
    for (const tab of this.tabs.values()) {
      if (tab.page.isClosed()) continue;
      let title = '';
      try {
        title = await tab.page.title();
      } catch {
        title = '';
      }
      out.push({
        tabId: tab.tabId,
        url: tab.page.url(),
        title,
        active: tab.page === this.context.pages().at(-1),
        pageRevision: tab.revision,
      });
    }
    return out;
  }

  /** Open a new tab (used by tests and future tooling). */
  async newTab(): Promise<TabState> {
    const page = await this.context.newPage();
    return this.adoptPage(page);
  }

  get browserContext(): BrowserContext {
    return this.context;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}

/** Read via a call boundary: lastBlock is mutated inside route handlers, invisible to CFA narrowing. */
function readLastBlock(tab: TabState): TabState['lastBlock'] {
  return tab.lastBlock;
}

export interface NavigateResult {
  finalUrl: string;
  title: string;
  origin: string;
  pageRevision: number;
  navigationStatus: 'committed' | 'same_document' | 'blocked';
}

export async function navigate(
  session: BrowserSessionRuntime,
  tabId: string,
  url: string,
  waitUntil: 'domcontentloaded' | 'load',
  timeoutMs: number,
): Promise<NavigateResult> {
  const tab = session.getTab(tabId);
  await session.policy.assertUrlAllowed(url, 'navigation');
  tab.lastBlock = null;
  try {
    let response;
    try {
      response = await tab.page.goto(url, { waitUntil, timeout: timeoutMs });
    } catch (err) {
      // §18: navigate MAY retry one network-level failure when no document
      // committed — covers the chrome-error page race after an aborted
      // (policy-blocked) prior navigation.
      const message = err instanceof Error ? err.message : String(err);
      if (readLastBlock(tab) === null && message.includes('interrupted by another navigation')) {
        await tab.page.waitForTimeout(200);
        response = await tab.page.goto(url, { waitUntil, timeout: timeoutMs });
      } else {
        throw err;
      }
    }
    const finalUrl = tab.page.url();
    let origin = '';
    try {
      origin = new URL(finalUrl).origin;
    } catch {
      origin = '';
    }
    return {
      finalUrl,
      title: await tab.page.title().catch(() => ''),
      origin,
      pageRevision: tab.revision,
      navigationStatus: response === null ? 'same_document' : 'committed',
    };
  } catch (err) {
    const block = readLastBlock(tab);
    if (block) {
      tab.lastBlock = null;
      throw new BridgeError(block.code, `Navigation to ${block.url} was blocked by local policy.`, {
        url: block.url,
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('timeout')) {
      throw new BridgeError('NAVIGATION_TIMEOUT', `Navigation to ${url} exceeded ${timeoutMs} ms.`, { url });
    }
    throw BridgeError.from(err);
  }
}
