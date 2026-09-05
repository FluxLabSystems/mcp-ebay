/**
 * Deterministic wait conditions — SDD v0.5 FR-04, §18. Unmet conditions at
 * the deadline fail with CONDITION_TIMEOUT (§17, retryable).
 */
import { BridgeError, parseElementRef, type WaitCondition } from '@browser-bridge/protocol';
import { blockedSubresourcesOf, type BlockedSubresource, type BrowserSessionRuntime, type TabState } from './session.js';

export interface AttachedWaitResult {
  /** True when an element matching the selector was in the DOM before the deadline. */
  found: boolean;
  elapsedMs: number;
}

/**
 * Wait, bounded, for a selector to be ATTACHED to the document — not
 * visible, not stable: the caller wants to know whether the markup exists
 * yet. A miss is an answer, not an error: the deadline returns
 * `found:false` so an extractor can say "waited N ms, nothing rendered"
 * instead of failing the call. Written for the Kijiji /o-profile/ seller
 * page (2026-09-04): at domcontentloaded the DOM held only site chrome and
 * the listings container filled in afterwards, so the page read as empty.
 */
export async function waitForAttached(tab: TabState, selector: string, timeoutMs: number): Promise<AttachedWaitResult> {
  const started = Date.now();
  try {
    await tab.page.waitForSelector(selector, { state: 'attached', timeout: Math.max(1, timeoutMs) });
    return { found: true, elapsedMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('timeout')) return { found: false, elapsedMs: Date.now() - started };
    throw BridgeError.from(err);
  }
}

export interface WaitResult {
  satisfied: boolean;
  pageRevision: number;
  elapsedMs: number;
  /**
   * Subresource origins the network policy has refused since the tab's
   * last main-frame navigation — the same tally browser_navigate returns,
   * read again after the wait, so a price module that fetches its data
   * after load can be seen asking a host the allowlist refused.
   */
  blockedSubresources: BlockedSubresource[];
}

export async function waitFor(
  session: BrowserSessionRuntime,
  tabId: string,
  condition: WaitCondition,
  timeoutMs: number,
): Promise<WaitResult> {
  const tab = session.getTab(tabId);
  const started = Date.now();

  try {
    if (condition.text !== undefined) {
      const text = condition.text;
      await tab.page.waitForFunction(
        (needle: string) => (document.body?.innerText ?? '').includes(needle),
        text,
        { timeout: timeoutMs },
      );
    } else if (condition.urlPattern !== undefined) {
      const pattern = condition.urlPattern;
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(pattern);
      } catch {
        regex = null;
      }
      if (regex !== null) {
        await tab.page.waitForURL(regex, { timeout: timeoutMs, waitUntil: 'commit' });
      } else {
        await tab.page.waitForFunction(
          (needle: string) => window.location.href.includes(needle),
          pattern,
          { timeout: timeoutMs },
        );
      }
    } else if (condition.elementRef !== undefined) {
      const ref = condition.elementRef;
      const parsed = parseElementRef(ref);
      if (!parsed || parsed.pageRevision !== tab.revision) {
        throw new BridgeError(
          'STALE_ELEMENT',
          `Element reference belongs to page revision ${parsed?.pageRevision ?? '?'}; current revision is ${tab.revision}.`,
          { elementRef: ref },
        );
      }
      await tab.page.locator(`[data-bb-ref="${ref}"]`).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (condition.networkIdleMs !== undefined) {
      await waitForNetworkIdle(session, tabId, condition.networkIdleMs, timeoutMs);
    } else {
      throw new BridgeError('INTERNAL_ERROR', 'Wait condition is empty.', {});
    }
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('timeout')) {
      throw new BridgeError('CONDITION_TIMEOUT', `Wait condition unmet after ${timeoutMs} ms.`, {
        elapsedMs: Date.now() - started,
      });
    }
    throw BridgeError.from(err);
  }

  return {
    satisfied: true,
    pageRevision: tab.revision,
    elapsedMs: Date.now() - started,
    blockedSubresources: blockedSubresourcesOf(tab),
  };
}

async function waitForNetworkIdle(
  session: BrowserSessionRuntime,
  tabId: string,
  idleMs: number,
  timeoutMs: number,
): Promise<void> {
  const tab = session.getTab(tabId);
  const deadline = Date.now() + timeoutMs;
  let inflight = 0;
  let lastActivity = Date.now();
  const onRequest = () => {
    inflight += 1;
    lastActivity = Date.now();
  };
  const onDone = () => {
    inflight = Math.max(0, inflight - 1);
    lastActivity = Date.now();
  };
  tab.page.on('request', onRequest);
  tab.page.on('requestfinished', onDone);
  tab.page.on('requestfailed', onDone);
  try {
    for (;;) {
      if (inflight === 0 && Date.now() - lastActivity >= idleMs) return;
      if (Date.now() > deadline) {
        throw new BridgeError('CONDITION_TIMEOUT', `Network was not idle for ${idleMs} ms within ${timeoutMs} ms.`, {});
      }
      await tab.page.waitForTimeout(50);
    }
  } finally {
    tab.page.off('request', onRequest);
    tab.page.off('requestfinished', onDone);
    tab.page.off('requestfailed', onDone);
  }
}
