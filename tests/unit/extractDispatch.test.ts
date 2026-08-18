/**
 * browser.extract page-kind dispatch (FR-15). The Fluxology scheduled runs
 * traverse eBay search results and seller stores and Kijiji radius search
 * pages, so extract must return structured candidate records for those page
 * kinds instead of refusing everything that is not a canonical item page.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import {
  BridgeError,
  ExtractOutput,
  WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
} from '@browser-bridge/protocol';
import { mergeSiteProfiles } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import {
  createLogger,
  executeCommand,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';
// Relative import; see kijijiExtract.test.ts for the tests/package.json rationale.
import { kijijiSiteProfile } from '../../packages/site-kijiji/src/index.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), 'utf8');
}

function stubSession(pageUrl: string, html: string): BrowserSessionRuntime {
  return {
    policy: { profile: mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile]) },
    enqueue: (fn: () => Promise<unknown>) => fn(),
    getTab: () => ({
      page: { url: () => pageUrl, content: async () => html },
      revision: 7,
    }),
  } as unknown as BrowserSessionRuntime;
}

function hostFor(session: BrowserSessionRuntime): ExecutorHost {
  const sessions: SessionHost = {
    open: () => Promise.reject(new Error('session_open is not exercised here')),
    resolve: () => session,
    listActive: () => [session],
    isDegraded: false,
  };
  return { sessions, logger: createLogger('fatal', 'extract-dispatch-test'), expectedPostalCode: 'M6H 2W9' };
}

function extractEnvelope(siteProfile: string): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: 'req-extract-1',
    deviceId: 'dev-1',
    browserSessionHandle: 'sess-1',
    tabId: 'tab-1',
    command: 'extract',
    arguments: { siteProfile },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: 'idem-extract-1',
    policyClass: 'read',
    traceparent: null,
  };
}

async function runExtract(pageUrl: string, html: string, siteProfile: string) {
  const session = stubSession(pageUrl, html);
  return executeCommand(hostFor(session), extractEnvelope(siteProfile));
}

describe('browser.extract dispatches by page kind instead of refusing', () => {
  it('eBay search results return an ordered candidate list', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/sch/i.html?_nkw=lego+minifig+lot&_sop=10',
      fixture('ebay', 'search-results.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('ebay.ca.v1');
    const record = parsed.record as {
      pageKind: string;
      candidateCount: number;
      candidates: { itemId: string; url: string }[];
    };
    expect(record.pageKind).toBe('search');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(record.candidates[0]!.itemId).toMatch(/^\d+$/);
    expect(record.candidates[0]!.url).toContain('/itm/');
    expect(parsed.warnings).toEqual([]);
  });

  it('eBay seller store pages return candidates for seller drill-downs', async () => {
    const outcome = await runExtract(
      'https://www.ebay.ca/str/tweedsidesales',
      fixture('ebay', 'seller-store.html'),
      'ebay.ca.v1',
    );
    const record = ExtractOutput.parse(outcome.result).record as { pageKind: string; candidateCount: number };
    expect(record.pageKind).toBe('store');
    expect(record.candidateCount).toBeGreaterThan(0);
  });

  it('only genuinely unsupported eBay pages refuse, with an actionable message', async () => {
    await expect(runExtract('https://www.ebay.ca/', '<html><body></body></html>', 'ebay.ca.v1')).rejects.toSatisfy(
      (error: unknown) => {
        expect(error).toBeInstanceOf(BridgeError);
        expect((error as BridgeError).code).toBe('SITE_PROFILE_MISMATCH');
        expect((error as BridgeError).message).toContain('/sch/');
        return true;
      },
    );
  });

  it('Kijiji search results return candidates plus next-page pagination', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45&address=M6H+2W9',
      fixture('kijiji', 'search-results.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    const record = parsed.record as {
      pageKind: string;
      candidateCount: number;
      candidates: { adId: string }[];
      hasNextPage: boolean;
      nextPageUrl: string | null;
    };
    expect(record.pageKind).toBe('search');
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(record.candidates[0]!.adId).toMatch(/^\d+$/);
    expect(record.hasNextPage).toBe(true);
    expect(record.nextPageUrl).toContain('page-2');
  });

  it('Kijiji ad (VIP) pages return the full extraction record', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/v-buy-sell/city-of-toronto/lego-friends-bulk-lot-5-lbs/1712345678',
      fixture('kijiji', 'vip-jsonld.html'),
      'kijiji.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    const record = parsed.record as { adId: { value: string } | null; listingStatus: string };
    expect(record.adId?.value).toBe('1712345678');
    expect(record.listingStatus).toBe('active');
  });

  it('a declared-profile mismatch downgrades to a warning, never a refusal', async () => {
    const outcome = await runExtract(
      'https://www.kijiji.ca/b-buy-sell/city-of-toronto/lego/c10l1700273?radius=45',
      fixture('kijiji', 'search-results.html'),
      'ebay.ca.v1',
    );
    const parsed = ExtractOutput.parse(outcome.result);
    expect(parsed.siteProfile).toBe('kijiji.ca.v1');
    expect(parsed.warnings.some((warning) => warning.startsWith('DECLARED_SITE_PROFILE_MISMATCH'))).toBe(true);
  });
});
