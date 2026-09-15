/**
 * eBay's bare "Error Page | eBay" shell on a /sch/ URL — improvement queue,
 * deals 2026-09-15T04:27Z file:
 *
 * - site-ebay+coverage_gap+live-sch-search-returns-error-page-stub-with-zero-
 *   candidates-and-renders-on-immediate-retry
 *
 * Two plain LIVE searches (no LH_Sold / LH_Complete) came back as the stub
 * with candidateCount 0 and NO_LISTING_CANDIDATES, and the identical URL
 * rendered 274 and 248 rows on an immediate retry. Before this test the
 * record could not tell that stub from a genuinely empty result set: both
 * were candidateCount 0 + NO_LISTING_CANDIDATES, and the meta warnings on
 * the stub asked the routine to capture a count heading and a pagination
 * widget the page never had.
 *
 * The fixture is SYNTHETIC (www.ebay.ca 403s dev boxes); its title text and
 * its one link's name and href are what the 2026-09-04 bounded snapshot of
 * the stub recorded, and the detector keys on those alone.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { ExtractOutput, WIRE_PROTOCOL_VERSION, type CommandEnvelope } from '@browser-bridge/protocol';
import { mergeSiteProfiles } from '@browser-bridge/policy';
import { ebaySiteProfile, readSearchErrorStub } from '@browser-bridge/site-ebay';
import { createLogger, executeCommand, type ExecutorHost, type SessionHost } from '@browser-bridge/windows-agent';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ebay');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

function documentOf(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

const LIVE_SEARCH_URL = 'https://www.ebay.ca/sch/i.html?_nkw=LTO-8+SAS+tape+drive&_sop=15';

function stubSession(pageUrl: string, html: string): BrowserSessionRuntime {
  return {
    policy: { profile: mergeSiteProfiles([ebaySiteProfile]) },
    enqueue: (fn: () => Promise<unknown>) => fn(),
    getTab: () => ({
      page: { url: () => pageUrl, content: async () => html },
      revision: 52,
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
  return { sessions, logger: createLogger('fatal', 'search-error-stub-test'), expectedPostalCode: 'M6H 2W9' };
}

function extractEnvelope(args: Record<string, unknown>): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: 'req-extract-stub',
    deviceId: 'dev-1',
    browserSessionHandle: 'sess-1',
    tabId: 'tab-1',
    command: 'extract',
    arguments: { siteProfile: 'ebay.ca.v1', ...args },
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: 'idem-extract-stub',
    policyClass: 'read',
    traceparent: null,
  };
}

async function runExtract(pageUrl: string, html: string, args: Record<string, unknown> = {}) {
  const session = stubSession(pageUrl, html);
  const outcome = await executeCommand(hostFor(session), extractEnvelope(args));
  return ExtractOutput.parse(outcome.result);
}

type SearchRecord = {
  pageKind: string;
  pageTitle: string;
  candidateCount: number;
  errorPageStub: boolean;
  totalResults: number | null;
  statedCount: number | null;
  hasNextPage: boolean | null;
};

describe('readSearchErrorStub — the bare Error Page | eBay shell', () => {
  it('recognises the stub by its title and its one homepage link', () => {
    const read = readSearchErrorStub(documentOf(fixture('search-error-page-stub.html')), 0);
    expect(read.isStub).toBe(true);
    expect(read.pageTitle).toBe('Error Page | eBay');
    expect(read.homepageLinkHref).toBe('https://www.ebay.com/');
  });

  it('is not the stub on an ordinary results page, whatever the row count', () => {
    const read = readSearchErrorStub(documentOf(fixture('search-results.html')), 3);
    expect(read.isStub).toBe(false);
    expect(read.homepageLinkHref).toBeNull();
  });

  it('is not the stub on a titleless empty page — an empty result set is not an error page', () => {
    const read = readSearchErrorStub(documentOf('<html><head><title>lto-8 | eBay</title></head><body><p>No exact matches found</p></body></html>'), 0);
    expect(read.isStub).toBe(false);
  });

  it('never declares a stub over rendered rows: rows are rows whatever the title says', () => {
    const read = readSearchErrorStub(documentOf(fixture('search-error-page-stub.html')), 2);
    expect(read.isStub).toBe(false);
    expect(read.pageTitle).toBe('Error Page | eBay');
  });
});

describe('browser_extract on the stub says SEARCH_ERROR_PAGE_STUB, not "an empty results page"', () => {
  it('names the stub and the retry, keeps candidateCount 0, and does not ask for a count-heading capture', async () => {
    const parsed = await runExtract(LIVE_SEARCH_URL, fixture('search-error-page-stub.html'));
    const record = parsed.record as SearchRecord;
    expect(record.pageKind).toBe('search');
    expect(record.pageTitle).toBe('Error Page | eBay');
    expect(record.candidateCount).toBe(0);
    expect(record.errorPageStub).toBe(true);
    // The page stated no total and no pagination; the fields stay null (the
    // honest answer), but the reason is the stub, not a selector miss.
    expect(record.totalResults).toBeNull();
    expect(record.statedCount).toBeNull();
    expect(record.hasNextPage).toBeNull();

    const codes = parsed.warnings.map((w) => w.split(':')[0]);
    expect(codes[0]).toBe('SEARCH_ERROR_PAGE_STUB');
    expect(codes).toContain('NO_LISTING_CANDIDATES');
    expect(codes).not.toContain('SEARCH_TOTAL_UNSTATED');
    expect(codes).not.toContain('SEARCH_PAGINATION_UNSTATED');

    const stubWarning = parsed.warnings.find((w) => w.startsWith('SEARCH_ERROR_PAGE_STUB'))!;
    expect(stubWarning).toContain('Error Page | eBay');
    expect(stubWarning).toContain('https://www.ebay.com/');
    expect(stubWarning).toContain('retry');
    expect(stubWarning).toContain(LIVE_SEARCH_URL);
    // A stub is not an empty result set and must never be recorded as one.
    expect(stubWarning).toMatch(/not (an? )?(empty|zero)/i);
  });

  it('survives a caller field projection — the flag is page-level, not a row field', async () => {
    const parsed = await runExtract(LIVE_SEARCH_URL, fixture('search-error-page-stub.html'), {
      search: { limit: 6, fields: ['itemId', 'title', 'snippetPrice', 'sellingFormat', 'shippingSnippetText'] },
    });
    const record = parsed.record as SearchRecord;
    expect(record.errorPageStub).toBe(true);
    expect(record.candidateCount).toBe(0);
    expect(parsed.warnings.some((w) => w.startsWith('SEARCH_ERROR_PAGE_STUB'))).toBe(true);
  });

  it('a genuinely empty results page still says NO_LISTING_CANDIDATES with errorPageStub false', async () => {
    const parsed = await runExtract(
      'https://www.ebay.ca/sch/i.html?_nkw=zzqx-no-such-thing&_sop=15',
      '<html><head><title>zzqx-no-such-thing for sale | eBay</title></head><body><h1 class="srp-controls__count-heading"><span class="BOLD">0</span> results for zzqx-no-such-thing</h1><p>No exact matches found</p></body></html>',
    );
    const record = parsed.record as SearchRecord;
    expect(record.errorPageStub).toBe(false);
    expect(record.candidateCount).toBe(0);
    const codes = parsed.warnings.map((w) => w.split(':')[0]);
    expect(codes).toContain('NO_LISTING_CANDIDATES');
    expect(codes).not.toContain('SEARCH_ERROR_PAGE_STUB');
  });

  it('a results page with rows carries errorPageStub false and no stub warning', async () => {
    const parsed = await runExtract('https://www.ebay.ca/sch/i.html?_nkw=lego+minifig+lot&_sop=10', fixture('search-results.html'));
    const record = parsed.record as SearchRecord;
    expect(record.errorPageStub).toBe(false);
    expect(record.candidateCount).toBeGreaterThan(0);
    expect(parsed.warnings.some((w) => w.startsWith('SEARCH_ERROR_PAGE_STUB'))).toBe(false);
  });
});
