/**
 * Element interactions — SDD v0.5 FR-04, §19.2/§19.3 local enforcement.
 * Every interaction re-inspects the live element and consults the policy
 * hooks before acting; stale refs fail deterministically (§14).
 */
import type { Locator, Page } from 'playwright';
import type { ActionContext, FieldContext } from '@browser-bridge/policy';
import { BridgeError, parseElementRef, ALLOWED_KEYS } from '@browser-bridge/protocol';
import type { BrowserSessionRuntime, TabState } from './session.js';
import { consentSdkOf, dismissConsent, type ConsentDismissal } from './consent.js';

interface LiveElementInfo {
  accessibleName: string;
  role: string;
  href: string | null;
  /** The anchor/form target attribute; "_blank" announces a popup. */
  target: string | null;
  formAction: string | null;
  text: string;
  field: {
    inputType: string | null;
    autocomplete: string | null;
    name: string | null;
    id: string | null;
    ariaLabel: string | null;
    formSignals: string | null;
  } | null;
  tag: string;
}

function resolveRef(session: BrowserSessionRuntime, tabId: string, elementRef: string): { tab: TabState; locator: Locator } {
  const tab = session.getTab(tabId);
  const parsed = parseElementRef(elementRef);
  if (!parsed) {
    throw new BridgeError('STALE_ELEMENT', `Element reference "${elementRef}" is malformed.`, { elementRef });
  }
  if (parsed.pageRevision !== tab.revision) {
    throw new BridgeError(
      'STALE_ELEMENT',
      `Element reference belongs to page revision ${parsed.pageRevision}; current revision is ${tab.revision}.`,
      { elementRef, currentRevision: tab.revision },
    );
  }
  return { tab, locator: tab.page.locator(`[data-bb-ref="${elementRef}"]`) };
}

async function inspectElement(locator: Locator): Promise<LiveElementInfo> {
  const count = await locator.count();
  if (count === 0) {
    throw new BridgeError('STALE_ELEMENT', 'Element is no longer present in the document.', {});
  }
  return locator.first().evaluate((el: Element): LiveElementInfo => {
    const tag = el.tagName.toLowerCase();
    const isFormField =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    const form = isFormField ? (el as HTMLInputElement).form : (el as HTMLButtonElement).form ?? null;
    const aria = el.getAttribute('aria-label') ?? '';
    const text = ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const name = (aria || text || el.getAttribute('title') || el.getAttribute('alt') || '').slice(0, 200);
    return {
      accessibleName: name,
      role: el.getAttribute('role') ?? tag,
      href: el.getAttribute('href'),
      target: el.getAttribute('target'),
      formAction: form ? form.getAttribute('action') : null,
      text,
      tag,
      field: isFormField
        ? {
            inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text') : tag,
            autocomplete: el.getAttribute('autocomplete'),
            name: el.getAttribute('name'),
            id: el.id || null,
            ariaLabel: el.getAttribute('aria-label'),
            formSignals: form
              ? `${form.getAttribute('action') ?? ''} ${form.id} ${form.className} ${form.getAttribute('aria-label') ?? ''} ${form.getAttribute('name') ?? ''}`
              : null,
          }
        : null,
    };
  });
}

function toActionContext(info: LiveElementInfo, pageUrl: string): ActionContext {
  return {
    accessibleName: info.accessibleName,
    role: info.role,
    href: info.href,
    formAction: info.formAction,
    pageUrl,
    text: info.text,
  };
}

export interface ClickResult {
  pageRevision: number;
  url: string;
  /** Whether the ORIGINAL tab changed; false for a click that only opened a popup. */
  changed: boolean;
  /** A popup the click opened and the session adopted as a tab. */
  openedTab: { tabId: string; url: string } | null;
  /** A popup the URL policy refused (host outside the site allowlist) and closed. */
  popupDenied: string | null;
  /**
   * A consent banner that intercepted the click and was dismissed before the
   * click was retried (operator decision 2026-09-04); null when no banner was
   * in the way. Carries the same method/sdk/control browser_dismiss_consent
   * reports, so the run records what was pressed.
   */
  consentDismissed: Pick<ConsentDismissal, 'method' | 'sdk' | 'control'> | null;
}

/**
 * How long a click waits for a popup to surface, measured from the moment
 * the click itself has completed (see below). A control that announces a
 * new tab gets the longer window; anything else gets a short grace so an
 * in-place click is not taxed for a popup it never opens.
 */
const POPUP_WAIT_ANNOUNCED_MS = 2500;
const POPUP_WAIT_GRACE_MS = 1000;
/** How long to wait for the context handler's adopt/deny decision once a popup exists. */
const POPUP_DECISION_MS = 5000;

/**
 * A control announces a popup through target=_blank or through its
 * accessible name — Zazzle's "Personalize this design. (opens in new tab)"
 * is a <button> whose handler calls window.open, and the name is the only
 * announcement it makes (2026-09-03 wardrobe re-file).
 */
const ANNOUNCES_NEW_TAB_RE = /opens?\s+(?:in\s+)?(?:a\s+)?new\s+(?:tab|window)/i;

function announcesPopup(info: LiveElementInfo): boolean {
  return info.target === '_blank' || ANNOUNCES_NEW_TAB_RE.test(info.accessibleName) || ANNOUNCES_NEW_TAB_RE.test(info.text);
}

/** Budget for clearing a consent banner that intercepted a click before the click is retried once. */
const CONSENT_DISMISS_MS = 5000;

/**
 * How long an overlay may sit over the target before the click is refused
 * as CLICK_INTERCEPTED. A loading veil or a fade-in clears well inside
 * this; a consent SDK's dark filter never does (2026-09-03 wardrobe fire:
 * the same interception on every retry for the full 15 s timeout).
 */
const INTERCEPT_PROBE_MS = 3000;

/**
 * Playwright's actionability log for a covered target reads
 * `<div class="onetrust-pc-dark-filter ot-fade-in"></div> from <div
 * id="onetrust-consent-sdk">…</div> subtree intercepts pointer events`.
 * The element before "intercepts pointer events" is the interceptor.
 */
const INTERCEPTS_RE = /(<[^\n]*?)\s+(?:from\s+<[^\n]*?\s+subtree\s+)?intercepts pointer events/i;

function interceptorOf(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!/intercepts pointer events/i.test(message)) return null;
  const match = INTERCEPTS_RE.exec(message);
  const snippet = (match?.[1] ?? message).replace(/\s+/g, ' ').trim();
  return snippet.slice(0, 300);
}

function clickIntercepted(
  elementRef: string,
  interceptor: string,
  probedMs: number,
  consent: ConsentDismissal | null = null,
): BridgeError {
  const consentNote =
    consent === null
      ? 'Not a recognised consent banner, so it was not dismissed; traverse by href instead (browser_snapshot link nodes carry it, browser_navigate follows it).'
      : consent.dismissed
        ? `A ${consent.sdk} consent banner was dismissed (${consent.method}: ${consent.control}) and the target is still covered.`
        : `It looks like a ${consent.sdk ?? 'consent'} banner but browser_dismiss_consent found no control to press and nothing to remove.`;
  return new BridgeError(
    'CLICK_INTERCEPTED',
    `Click on ${elementRef} cannot land: ${interceptor} intercepts pointer events at the target (still covering it after ${probedMs} ms). ${consentNote}`,
    {
      elementRef,
      interceptor,
      probedMs,
      consentDismissal: consent === null ? null : { dismissed: consent.dismissed, method: consent.method, sdk: consent.sdk, control: consent.control },
    },
  );
}

export async function click(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  timeoutMs: number,
): Promise<ClickResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  if (info.field !== null) {
    // Clicking into a secret field is also blocked (focus/interaction).
    session.policy.assertFieldAllowed(info.field as FieldContext);
  }
  // A trial click runs every actionability check (visible, stable, enabled,
  // receives events) without clicking. When the hit-target check is what
  // fails, and keeps failing for INTERCEPT_PROBE_MS, the click is refused
  // as a typed error here instead of retrying inside Playwright until the
  // full timeout and surfacing as INTERNAL_ERROR. Any other trial failure
  // falls through to the real click, which behaves exactly as before.
  const probeMs = Math.min(timeoutMs, INTERCEPT_PROBE_MS);
  let consentDismissed: ClickResult['consentDismissed'] = null;
  try {
    await locator.first().click({ trial: true, timeout: probeMs });
  } catch (err) {
    const interceptor = interceptorOf(err);
    if (interceptor !== null) {
      // A consent SDK's overlay (operator decision 2026-09-04: the agent may
      // dismiss consent banners) is cleared and the probe run once more; any
      // other overlay, or a banner that would not clear, is the typed error.
      const sdk = consentSdkOf(interceptor);
      const cleared = sdk === null ? null : await dismissConsent(session, tabId, CONSENT_DISMISS_MS);
      if (cleared === null || !cleared.dismissed) {
        throw clickIntercepted(elementRef, interceptor, probeMs, cleared);
      }
      consentDismissed = { method: cleared.method, sdk: cleared.sdk, control: cleared.control };
      try {
        await locator.first().click({ trial: true, timeout: probeMs });
      } catch (again) {
        const still = interceptorOf(again);
        if (still !== null) throw clickIntercepted(elementRef, still, probeMs, cleared);
      }
    }
  }
  const beforeRevision = tab.revision;
  const beforeUrl = tab.page.url();
  const knownTabIds = new Set(session.tabIds());
  // Listen for the popup BEFORE clicking: Playwright emits 'popup' on the
  // opener page as soon as the new page exists, and a listener attached
  // afterwards misses it. The 2026-09-02 wardrobe fire lost a "(opens in
  // new tab)" click exactly that way — nothing reported the popup at all.
  //
  // But the WAIT starts after the click: before 2026-09-03 the grace timer
  // ran from listener registration, so the click's own actionability work
  // (scroll into view, stability, hit-target checks on a heavy page) and a
  // handler that calls window.open after doing its own work both consumed
  // the window, and Zazzle's Personalize button came back with neither
  // openedTab nor popupDenied even on the rebuilt agent.
  let detachPopupListener = (): void => undefined;
  const popupEvent = new Promise<Page | null>((resolve) => {
    const onPopup = (page: Page): void => resolve(page);
    tab.page.once('popup', onPopup);
    detachPopupListener = () => {
      tab.page.off('popup', onPopup);
      resolve(null);
    };
  });
  let popup: Page | null = null;
  try {
    try {
      await locator.first().click({ timeout: timeoutMs });
    } catch (err) {
      // An overlay that appeared between the probe and the click.
      const interceptor = interceptorOf(err);
      if (interceptor !== null) throw clickIntercepted(elementRef, interceptor, timeoutMs);
      throw err;
    }
    await tab.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    const popupWait = announcesPopup(info) ? POPUP_WAIT_ANNOUNCED_MS : POPUP_WAIT_GRACE_MS;
    popup = await Promise.race([
      popupEvent,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), popupWait)),
    ]);
  } finally {
    detachPopupListener();
  }
  const changed = tab.revision !== beforeRevision || tab.page.url() !== beforeUrl;
  if (!changed) tab.dirty = true;
  let openedTab: ClickResult['openedTab'] = null;
  let popupDenied: string | null = null;
  if (popup !== null) {
    const outcome = await session.popupOutcome(popup, POPUP_DECISION_MS);
    if (outcome?.kind === 'adopted') openedTab = { tabId: outcome.tabId, url: outcome.url };
    else if (outcome?.kind === 'denied') popupDenied = outcome.url;
  } else {
    // Belt and braces: a page the context adopted during the click (the
    // context-level 'page' event fires for every new page whether or not
    // Playwright attributed it to this opener) is still this click's popup.
    const adopted = session.tabIds().find((id) => !knownTabIds.has(id));
    if (adopted !== undefined) {
      openedTab = { tabId: adopted, url: session.getTab(adopted).page.url() };
      session.getTab(tabId);
    }
  }
  return { pageRevision: tab.revision, url: tab.page.url(), changed, openedTab, popupDenied, consentDismissed };
}

export interface FillResult {
  pageRevision: number;
  filled: boolean;
}

export async function fill(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  value: string,
  timeoutMs: number,
): Promise<FillResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  if (info.field === null) {
    throw new BridgeError('ACTION_BLOCKED', 'Target element is not a fillable field.', { elementRef });
  }
  session.policy.assertFieldAllowed(info.field as FieldContext);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  await locator.first().fill(value, { timeout: timeoutMs });
  tab.dirty = true;
  return { pageRevision: tab.revision, filled: true };
}

export interface SelectResult {
  pageRevision: number;
  selectedValue: string;
}

export async function select(
  session: BrowserSessionRuntime,
  tabId: string,
  elementRef: string,
  value: string,
  timeoutMs: number,
): Promise<SelectResult> {
  const { tab, locator } = resolveRef(session, tabId, elementRef);
  const info = await inspectElement(locator);
  session.policy.assertActionAllowed(toActionContext(info, tab.page.url()));
  if (info.field !== null) {
    session.policy.assertFieldAllowed(info.field as FieldContext);
  }
  if (info.tag === 'select') {
    const results = await locator.first().selectOption(value, { timeout: timeoutMs });
    tab.dirty = true;
    return { pageRevision: tab.revision, selectedValue: results[0] ?? value };
  }
  // Radio buttons / role=option variants: click, then read the APPLIED
  // state back from the live element instead of echoing the request
  // (audit F-13).
  await locator.first().click({ timeout: timeoutMs });
  tab.dirty = true;
  const applied = await locator
    .first()
    .evaluate((el: Element): string | null => {
      if (el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox')) {
        return el.checked ? el.value || 'on' : '';
      }
      const ariaSelected = el.getAttribute('aria-selected');
      if (ariaSelected !== null) {
        return ariaSelected === 'true' ? (el.textContent ?? '').trim() || 'selected' : '';
      }
      return null;
    })
    .catch(() => null);
  if (applied === '') {
    throw new BridgeError('ACTION_BLOCKED', 'Selection did not apply to the target element.', { elementRef, value });
  }
  return { pageRevision: tab.revision, selectedValue: applied ?? value };
}

export interface ScrollResult {
  pageRevision: number;
  scrollX: number;
  scrollY: number;
}

export async function scroll(
  session: BrowserSessionRuntime,
  tabId: string,
  deltaX: number,
  deltaY: number,
  elementRef?: string,
): Promise<ScrollResult> {
  const tab = session.getTab(tabId);
  if (elementRef !== undefined) {
    const { locator } = resolveRef(session, tabId, elementRef);
    const count = await locator.count();
    if (count === 0) throw new BridgeError('STALE_ELEMENT', 'Element is no longer present.', { elementRef });
    await locator.first().evaluate(
      (el, deltas: { dx: number; dy: number }) => {
        el.scrollBy(deltas.dx, deltas.dy);
      },
      { dx: deltaX, dy: deltaY },
    );
  } else {
    await tab.page.mouse.wheel(deltaX, deltaY);
  }
  await tab.page.waitForTimeout(100);
  const position = await tab.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  return { pageRevision: tab.revision, scrollX: position.x, scrollY: position.y };
}

export interface KeyResult {
  pageRevision: number;
  sent: boolean;
}

export async function pressKey(
  session: BrowserSessionRuntime,
  tabId: string,
  key: string,
): Promise<KeyResult> {
  const tab = session.getTab(tabId);
  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
    throw new BridgeError('ACTION_BLOCKED', `Key "${key}" is not an allowed navigation key.`, { key });
  }
  // If focus is in a secret field, keystrokes are blocked (§19.3).
  const focusedField = await tab.page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const isFormField =
      el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
    if (!isFormField) return null;
    const form = (el as HTMLInputElement).form;
    return {
      inputType: el instanceof HTMLInputElement ? (el.getAttribute('type') ?? 'text') : el.tagName.toLowerCase(),
      autocomplete: el.getAttribute('autocomplete'),
      name: el.getAttribute('name'),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label'),
      formSignals: form
        ? `${form.getAttribute('action') ?? ''} ${form.id} ${form.className} ${form.getAttribute('aria-label') ?? ''}`
        : null,
    };
  });
  if (focusedField !== null) {
    session.policy.assertFieldAllowed(focusedField as FieldContext);
  }
  await tab.page.keyboard.press(key);
  await tab.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
  tab.dirty = true;
  return { pageRevision: tab.revision, sent: true };
}
