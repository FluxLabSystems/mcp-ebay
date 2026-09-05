/**
 * Browser integration (§27.1): persistent context over the LOCAL TEST
 * BROWSER, tab lifecycle, page revisions, element staleness, policy
 * enforcement in a real DOM, screenshots, images, and waits.
 *
 * Channel enforcement/no-fallback behavior is asserted here too: the
 * production plan is frozen to channel "chrome" and a failed chrome
 * launch is BROWSER_UNAVAILABLE with no substitute browser.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireProfileLock,
  buildChromeLaunchPlan,
  click,
  enumerateImages,
  fetchImage,
  fill,
  launchPersistent,
  dismissConsent,
  navigate,
  pressKey,
  preflightBrowser,
  scroll,
  select,
  snapshot,
  screenshot,
  waitFor,
  waitForAttached,
} from '@browser-bridge/browser-core';
import type { BridgeError } from '@browser-bridge/protocol';
import { startFixtureServer, type FixtureServer } from '../helpers/fixtureServer.js';
import { launchTestSession, type BrowserHarness } from '../helpers/browserHarness.js';
import { makeFixtureProfile } from '../helpers/testProfile.js';

let fixtures: FixtureServer;
let harness: BrowserHarness;
let tabId: string;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  harness = await launchTestSession(makeFixtureProfile());
  const tabs = await harness.session.listTabs();
  tabId = tabs[0]!.tabId;
}, 120_000);

afterAll(async () => {
  await harness?.close();
  await fixtures?.close();
});

describe('no-fallback browser policy (§13, §30)', () => {
  it('the production launch plan is frozen to branded chrome', () => {
    const plan = buildChromeLaunchPlan('/tmp/profile');
    expect(plan.channel).toBe('chrome');
    expect(plan.headless).toBe(false);
    expect(plan.viewport).toBeNull();
    expect(plan.acceptDownloads).toBe(true);
    expect(plan.executablePath).toBeUndefined();
  });

  it('preflight fails closed with BROWSER_UNAVAILABLE when chrome cannot launch', async () => {
    const plan = buildChromeLaunchPlan(mkdtempSync(join(tmpdir(), 'bridge-preflight-')));
    const failingLauncher = async () => {
      throw new Error("Chromium distribution 'chrome' is not found at expected path");
    };
    await expect(preflightBrowser(plan, failingLauncher)).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
    });
    try {
      await preflightBrowser(plan, failingLauncher);
    } catch (err) {
      expect((err as BridgeError).message).toMatch(/never falls back to Edge, bundled Chromium, Firefox, or WebKit/);
    }
  });

  it('rejects executablePath overrides on non-test plans (no silent substitution)', async () => {
    const plan = { ...buildChromeLaunchPlan('/tmp/x'), executablePath: '/usr/bin/other-browser' };
    await expect(launchPersistent(plan)).rejects.toMatchObject({ code: 'BROWSER_UNAVAILABLE' });
  });

  it('profile lock: a live foreign owner yields PROFILE_IN_USE (§13)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-lock-'));
    writeFileSync(
      join(dir, '.browser-bridge.lock'),
      JSON.stringify({ pid: 1, hostname: 'other-host', acquiredAt: new Date().toISOString() }),
    );
    expect(() => acquireProfileLock(dir)).toThrowError(
      expect.objectContaining({ code: 'PROFILE_IN_USE' }) as never,
    );
  });
});

describe('navigation + revisions + snapshot (FR-02/03, §14)', () => {
  it('navigates, bumps the revision, and reports final URL/origin', async () => {
    const before = (await harness.session.listTabs())[0]!.pageRevision;
    const result = await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    expect(result.navigationStatus).toBe('committed');
    expect(result.finalUrl).toBe(`${fixtures.baseUrl}/pages/interact.html`);
    expect(result.origin).toBe(fixtures.baseUrl);
    expect(result.pageRevision).toBeGreaterThan(before);
  });

  it('produces semantic nodes with revision-scoped element refs and redacted secrets', async () => {
    const result = await snapshot(harness.session, tabId, 3000);
    expect(result.truncated).toBe(false);
    expect(result.snapshot.length).toBeGreaterThan(5);
    const counterButton = result.snapshot.find((node) => node.name.includes('Increment counter'));
    expect(counterButton?.elementRef).toMatch(new RegExp(`^el_${result.pageRevision}_`));
    const passwordField = result.snapshot.find((node) => node.name === 'Password');
    expect(passwordField?.valueRedacted).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain('hunter2-secret');
  });

  it('clicks a reversible control and marks the page dirty → next snapshot bumps revision', async () => {
    const snap1 = await snapshot(harness.session, tabId, 3000);
    const button = snap1.snapshot.find((node) => node.name.includes('Increment counter'));
    expect(button?.elementRef).toBeTruthy();
    const clickResult = await click(harness.session, tabId, button!.elementRef!, 10_000);
    expect(clickResult.changed).toBe(false); // same-page mutation
    const snap2 = await snapshot(harness.session, tabId, 3000);
    expect(snap2.pageRevision).toBe(snap1.pageRevision + 1);
  });

  it('stale element references fail deterministically with STALE_ELEMENT (§14, §30)', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const link = snap.snapshot.find((node) => node.name.includes('Go to second page'));
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/second.html`, 'load', 20_000);
    await expect(click(harness.session, tabId, link!.elementRef!, 5_000)).rejects.toMatchObject({
      code: 'STALE_ELEMENT',
      retryable: true,
    });
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
  });

  it('fills non-secret fields and selects options', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const query = snap.snapshot.find((node) => node.name === 'Search query');
    const fillResult = await fill(harness.session, tabId, query!.elementRef!, 'bulk lego', 10_000);
    expect(fillResult.filled).toBe(true);
    const snap2 = await snapshot(harness.session, tabId, 3000);
    const sort = snap2.snapshot.find((node) => node.name === 'Sort order');
    const selectResult = await select(harness.session, tabId, sort!.elementRef!, 'price_low', 10_000);
    expect(selectResult.selectedValue).toBe('price_low');
  });

  it('select on radio targets returns the APPLIED state, not the request (F-13)', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const usedRadio = snap.snapshot.find((node) => node.role === 'radio' && node.name === 'Condition used');
    expect(usedRadio?.elementRef).toBeTruthy();
    const result = await select(harness.session, tabId, usedRadio!.elementRef!, 'used', 10_000);
    expect(result.selectedValue).toBe('used'); // read back from el.checked/el.value
  });

  // 2026-09-04 wardrobe fire (gateway+connector_defect+snapshot-omits-pdp-
  // own-price-node): on Printful and Spreadshirt product pages the subject
  // product's price is styled text in a generic container, so the
  // interactive-element collector never saw it, while recommendation cards'
  // prices (inside their links) came back normally. Every price the run
  // recorded had to be read off a screenshot.
  it('a product page snapshot carries the subject price rendered as plain text (role text)', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/pdp-price.html`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    expect(snap.truncated).toBe(false);
    const priceNodes = snap.snapshot.filter((node) => node.text.includes('32.90'));
    // Exactly one node: the deepest element whose text is the amount, not
    // the price module, section and main that also contain it.
    expect(priceNodes).toHaveLength(1);
    expect(priceNodes[0]).toMatchObject({ role: 'text', text: 'C$ 32.90', href: null });
    expect(priceNodes[0]!.elementRef).toMatch(new RegExp(`^el_${snap.pageRevision}_`));
    // The hidden old price is not visible and stays out.
    expect(snap.snapshot.some((node) => node.text.includes('39.90'))).toBe(false);
    // Prose without an amount is not collected; the collector is for money-
    // like text, not every paragraph on the page.
    expect(snap.snapshot.some((node) => node.text.startsWith('Shipping is calculated'))).toBe(false);
    expect(snap.snapshot.some((node) => node.text === 'One print included')).toBe(false);
    // Card prices inside links are carried by the link node as before, once.
    const cardNodes = snap.snapshot.filter((node) => node.text.includes('59.99'));
    expect(cardNodes).toHaveLength(1);
    expect(cardNodes[0]!.role).toBe('link');
    // The interactive nodes are still there in document order around it.
    const order = snap.snapshot.map((node) => node.name);
    expect(order.indexOf('L')).toBeLessThan(order.indexOf('C$ 32.90'));
    expect(order.indexOf('C$ 32.90')).toBeLessThan(order.indexOf('Start designing'));
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
  });

  // 2026-09-03 wardrobe fire (gateway+coverage_gap+vistaprint-pricing-
  // module-never-hydrates): Vistaprint's "Size and quantity" module rendered
  // as a skeleton that never hydrated and no price appeared anywhere. The
  // route layer refuses every subresource from a host outside the
  // allowlist (packages/policy checkUrl, context 'subresource'), logs it
  // at the agent, and tells the caller nothing — so the run could not name
  // the host the roster rule would have added. The tally now rides on the
  // navigate result and on browser_wait.
  it('navigate names the subresource origins the policy refused, grouped by origin', async () => {
    const result = await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/blocked-assets.html`, 'load', 20_000);
    expect(result.navigationStatus).toBe('committed');
    const origins = result.blockedSubresources.map((entry) => entry.origin).sort();
    expect(origins).toEqual(['https://cdn.example.net', 'https://example.com']);
    const images = result.blockedSubresources.find((entry) => entry.origin === 'https://example.com');
    expect(images).toMatchObject({ code: 'ORIGIN_DENIED', requests: 2 });
    expect(images?.exampleUrl).toMatch(/^https:\/\/example\.com\/pixel-[12]\.png$/);
    // The local image loaded and is not listed.
    expect(result.blockedSubresources.some((entry) => entry.origin === fixtures.baseUrl)).toBe(false);
  });

  it('browser_wait reports refusals that happened after the navigation settled', async () => {
    const waited = await waitFor(harness.session, tabId, { networkIdleMs: 400 }, 10_000);
    expect(waited.satisfied).toBe(true);
    const late = waited.blockedSubresources.find((entry) => entry.origin === 'https://api.example.org');
    expect(late).toMatchObject({ code: 'ORIGIN_DENIED', requests: 1, exampleUrl: 'https://api.example.org/prices' });
    // The earlier refusals are still in the tally: it resets on the next
    // main-frame navigation, not per call.
    expect(waited.blockedSubresources.some((entry) => entry.origin === 'https://example.com')).toBe(true);
  });

  it('the tally resets on the next navigation and is empty on a page that loads clean', async () => {
    const result = await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    expect(result.blockedSubresources).toEqual([]);
    const waited = await waitFor(harness.session, tabId, { text: 'Interaction fixture' }, 5_000);
    expect(waited.blockedSubresources).toEqual([]);
  });

  // 2026-09-03 wardrobe fire (gateway+coverage_gap+spreadshirt-onetrust-
  // overlay-blocks-all-clicks): every browser_click on spreadshirt.ca burned
  // ~15 s and came back INTERNAL_ERROR, with the cause — "<div
  // class="onetrust-pc-dark-filter"> … intercepts pointer events" — buried
  // in Playwright's call log. The overlay outlived the visible dialog and
  // was not in the accessibility tree, so no snapshot could warn the run.
  it('a click a persistent non-consent overlay intercepts fails fast with CLICK_INTERCEPTED naming the overlay', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html?overlay=modal`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name === 'Redeem Code Now');
    expect(button?.elementRef).toBeTruthy();
    const started = Date.now();
    let caught: BridgeError | null = null;
    try {
      await click(harness.session, tabId, button!.elementRef!, 15_000);
    } catch (err) {
      caught = err as BridgeError;
    }
    const elapsed = Date.now() - started;
    expect(caught?.code).toBe('CLICK_INTERCEPTED');
    expect(caught?.retryable).toBe(false);
    expect(String(caught?.details.interceptor)).toContain('modal-veil');
    expect(caught?.message).toContain('modal-veil');
    expect(caught?.details.consentDismissal).toBeNull();
    // Well inside the 15 s the fire paid per click.
    expect(elapsed).toBeLessThan(8_000);
    // The click never landed.
    expect(await harness.session.getTab(tabId).page.textContent('#state')).toBe('idle');
  });

  it('an overlay that clears itself within the probe window does not fail the click', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html?transient=1`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name === 'Redeem Code Now');
    const result = await click(harness.session, tabId, button!.elementRef!, 15_000);
    expect(result.changed).toBe(false);
    expect(await harness.session.getTab(tabId).page.textContent('#state')).toBe('redeemed');
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
  });

  // Operator decision 2026-09-04 ("yes the agent may dismiss consent
  // banners"), the policy half of the same wardrobe report: a consent SDK's
  // overlay is cleared rather than reported, in the order reject → close →
  // accept → remove, and the result says which.
  it('browser_dismiss_consent prefers a reject control and reports it', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html?dialog=reject`, 'load', 20_000);
    const result = await dismissConsent(harness.session, tabId, 10_000);
    expect(result).toMatchObject({ dismissed: true, method: 'rejected', sdk: 'onetrust', control: 'Reject All' });
    expect(await harness.session.getTab(tabId).page.textContent('#consent-state')).toBe('rejected');
    // The page is usable afterwards.
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name === 'Redeem Code Now');
    const clicked = await click(harness.session, tabId, button!.elementRef!, 15_000);
    expect(clicked.consentDismissed).toBeNull();
    expect(await harness.session.getTab(tabId).page.textContent('#state')).toBe('redeemed');
  });

  it('browser_dismiss_consent accepts only when no reject or close control exists, by wording', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html?dialog=accept`, 'load', 20_000);
    const result = await dismissConsent(harness.session, tabId, 10_000);
    expect(result).toMatchObject({ dismissed: true, method: 'accepted', sdk: 'onetrust', control: 'Agree' });
    expect(await harness.session.getTab(tabId).page.textContent('#consent-state')).toBe('accepted');
  });

  it('browser_dismiss_consent removes a known SDK overlay that rendered no control (the Spreadshirt shape)', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html`, 'load', 20_000);
    const result = await dismissConsent(harness.session, tabId, 10_000);
    expect(result.dismissed).toBe(true);
    expect(result.method).toBe('removed');
    expect(result.sdk).toBe('onetrust');
    expect(result.control).toContain('onetrust');
    // Nothing was consented to: the fixture's consent state never settled.
    expect(await harness.session.getTab(tabId).page.textContent('#consent-state')).toBe('pending');
    expect(await harness.session.getTab(tabId).page.locator('.onetrust-pc-dark-filter').count()).toBe(0);
  });

  it('browser_dismiss_consent reports nothing to dismiss on a page without a banner', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    const result = await dismissConsent(harness.session, tabId, 5_000);
    expect(result).toMatchObject({ dismissed: false, method: null, sdk: null, control: null });
  });

  it('a click a consent banner intercepts dismisses the banner, retries once, and says so', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html?dialog=reject`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name === 'Redeem Code Now');
    const result = await click(harness.session, tabId, button!.elementRef!, 15_000);
    expect(result.consentDismissed).toMatchObject({ method: 'rejected', sdk: 'onetrust', control: 'Reject All' });
    expect(await harness.session.getTab(tabId).page.textContent('#state')).toBe('redeemed');
    // The control-less overlay is removed on the way to the click, too.
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/overlay.html`, 'load', 20_000);
    const snap2 = await snapshot(harness.session, tabId, 3000);
    const button2 = snap2.snapshot.find((node) => node.name === 'Redeem Code Now');
    const result2 = await click(harness.session, tabId, button2!.elementRef!, 15_000);
    expect(result2.consentDismissed?.method).toBe('removed');
    expect(await harness.session.getTab(tabId).page.textContent('#state')).toBe('redeemed');
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
  });

  // 2026-09-04 20:00Z deals fire (site-kijiji+extractor_defect+seller-profile-
  // page-renders-no-listings-at-domcontentloaded): a page captured at
  // domcontentloaded held only site chrome; its listings rendered later.
  it('a domcontentloaded capture misses client-rendered links that a bounded attached-wait then finds', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/hydrated-links.html?delay=600`, 'domcontentloaded', 20_000);
    const tab = harness.session.getTab(tabId);
    const adLinks = () => tab.page.$$eval('a[href*="/v-"]', (anchors) => anchors.length);
    // The serialized HTML carries the links only inside the script's source
    // text; the DOM — what the extractor's anchor scan reads — has none yet.
    expect(await adLinks()).toBe(0);
    const waited = await waitForAttached(tab, 'a[href*="/v-"]', 5_000);
    expect(waited.found).toBe(true);
    expect(waited.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(waited.elapsedMs).toBeLessThan(5_000);
    expect(await adLinks()).toBe(3);
  });

  it('the attached-wait reports not-found at its deadline instead of throwing', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/hydrated-links.html?delay=60000`, 'domcontentloaded', 20_000);
    const tab = harness.session.getTab(tabId);
    const waited = await waitForAttached(tab, 'a[href*="/v-"]', 700);
    expect(waited.found).toBe(false);
    expect(waited.elapsedMs).toBeGreaterThanOrEqual(600);
  });

  it('the tab automation last touched reports active=true (F-11)', async () => {
    await snapshot(harness.session, tabId, 3000);
    const tabs = await harness.session.listTabs();
    expect(tabs.find((tab) => tab.tabId === tabId)?.active).toBe(true);
  });

  // 2026-09-02 wardrobe fire (windows-agent+connector_defect+zazzle-
  // personalize-button-newtab-not-capturable): a "(opens in new tab)"
  // control was clicked, changed:false came back (correct — the ORIGINAL tab
  // did not change) and browser_tabs never listed a second tab. Nothing in
  // the click result said whether a popup was opened, adopted, or denied by
  // the URL policy and closed. Now the result carries the popup's fate.
  it('a click that opens a same-profile popup reports the adopted tab, and browser_tabs lists it', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    const link = snap.snapshot.find((node) => node.name.includes('Open second page in new tab'));
    expect(link?.elementRef).toBeTruthy();
    const before = (await harness.session.listTabs()).length;
    const result = await click(harness.session, tabId, link!.elementRef!, 10_000);
    expect(result.changed).toBe(false);
    expect(result.openedTab).not.toBeNull();
    expect(result.openedTab?.url).toBe(`${fixtures.baseUrl}/pages/second.html`);
    expect(result.popupDenied).toBeNull();
    const tabs = await harness.session.listTabs();
    expect(tabs.length).toBe(before + 1);
    expect(tabs.some((tab) => tab.tabId === result.openedTab?.tabId)).toBe(true);
    // The original tab stays the active one; the popup is reachable by id.
    const popup = harness.session.getTab(result.openedTab!.tabId);
    await popup.page.close();
    harness.session.getTab(tabId);
  });

  it('a click whose popup targets a host outside the allowlist reports the denial instead of losing it', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const link = snap.snapshot.find((node) => node.name.includes('Open external design tool in new tab'));
    expect(link?.elementRef).toBeTruthy();
    const before = (await harness.session.listTabs()).length;
    const result = await click(harness.session, tabId, link!.elementRef!, 10_000);
    expect(result.openedTab).toBeNull();
    expect(result.popupDenied).toBe('https://example.com/design-tool');
    expect((await harness.session.listTabs()).length).toBe(before);
  });

  // 2026-09-03 wardrobe re-file (same fingerprint, agent rebuilt, ClickOutput
  // live): Zazzle's "Personalize this design. (opens in new tab)" control
  // still came back {openedTab:null, popupDenied:null}. It is a <button>
  // whose handler calls window.open, not an anchor with target=_blank: the
  // popup wait was a 400 ms grace that started BEFORE the click, so a popup
  // that surfaced after the click's own actionability work was never seen.
  it('a button whose script opens a window after the click still reports the adopted tab', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name.includes('Personalize this design'));
    expect(button?.role).toBe('button');
    const before = (await harness.session.listTabs()).length;
    const result = await click(harness.session, tabId, button!.elementRef!, 10_000);
    expect(result.changed).toBe(false);
    expect(result.popupDenied).toBeNull();
    expect(result.openedTab).not.toBeNull();
    expect(result.openedTab?.url).toBe(`${fixtures.baseUrl}/pages/second.html`);
    const tabs = await harness.session.listTabs();
    expect(tabs.length).toBe(before + 1);
    await harness.session.getTab(result.openedTab!.tabId).page.close();
  });

  // 2026-09-03 wardrobe Lane B fire (gateway+connector_defect+browser-
  // snapshot-omits-href-on-links): on roster hosts with no extractor a
  // rendered listing grid was a dead end — link nodes carried a name and a
  // price but no destination, so no product page could be reached except
  // by guessing URLs or clicking through a consent overlay.
  it('link nodes carry their resolved absolute href; non-links carry null', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const link = snap.snapshot.find((node) => node.name === 'Go to second page');
    expect(link?.role).toBe('link');
    expect(link?.href).toBe(`${fixtures.baseUrl}/pages/second.html`);
    const external = snap.snapshot.find((node) => node.name.includes('Open external design tool'));
    expect(external?.href).toBe('https://example.com/design-tool');
    const button = snap.snapshot.find((node) => node.name.includes('Increment counter'));
    expect(button?.href).toBeNull();
    const checkout = snap.snapshot.find((node) => node.name === 'Proceed to checkout');
    expect(checkout?.role).toBe('button');
    expect(checkout?.href).toBe(`${fixtures.baseUrl}/checkout/start`);
  });

  it('an ordinary click reports no popup', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const button = snap.snapshot.find((node) => node.name.includes('Increment counter'));
    const result = await click(harness.session, tabId, button!.elementRef!, 10_000);
    expect(result.openedTab).toBeNull();
    expect(result.popupDenied).toBeNull();
  });

  it('scrolls and reports positions; sends allowed keys only', async () => {
    const scrolled = await scroll(harness.session, tabId, 0, 800);
    expect(scrolled.scrollY).toBeGreaterThan(0);
    const key = await pressKey(harness.session, tabId, 'Home');
    expect(key.sent).toBe(true);
    await expect(pressKey(harness.session, tabId, 'F12')).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  });

  it('waits for text and url conditions; times out with CONDITION_TIMEOUT', async () => {
    const text = await waitFor(harness.session, tabId, { text: 'Interaction fixture' }, 5_000);
    expect(text.satisfied).toBe(true);
    await expect(
      waitFor(harness.session, tabId, { text: 'THIS TEXT DOES NOT EXIST ANYWHERE' }, 800),
    ).rejects.toMatchObject({ code: 'CONDITION_TIMEOUT', retryable: true });
  });
});

describe('local policy enforcement in a real DOM (§19, §27.2)', () => {
  it('blocks protected transaction clicks (Buy It Now / Place bid / checkout)', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    for (const label of ['Buy It Now', 'Place bid', 'Make offer', 'Proceed to checkout']) {
      const node = snap.snapshot.find((candidate) => candidate.name === label);
      expect(node, label).toBeTruthy();
      await expect(click(harness.session, tabId, node!.elementRef!, 5_000), label).rejects.toMatchObject({
        code: 'ACTION_BLOCKED',
      });
    }
  });

  it('blocks secret fields on fill and never returns their values (§19.3)', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const password = snap.snapshot.find((node) => node.name === 'Password');
    await expect(fill(harness.session, tabId, password!.elementRef!, 'x', 5_000)).rejects.toMatchObject({
      code: 'SECRET_FIELD_BLOCKED',
    });
    const otp = snap.snapshot.find((node) => node.name === 'One-time code');
    await expect(fill(harness.session, tabId, otp!.elementRef!, '123456', 5_000)).rejects.toMatchObject({
      code: 'SECRET_FIELD_BLOCKED',
    });
    const card = snap.snapshot.find((node) => node.name === 'Card number');
    await expect(fill(harness.session, tabId, card!.elementRef!, '4111', 5_000)).rejects.toMatchObject({
      code: 'SECRET_FIELD_BLOCKED',
    });
  });

  it('aborts protected endpoints at the network layer even via direct navigation (§19.2)', async () => {
    await expect(
      navigate(harness.session, tabId, `${fixtures.baseUrl}/checkout/start`, 'load', 10_000),
    ).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
  });

  it('denies navigation outside the profile allowlist (ORIGIN_DENIED)', async () => {
    await expect(
      navigate(harness.session, tabId, 'https://example.com/', 'load', 10_000),
    ).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
  });
});

describe('screenshots and gallery pipeline (FR-05/06, §16, §20.4)', () => {
  it('captures viewport and full-page PNG screenshots with dimensions', async () => {
    const viewport = await screenshot(harness.session, tabId, 'viewport', 'png', undefined, 30_000);
    expect(viewport.mimeType).toBe('image/png');
    expect(viewport.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(viewport.width).toBeGreaterThan(100);
    const fullPage = await screenshot(harness.session, tabId, 'full_page', 'png', undefined, 30_000);
    expect(fullPage.height).toBeGreaterThan(viewport.height);
  });

  it('captures element screenshots by ref and rejects stale refs', async () => {
    const snap = await snapshot(harness.session, tabId, 3000);
    const heading = snap.snapshot.find((node) => node.role === 'heading');
    const element = await screenshot(harness.session, tabId, 'element', 'png', heading!.elementRef!, 30_000);
    expect(element.width).toBeGreaterThan(10);
    await expect(
      screenshot(harness.session, tabId, 'element', 'png', 'el_0_999_zzz', 10_000),
    ).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
  });

  it('enumerates gallery images in order, dedupes size variants, fetches best resolution', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/itm/123456789012`, 'load', 20_000);
    const enumerated = await enumerateImages(harness.session, tabId, 'gallery', {
      gallerySelectors: ['.ux-image-carousel-container'],
      normalizeImageUrl: (url) => {
        const parsed = new URL(url);
        parsed.search = '';
        return { dedupKey: parsed.toString(), bestUrl: parsed.toString() };
      },
    });
    // 4 imgs on the page; the ?size variants of gallery-1 dedupe to one.
    expect(enumerated.images).toHaveLength(3);
    expect(enumerated.images.map((image) => image.order)).toEqual([0, 1, 2]);

    const fetched = await fetchImage(harness.session, tabId, enumerated.images[0]!.imageId, 20_000);
    expect(fetched.mimeType).toBe('image/png');
    expect(fetched.buffer.length).toBeGreaterThan(100);

    // Stale imageId after re-navigation
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);
    await expect(fetchImage(harness.session, tabId, enumerated.images[0]!.imageId, 10_000)).rejects.toMatchObject({
      code: 'STALE_ELEMENT',
    });
  });

  it('falls back to page-wide enumeration when no gallery selector matches', async () => {
    await navigate(harness.session, tabId, `${fixtures.baseUrl}/itm/123456789012`, 'load', 20_000);
    const pageScope = await enumerateImages(harness.session, tabId, 'page');
    expect(pageScope.images.length).toBeGreaterThanOrEqual(3);
  });
});
