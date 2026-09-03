/**
 * Session ownership per profile (SDD §13: "one persistent context per
 * device/profile"). The 2026-09-03 wardrobe Lane A fire filed
 * gateway+connector_defect+browser-session-open-ignores-profilename-shared-
 * context: browser_session_open({profileName:'wardrobe-research'}) returned
 * the handle, the tab and the profileName of the Deals routine's
 * 'ebay-research' session, and the two concurrently scheduled routines then
 * drove ONE tab — pageRevision advanced on its own, browser_screenshot and
 * browser_images returned the other routine's site (its sibling report,
 * windows-agent+connector_defect+browser-read-surfaces-return-other-sites-
 * content). A profileName now names an isolated persistent context.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildTestLaunchPlan, navigate } from '@browser-bridge/browser-core';
import { DEFAULT_PROFILE_NAME } from '@browser-bridge/protocol';
import { createPagePolicy, SessionManager } from '@browser-bridge/windows-agent';
import { startFixtureServer, type FixtureServer } from '../helpers/fixtureServer.js';
import { resolveTestExecutablePath } from '../helpers/browserHarness.js';
import { makeFixtureProfile } from '../helpers/testProfile.js';

let fixtures: FixtureServer;
let sessions: SessionManager;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  sessions = new SessionManager({
    profileDir: mkdtempSync(join(tmpdir(), 'bridge-sm-profile-')),
    policy: createPagePolicy(makeFixtureProfile()),
    logger: pino({ level: 'silent' }),
    planOverride: buildTestLaunchPlan(mkdtempSync(join(tmpdir(), 'bridge-sm-userdata-')), resolveTestExecutablePath()),
  });
}, 120_000);

afterAll(async () => {
  await sessions?.close();
  await fixtures?.close();
});

describe('browser_session_open honours profileName (§13)', () => {
  it('a second profileName gets its own context, handle and tabs; the first keeps its own', async () => {
    const deals = await sessions.open(DEFAULT_PROFILE_NAME);
    expect(deals.profileName).toBe(DEFAULT_PROFILE_NAME);
    expect(deals.status).toBe('ready');
    const dealsTab = deals.tabs[0]!.tabId;
    await navigate(sessions.resolve(deals.browserSessionHandle), dealsTab, `${fixtures.baseUrl}/pages/interact.html`, 'load', 20_000);

    const wardrobe = await sessions.open('wardrobe-research');
    // Neither silently downgraded to the other profile nor sharing a tab.
    expect(wardrobe.profileName).toBe('wardrobe-research');
    expect(wardrobe.browserSessionHandle).not.toBe(deals.browserSessionHandle);
    expect(wardrobe.tabs.length).toBeGreaterThan(0);
    expect(wardrobe.tabs.map((tab) => tab.tabId)).not.toContain(dealsTab);

    // Driving the wardrobe tab does not move the deals tab.
    const wardrobeTab = wardrobe.tabs[0]!.tabId;
    await navigate(sessions.resolve(wardrobe.browserSessionHandle), wardrobeTab, `${fixtures.baseUrl}/pages/second.html`, 'load', 20_000);
    const dealsTabs = await sessions.resolve(deals.browserSessionHandle).listTabs();
    expect(dealsTabs.find((tab) => tab.tabId === dealsTab)?.url).toBe(`${fixtures.baseUrl}/pages/interact.html`);
    const wardrobeTabs = await sessions.resolve(wardrobe.browserSessionHandle).listTabs();
    expect(wardrobeTabs.find((tab) => tab.tabId === wardrobeTab)?.url).toBe(`${fixtures.baseUrl}/pages/second.html`);

    // Both handles resolve; both sessions are reported to the gateway.
    expect(sessions.listActive().map((session) => session.handle).sort()).toEqual(
      [deals.browserSessionHandle, wardrobe.browserSessionHandle].sort(),
    );
  }, 60_000);

  it('re-opening a profileName reuses its live session instead of launching another', async () => {
    const first = await sessions.open('wardrobe-research');
    const again = await sessions.open('wardrobe-research');
    expect(again.browserSessionHandle).toBe(first.browserSessionHandle);
    expect(again.profileName).toBe('wardrobe-research');
    expect(sessions.listActive()).toHaveLength(2);
  });

  it('a handle from another profile is SESSION_NOT_FOUND only when it is unknown, never cross-resolved', async () => {
    const deals = await sessions.open(DEFAULT_PROFILE_NAME);
    const wardrobe = await sessions.open('wardrobe-research');
    expect(sessions.resolve(deals.browserSessionHandle).profileName).toBe(DEFAULT_PROFILE_NAME);
    expect(sessions.resolve(wardrobe.browserSessionHandle).profileName).toBe('wardrobe-research');
    expect(() => sessions.resolve('bs_unknown')).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_FOUND' }) as never);
  });
});
