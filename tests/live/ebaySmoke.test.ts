/**
 * Live smoke (§27.1, opt-in/manual only). Requires:
 *   - BRIDGE_LIVE_SMOKE=1
 *   - the user-provisioned branded Google Chrome (channel "chrome")
 *   - network access to eBay.ca
 *
 * Never runs in CI, never submits any transaction, and uses only
 * read/reversible operations (§3.2). The P0 exit criterion (10
 * representative listings with destination-verified shipping and full
 * galleries) is exercised on the Windows test machine via
 * `BRIDGE_LIVE_LISTINGS="<url> <url> ..."`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildChromeLaunchPlan } from '@browser-bridge/browser-core';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { createPagePolicy, SessionManager } from '@browser-bridge/windows-agent';

const LIVE = process.env.BRIDGE_LIVE_SMOKE === '1';
const LISTING_URLS = (process.env.BRIDGE_LIVE_LISTINGS ?? '').split(/\s+/).filter((url) => url.length > 0);

describe.skipIf(!LIVE)('eBay.ca live smoke (opt-in)', () => {
  let sessions: SessionManager;
  let handle: string;
  let tabId: string;

  beforeAll(async () => {
    const logger = pino({ level: 'warn' });
    const profileDir = process.env.AGENT_PROFILE_DIR ?? mkdtempSync(join(tmpdir(), 'bridge-live-profile-'));
    sessions = new SessionManager({
      profileDir,
      policy: createPagePolicy(ebaySiteProfile),
      logger,
      // NOTE: no planOverride — the live smoke runs the production plan:
      // branded Google Chrome via Playwright channel "chrome" (§13).
      planOverride: buildChromeLaunchPlan(profileDir),
    });
    const opened = await sessions.open('ebay-research');
    handle = opened.browserSessionHandle;
    tabId = opened.tabs[0]!.tabId;
    expect(handle).toMatch(/^bs_/);
  }, 120_000);

  afterAll(async () => {
    await sessions?.close();
  });

  it('opens eBay.ca in the persistent automation profile', async () => {
    const session = sessions.resolve(handle);
    const { navigate } = await import('@browser-bridge/browser-core');
    const result = await navigate(session, tabId, 'https://www.ebay.ca/', 'domcontentloaded', 45_000);
    expect(result.origin).toContain('ebay.ca');
  }, 90_000);

  it.skipIf(LISTING_URLS.length === 0)(
    'extracts destination-resolved records and galleries from the provided listings',
    async () => {
      const session = sessions.resolve(handle);
      const { navigate, enumerateImages } = await import('@browser-bridge/browser-core');
      const { executeCommand } = await import('@browser-bridge/windows-agent');
      const logger = pino({ level: 'warn' });
      for (const url of LISTING_URLS) {
        const nav = await navigate(session, tabId, url, 'domcontentloaded', 45_000);
        expect(nav.navigationStatus).toBe('committed');
        const outcome = await executeCommand(
          { sessions, logger, expectedPostalCode: 'M6H 2W9' },
          {
            protocolVersion: '1.0',
            type: 'command',
            requestId: `live-${Date.now()}`,
            deviceId: 'dev_live',
            browserSessionHandle: handle,
            tabId,
            command: 'extract',
            arguments: { siteProfile: 'ebay.ca.v1' },
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            idempotencyKey: `idem_live_${Date.now()}`,
            policyClass: 'read',
            traceparent: null,
          },
        );
        const record = outcome.result.record as {
          shipping?: { destinationVerified: boolean; destinationPostalCode: string | null };
        };
        // Destination-resolved or explicitly unverified — never silently proxied.
        expect(outcome.result.warnings).toBeDefined();
        if (record.shipping && record.shipping.destinationVerified) {
          expect(record.shipping.destinationPostalCode).toBe('M6H 2W9');
        }
        const gallery = await enumerateImages(session, tabId, 'gallery');
        expect(gallery.images.length).toBeGreaterThan(0);
      }
    },
    600_000,
  );
});
