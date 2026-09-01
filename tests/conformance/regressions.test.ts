/**
 * Regression pack (Prompt 0 Phase 4): the defects confirmed FIXED on
 * 2026-08-31 re-proven here as one suite, so none can quietly regress.
 *
 *   F1  dead URLs return ok:false + LISTING_UNAVAILABLE (retryable:false)
 *   F2  Kijiji imageCount counts the gallery; the static store badge is
 *       excluded
 *   F3  dashboard_feed filter.active partitions the feed disjointly and
 *       completely
 *
 * F1 also runs per-profile inside the conformance harness; F2/F3 also have
 * unit coverage (kijijiLiveDefects, dashboardClient). This file is the
 * single place a release check can point at for "the fixed list stays
 * fixed" — deliberately thin, real code paths, checked-in fixtures.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { DashboardClient } from '@browser-bridge/gateway';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import { extractKijijiListing } from '../../packages/site-kijiji/src/index.js';
import { commandEnvelope, statefulStub } from './harness.js';
import { executeCommand } from '@browser-bridge/windows-agent';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), 'utf8');
}

function vipDocument(name: string): Document {
  const { document } = parseHTML(fixture('kijiji', name));
  return document as unknown as Document;
}

describe('F1 — dead URLs occupy failed slots, never evidence', () => {
  it('an eBay unavailable page is ok:false, LISTING_UNAVAILABLE, retryable:false, record kept', async () => {
    const stub = statefulStub(
      ebaySiteProfile,
      'https://www.ebay.ca/sch/i.html?_nkw=x',
      () => fixture('ebay', 'unavailable-listing.html'),
    );
    const outcome = await executeCommand(
      stub.host,
      commandEnvelope('extract_many', {
        urls: ['https://www.ebay.ca/itm/198589141532'],
        siteProfile: 'ebay.ca.v1',
        mode: 'inline',
      }),
    );
    const [slot] = outcome.result.results as {
      ok: boolean;
      record: unknown;
      error: { code: string; retryable: boolean } | null;
    }[];
    expect(slot!.ok).toBe(false);
    expect(slot!.error).toMatchObject({ code: 'LISTING_UNAVAILABLE', retryable: false });
    expect(slot!.record).not.toBeNull();
    expect((outcome.result as { failed: number }).failed).toBe(1);
  });
});

describe('F2 — Kijiji imageCount matches the gallery, badge excluded', () => {
  it('contact-price live capture counts 6 gallery photos', () => {
    const { record } = extractKijijiListing(
      vipDocument('live-vip-contact-1730433251.html'),
      'https://www.kijiji.ca/v-buy-sell/city-of-toronto/x/1730433251',
      {},
    );
    expect(record.imageCount).toBe(6);
  });

  it('priced live capture counts 7 gallery photos (not 4, not badge-inflated)', () => {
    const { record } = extractKijijiListing(
      vipDocument('live-vip-priced-1740940278.html'),
      'https://www.kijiji.ca/v-buy-sell/city-of-toronto/x/1740940278',
      {},
    );
    expect(record.imageCount).toBe(7);
  });
});

describe('F3 — dashboard_feed filter.active partitions correctly', () => {
  const root = {
    schemaVersion: 3,
    listings: [
      { id: 'ebay-1', status: 'tracked', active: true },
      { id: 'ebay-2', status: 'ended', active: false },
      { id: 'kijiji-3', status: 'watching', active: true },
      { id: 'kijiji-4' }, // no flag: active by default, never lost
      { id: 'ebay-5', status: 'sold', active: false },
    ],
  };
  const client = new DashboardClient({
    baseUrl: 'http://dashboard-api.test/',
    tokens: { deals: 'tok' },
    fetchImpl: async () =>
      new Response(JSON.stringify(root), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });

  it('active:true and active:false are disjoint and sum to the whole feed', async () => {
    const active = await client.feed('deals', 'full', { filter: { active: true } });
    const retired = await client.feed('deals', 'full', { filter: { active: false } });
    const activeIds = (active.root.listings as { id: string }[]).map((l) => l.id);
    const retiredIds = (retired.root.listings as { id: string }[]).map((l) => l.id);
    expect(activeIds).toEqual(['ebay-1', 'kijiji-3', 'kijiji-4']);
    expect(retiredIds).toEqual(['ebay-2', 'ebay-5']);
    for (const id of activeIds) expect(retiredIds).not.toContain(id);
    expect(activeIds.length + retiredIds.length).toBe(root.listings.length);
    expect(active.totalListingCount).toBe(root.listings.length);
    expect(retired.totalListingCount).toBe(root.listings.length);
  });
});
