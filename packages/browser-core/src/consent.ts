/**
 * Consent-banner dismissal. Operator decision 2026-09-04 ("yes the agent may
 * dismiss consent banners"), closing the policy half of the 2026-09-03
 * wardrobe fire's gateway+coverage_gap+spreadshirt-onetrust-overlay-blocks-
 * all-clicks: Spreadshirt's OneTrust dark filter intercepted every pointer
 * event site-wide, outlived the visible dialog and was absent from the
 * accessibility tree, and the routine had no sanctioned way past it.
 *
 * What "dismiss" means here, in order of preference:
 *   1. rejected — a "Reject all" / "Decline" / "Necessary only" control;
 *   2. closed   — an explicit close / "No thanks" control;
 *   3. accepted — "Accept" / "Agree" (sets the vendor's consent cookies in
 *      the agent's own research profile, never the operator's daily one);
 *   4. removed  — the SDK's container and overlay elements are removed from
 *      the DOM, for a KNOWN consent SDK whose dialog rendered no control at
 *      all (the OneTrust category-page shape the fire saw). Nothing is
 *      consented to; the site may re-show the banner on the next page.
 * Every control is run through the site policy's protected-action check
 * before it is pressed, so a consent button can never be a transaction
 * control in disguise. The result names the method, the SDK and the control
 * so the run records what happened rather than assuming.
 *
 * NEEDS-LIVE-VERIFICATION: the OneTrust ids below are the ones the fire's
 * Playwright log named (onetrust-consent-sdk, onetrust-pc-dark-filter); the
 * other SDKs' selectors are their documented defaults and have not been
 * seen on a roster host through the bridge.
 */
import type { Locator } from 'playwright';
import type { BrowserSessionRuntime } from './session.js';

export type ConsentMethod = 'rejected' | 'closed' | 'accepted' | 'removed';

export interface ConsentDismissal {
  pageRevision: number;
  dismissed: boolean;
  method: ConsentMethod | null;
  /** The consent surface recognised (onetrust, cookiebot, …, generic); null when none was found. */
  sdk: string | null;
  /** The control pressed (its accessible name / text) or, for `removed`, the elements removed. */
  control: string | null;
}

interface ConsentSdk {
  name: string;
  /** Where the banner lives; the first selector that matches an element wins. */
  containers: string[];
  reject: string[];
  close: string[];
  accept: string[];
  /** Elements removed as the last resort. Empty = never removed (generic). */
  removable: string[];
  /** Signature in an "intercepts pointer events" snippet that names this SDK. */
  signature: RegExp;
}

const SDKS: ConsentSdk[] = [
  {
    name: 'onetrust',
    containers: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter'],
    reject: ['#onetrust-reject-all-handler'],
    close: ['#onetrust-close-btn-container button', '.onetrust-close-btn-handler'],
    accept: ['#onetrust-accept-btn-handler'],
    removable: ['#onetrust-consent-sdk', '#onetrust-banner-sdk', '.onetrust-pc-dark-filter'],
    signature: /onetrust/i,
  },
  {
    name: 'cookiebot',
    containers: ['#CybotCookiebotDialog'],
    reject: ['#CybotCookiebotDialogBodyButtonDecline', '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll'],
    close: [],
    accept: ['#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll', '#CybotCookiebotDialogBodyButtonAccept'],
    removable: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay'],
    signature: /cybotcookiebot/i,
  },
  {
    name: 'trustarc',
    containers: ['#truste-consent-track', '.truste_box_overlay'],
    reject: ['#truste-consent-required'],
    close: ['#truste-consent-close'],
    accept: ['#truste-consent-button'],
    removable: ['#truste-consent-track', '.truste_box_overlay', '.truste_overlay'],
    signature: /truste/i,
  },
  {
    name: 'didomi',
    containers: ['#didomi-host', '#didomi-popup'],
    reject: ['#didomi-notice-disagree-button'],
    close: [],
    accept: ['#didomi-notice-agree-button'],
    removable: ['#didomi-host'],
    signature: /didomi/i,
  },
  {
    name: 'quantcast',
    containers: ['.qc-cmp2-container', '#qc-cmp2-container'],
    reject: [],
    close: [],
    accept: [],
    removable: ['.qc-cmp2-container', '#qc-cmp2-container', '#qc-cmp2-main'],
    signature: /qc-cmp2/i,
  },
  {
    name: 'osano',
    containers: ['.osano-cm-window', '.osano-cm-dialog'],
    reject: ['.osano-cm-deny', '.osano-cm-denyAll'],
    close: ['.osano-cm-close'],
    accept: ['.osano-cm-accept-all', '.osano-cm-accept'],
    removable: ['.osano-cm-window'],
    signature: /osano-cm/i,
  },
  {
    name: 'generic',
    containers: [
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
      '[id*="cookie" i]',
      '[class*="cookie-banner" i]',
      '[class*="cookiebanner" i]',
      '[id*="consent" i]',
      '[class*="consent-banner" i]',
    ],
    reject: [],
    close: [],
    accept: [],
    removable: [],
    signature: /cookie|consent|gdpr|privacy/i,
  },
];

/** Wording that clears a banner without consenting, in the languages the roster hosts render. */
const REJECT_RE =
  /^(?:reject(?: all)?(?: cookies)?|decline(?: all)?(?: cookies)?|refuse(?: all)?|deny(?: all)?|(?:only |use )?(?:necessary|essential|required)(?: cookies)?(?: only)?|disagree(?: and close)?|continue without (?:accepting|agreeing)|tout refuser|refuser(?: tout)?)\.?$/i;
const CLOSE_RE = /^(?:close|dismiss|×|x|no,? thanks|not now|fermer)\.?$/i;
const ACCEPT_RE =
  /^(?:accept(?: all)?(?: cookies)?|agree(?: and close)?|i agree|allow(?: all)?(?: cookies)?|ok(?:ay)?|got it|i understand|understood|yes,? i agree|tout accepter|accepter(?: tout)?|j'accepte)\.?$/i;
/** A generic dialog is a consent banner only when it says so. */
const CONSENT_TEXT_RE = /\b(?:cookies?|consent|gdpr|privacy|tracking)\b/i;

/** The SDK an "intercepts pointer events" snippet names, or null for an ordinary overlay. */
export function consentSdkOf(interceptor: string): string | null {
  for (const sdk of SDKS) {
    if (sdk.signature.test(interceptor)) return sdk.name;
  }
  return null;
}

async function firstPresent(root: Locator | null, selectors: string[], scope: { locator: (s: string) => Locator }): Promise<Locator | null> {
  for (const selector of selectors) {
    const candidate = (root ?? scope).locator(selector).first();
    try {
      if ((await candidate.count()) > 0) return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

interface ControlCandidate {
  index: number;
  name: string;
}

/** Every button-like control inside the container with its accessible name, in DOM order. */
async function controlsOf(container: Locator): Promise<{ locator: Locator; candidates: ControlCandidate[] }> {
  const locator = container.locator('button, a[href], [role="button"], input[type="button"], input[type="submit"]');
  const names = await locator
    .evaluateAll((elements: Element[]) =>
      elements.map((el) => {
        const aria = el.getAttribute('aria-label') ?? '';
        const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
        const value = el instanceof HTMLInputElement ? el.value : '';
        return (aria || text || value || el.getAttribute('title') || '').slice(0, 120);
      }),
    )
    .catch(() => [] as string[]);
  return {
    locator,
    candidates: names.map((name, index) => ({ index, name })).filter((candidate) => candidate.name.length > 0),
  };
}

async function stillPresent(container: Locator): Promise<boolean> {
  try {
    if ((await container.count()) === 0) return false;
    return await container.isVisible();
  } catch {
    return false;
  }
}

export async function dismissConsent(
  session: BrowserSessionRuntime,
  tabId: string,
  timeoutMs: number,
): Promise<ConsentDismissal> {
  const tab = session.getTab(tabId);
  const page = tab.page;
  const started = Date.now();
  const remaining = (): number => Math.max(250, timeoutMs - (Date.now() - started));
  const perClickMs = (): number => Math.min(2000, remaining());

  let sdk: ConsentSdk | null = null;
  let container: Locator | null = null;
  for (const candidate of SDKS) {
    const found = await firstPresent(null, candidate.containers, page);
    if (found === null) continue;
    if (candidate.name === 'generic') {
      // A generic dialog counts only when it talks about cookies/consent;
      // a product configurator or a size chart is also role="dialog".
      const text = await found.innerText().catch(() => '');
      if (!CONSENT_TEXT_RE.test(text) || text.length > 6000) continue;
    }
    sdk = candidate;
    container = found;
    break;
  }
  if (sdk === null || container === null) {
    return { pageRevision: tab.revision, dismissed: false, method: null, sdk: null, control: null };
  }

  const finish = (method: ConsentMethod, control: string): ConsentDismissal => {
    tab.dirty = true;
    return { pageRevision: tab.revision, dismissed: true, method, sdk: sdk!.name, control };
  };

  const allowed = (name: string): boolean => {
    try {
      session.policy.assertActionAllowed({
        accessibleName: name,
        role: 'button',
        href: null,
        formAction: null,
        pageUrl: page.url(),
        text: name,
      });
      return true;
    } catch {
      return false;
    }
  };

  const press = async (target: Locator, name: string): Promise<boolean> => {
    if (!allowed(name)) return false;
    try {
      await target.click({ timeout: perClickMs() });
    } catch {
      return false;
    }
    await page.waitForTimeout(250);
    return !(await stillPresent(container!));
  };

  // 1–3: the SDK's own known controls first, then any control by wording.
  const byWording = async (): Promise<{ locator: Locator; candidates: ControlCandidate[] }> => controlsOf(container!);
  const wordingControls = await byWording();
  const stages: Array<{ method: ConsentMethod; known: string[]; wording: RegExp }> = [
    { method: 'rejected', known: sdk.reject, wording: REJECT_RE },
    { method: 'closed', known: sdk.close, wording: CLOSE_RE },
    { method: 'accepted', known: sdk.accept, wording: ACCEPT_RE },
  ];
  for (const stage of stages) {
    if (remaining() <= 250) break;
    const known = await firstPresent(null, stage.known, page);
    if (known !== null) {
      const name = (await known.innerText().catch(() => '')).replace(/\s+/g, ' ').trim() || stage.known[0]!;
      if (await press(known, name)) return finish(stage.method, name);
    }
    for (const candidate of wordingControls.candidates) {
      if (!stage.wording.test(candidate.name)) continue;
      // aria-label="Close" on an icon button is the common close control.
      if (await press(wordingControls.locator.nth(candidate.index), candidate.name)) {
        return finish(stage.method, candidate.name);
      }
    }
  }

  // 4: a known SDK whose banner exposed no control at all — the overlay that
  // blocked the fire was exactly this shape. Remove its elements; nothing is
  // consented to and the site may show the banner again on the next page.
  if (sdk.removable.length > 0) {
    const removed = await page
      .evaluate((selectors: string[]) => {
        const gone: string[] = [];
        for (const selector of selectors) {
          for (const el of Array.from(document.querySelectorAll(selector))) {
            el.remove();
            gone.push(selector);
          }
        }
        // Consent SDKs lock body scrolling while the banner is up.
        if (gone.length > 0) {
          document.documentElement.style.removeProperty('overflow');
          document.body.style.removeProperty('overflow');
        }
        return Array.from(new Set(gone));
      }, sdk.removable)
      .catch(() => [] as string[]);
    if (removed.length > 0) return finish('removed', removed.join(', '));
  }

  return { pageRevision: tab.revision, dismissed: false, method: null, sdk: sdk.name, control: null };
}
