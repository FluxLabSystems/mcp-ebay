/**
 * Phase 2 batch traversal — browser_open_and_extract, browser_extract_many
 * and browser_job_status at the executor layer.
 *
 * The security assertions here are the ones that matter most: a batch tool
 * must not be a way to reach a URL browser_navigate would refuse. Every URL
 * a batch touches goes through browser-core's navigate(), which calls
 * session.policy.assertUrlAllowed(url, 'navigation') before the page is ever
 * asked to load anything, so the tests below use the REAL ebay.ca.v1 policy
 * profile and the real policy engine rather than a stub that would agree
 * with whatever the code did.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { WIRE_PROTOCOL_VERSION, type CommandEnvelope } from '@browser-bridge/protocol';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { kijijiSiteProfile } from '@browser-bridge/site-kijiji';
import {
  BatchJobStore,
  createLogger,
  createPagePolicy,
  executeCommand,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';

const HANDLE = 'bs_0123456789abcdefgh';
const TAB = 'tab_0123456789';

const ITEM_HTML = `<!doctype html><html><head>
<link rel="canonical" href="https://www.ebay.ca/itm/226123456789">
<title>LEGO bulk lot</title></head>
<body><h1 class="x-item-title__mainTitle">LEGO bulk lot 5 lbs</h1>
<div class="x-price-primary"><span class="ux-textspans">C $84.50</span></div>
</body></html>`;

const SEARCH_HTML = `<!doctype html><html><body><ul class="srp-results">${Array.from(
  { length: 12 },
  (_, i) =>
    `<li class="s-item"><a class="s-item__link" href="https://www.ebay.ca/itm/22610000000${i}?_skw=lego%20lot&itmmeta=01K3QJ8TZ4WQ9F0GJ7C&hash=item34f2b2%3Ag%3AAAOSw"><h3 class="s-item__title">LEGO Bulk Lot ${i} Mixed Bricks</h3></a><span class="s-item__price">C $${40 + i}.00</span></li>`,
).join('')}</ul></body></html>`;

/** Serial FIFO with the same ordering guarantee BrowserSessionRuntime gives. */
function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => undefined);
    return next;
  };
}

interface StubOptions {
  /** URL → served HTML. A URL absent here fails to load. */
  pages: Record<string, string>;
  /** Hostname → resolved addresses, for the real URL policy's DNS check. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Requested URL → URL the "server" 302s to (which must be in pages). */
  redirects?: Record<string, string>;
  /** Site policy profile; defaults to the eBay one. */
  profile?: typeof ebaySiteProfile;
}

interface Stub {
  session: BrowserSessionRuntime;
  host: ExecutorHost;
  /** Every URL page.goto() was actually asked to load. */
  navigations: string[];
  jobs: BatchJobStore;
}

function buildStub(options: StubOptions): Stub {
  const navigations: string[] = [];
  let currentUrl = 'https://www.ebay.ca/';
  let revision = 0;
  const page = {
    url: () => currentUrl,
    title: async () => 'eBay',
    content: async () => options.pages[currentUrl] ?? '<html><body></body></html>',
    goto: async (url: string) => {
      navigations.push(url);
      const landed = options.redirects?.[url] ?? url;
      if (!(landed in options.pages)) {
        throw new Error(`net::ERR_NAME_NOT_RESOLVED at ${url}`);
      }
      currentUrl = landed;
      revision += 1;
      return {};
    },
    // ensureDestination reads the rendered destination first; a page that
    // already shows M6H 2W9 short-circuits before any control is touched.
    evaluate: async () => 'M6H 2W9',
    waitForTimeout: async () => undefined,
  };
  const enqueue = serialQueue();
  const session = {
    handle: HANDLE,
    // The production policy engine over the production ebay.ca.v1 profile.
    policy: createPagePolicy(options.profile ?? ebaySiteProfile, {
      resolve: options.resolve ?? (async () => ['104.18.0.1']),
    }),
    enqueue,
    getTab: (tabId: string) => {
      if (tabId !== TAB) throw new Error('TAB_NOT_FOUND');
      return {
        tabId: TAB,
        page,
        get revision() {
          return revision;
        },
        dirty: false,
        lastBlock: null,
        blockedSubresources: new Map(),
      };
    },
    listTabs: async () => [],
  } as unknown as BrowserSessionRuntime;

  const sessions: SessionHost = {
    open: () => Promise.reject(new Error('session_open is not exercised here')),
    resolve: (handle: string) => {
      if (handle !== HANDLE) throw new Error('SESSION_NOT_FOUND');
      return session;
    },
    listActive: () => [session],
    isDegraded: false,
  };
  const jobs = new BatchJobStore({ retentionMs: 60_000 });
  return {
    session,
    navigations,
    jobs,
    host: {
      sessions,
      logger: createLogger('fatal', 'batch-tools-test'),
      expectedPostalCode: 'M6H 2W9',
      jobs,
    },
  };
}

function envelope(command: string, args: Record<string, unknown>, tabId: string | null = TAB): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: `req-${command}`,
    deviceId: 'dev-1',
    browserSessionHandle: HANDLE,
    tabId,
    command,
    arguments: args,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: `idem-${command}`,
    policyClass: 'reversible',
    traceparent: null,
  };
}

interface BatchProgress {
  mode: string;
  jobId: string | null;
  status: string;
  requested: number;
  completed: number;
  succeeded: number;
  failed: number;
  compact: boolean;
  resultsFrom: number;
  warnings: string[];
  results: {
    url: string;
    finalUrl: string | null;
    ok: boolean;
    record: Record<string, unknown> | null;
    error: { code: string; message: string; retryable: boolean } | null;
  }[];
}

async function drainJob(host: ExecutorHost, jobId: string): Promise<BatchProgress> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = (await executeCommand(host, envelope('job_status', { jobId }, null)))
      .result as unknown as BatchProgress;
    if (status.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('job never finished');
}

describe('browser_open_and_extract', () => {
  it('navigates and extracts in one call, adding finalUrl and navigationStatus', async () => {
    const url = 'https://www.ebay.ca/itm/226123456789';
    const stub = buildStub({ pages: { [url]: ITEM_HTML } });
    const outcome = await executeCommand(
      stub.host,
      envelope('open_and_extract', { url, siteProfile: 'ebay.ca.v1' }),
    );
    const result = outcome.result as { finalUrl: string; navigationStatus: string; record: Record<string, unknown> };
    expect(stub.navigations).toEqual([url]);
    expect(result.finalUrl).toBe(url);
    expect(result.navigationStatus).toBe('committed');
    // An item page returns the full provenance record, exactly as
    // browser_extract would; compaction is a search-page concern.
    expect(result.record.siteProfile).toBe('ebay.ca.v1');
    expect(result.record.observedAt).toBeDefined();
  });

  it('compacts a search page by default — the thing browser_extract will not do', async () => {
    const url = 'https://www.ebay.ca/sch/i.html?_nkw=lego+bulk+lot';
    const stub = buildStub({ pages: { [url]: SEARCH_HTML } });
    const compacted = (
      (await executeCommand(stub.host, envelope('open_and_extract', { url, siteProfile: 'ebay.ca.v1' })))
        .result as { record: Record<string, unknown> }
    ).record as { compacted: boolean; candidates: Record<string, unknown>[] };
    expect(compacted.compacted).toBe(true);
    expect(compacted.candidates[0]!.url).toBe('https://www.ebay.ca/itm/226100000000');
    expect(compacted.candidates[0]!.shippingSnippetText).toBeUndefined();

    // browser_extract on the same page, with no search object, is unchanged.
    const plain = (
      (await executeCommand(stub.host, envelope('extract', { siteProfile: 'ebay.ca.v1' })))
        .result as { record: Record<string, unknown> }
    ).record as { compacted?: boolean; candidates: { url: string }[] };
    expect(plain.compacted).toBeUndefined();
    expect(plain.candidates[0]!.url).toContain('itmmeta=');
  });

  it('refuses a URL outside the site allowlist before the page is asked to load it', async () => {
    const stub = buildStub({ pages: {} });
    await expect(
      executeCommand(
        stub.host,
        envelope('open_and_extract', { url: 'https://evil.example/itm/1', siteProfile: 'ebay.ca.v1' }),
      ),
    ).rejects.toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(stub.navigations).toEqual([]);
  });
});

describe('browser_extract_many', () => {
  const urls = [
    'https://www.ebay.ca/itm/226100000001',
    'https://www.ebay.ca/itm/226100000002',
  ];

  it('returns one compact record per URL inline for a batch that fits the deadline', async () => {
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML, [urls[1]!]: ITEM_HTML } });
    const progress = (await executeCommand(stub.host, envelope('extract_many', { urls, siteProfile: 'ebay.ca.v1' })))
      .result as unknown as BatchProgress;
    expect(progress.mode).toBe('inline');
    expect(progress.status).toBe('completed');
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(0);
    expect(stub.navigations).toEqual(urls);
    // Appendix A compact projection, not the provenance record.
    const record = progress.results[0]!.record!;
    expect(record.title).toBe('LEGO bulk lot 5 lbs');
    // The compact projection's shape, not the extractor's verdict — what
    // kind an item page reads as belongs to the site package's tests.
    expect(Object.keys(record.sellingFormat as object).sort()).toEqual(['bidCount', 'kind']);
    expect(record.observedAt).toBeUndefined();
  });

  it('compact: false returns the provenance records untouched', async () => {
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML } });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [urls[0]], siteProfile: 'ebay.ca.v1', compact: false }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.compact).toBe(false);
    expect(progress.results[0]!.record!.observedAt).toBeDefined();
  });

  it('one dead page occupies its own error slot and never fails the batch', async () => {
    const dead = 'https://www.ebay.ca/itm/226100000099';
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML, [urls[1]!]: ITEM_HTML } });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [urls[0], dead, urls[1]], siteProfile: 'ebay.ca.v1', mode: 'inline' }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.status).toBe('completed');
    expect(progress.results).toHaveLength(3);
    expect(progress.succeeded).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.results[1]!.ok).toBe(false);
    expect(progress.results[1]!.url).toBe(dead);
    expect(progress.results[1]!.error).not.toBeNull();
    // The batch kept going: the third URL was still traversed.
    expect(progress.results[2]!.ok).toBe(true);
  });

  it('an eBay error page that loads fine is ok:false, not a succeeded slot', async () => {
    // The 2026-08-30 connector test fed /itm/000000000000 to extract_many
    // and got back ok:true, succeeded:3 failed:0, with a record titled
    // "Discover error" — which an upsert-on-ok routine would have written
    // to the deals board as a listing.
    const dead = 'https://www.ebay.ca/itm/000000000000';
    const DEAD_HTML = `<!doctype html><html><head><title>Discover error</title></head>
<body><div class="ux-message__title">We looked everywhere.</div>
<h1>Discover error</h1><p>Think of this as an alternate route.</p></body></html>`;
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML, [dead]: DEAD_HTML } });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [urls[0], dead], siteProfile: 'ebay.ca.v1', mode: 'inline' }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.succeeded).toBe(1);
    expect(progress.failed).toBe(1);
    const slot = progress.results[1]!;
    expect(slot.ok).toBe(false);
    expect(slot.error?.code).toBe('LISTING_UNAVAILABLE');
    expect(slot.error?.retryable).toBe(false);
    // The record stays on the slot as evidence for retiring a stored id.
    expect(slot.record?.listingStatus).toBe('unavailable');
  });

  it('a Kijiji ad that redirects to its category page marked adRemoved is ok:false', async () => {
    const ad = 'https://www.kijiji.ca/v-toys-games/city-of-toronto/lego/1712345678';
    const searchLanding =
      'https://www.kijiji.ca/b-toys-games/city-of-toronto/c108l1700273?adRemoved=1712345678';
    const stub = buildStub({
      profile: kijijiSiteProfile,
      pages: { [searchLanding]: '<html><body><h1>Toys in Toronto</h1></body></html>' },
      redirects: { [ad]: searchLanding },
    });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [ad], siteProfile: 'kijiji.ca.v1', mode: 'inline' }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.failed).toBe(1);
    expect(progress.results[0]!.ok).toBe(false);
    expect(progress.results[0]!.error?.code).toBe('LISTING_UNAVAILABLE');
    expect(progress.results[0]!.error?.message).toContain('1712345678');
  });

  it('POLICY: a URL outside the allowlist is denied per URL, and never loaded', async () => {
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML } });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', {
          urls: [urls[0], 'https://evil.example/itm/1', 'http://www.ebay.ca/itm/3'],
          siteProfile: 'ebay.ca.v1',
          mode: 'inline',
        }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.results[1]!.ok).toBe(false);
    expect(progress.results[1]!.error?.code).toBe('ORIGIN_DENIED');
    // Plain http is refused by the same scheme rule browser_navigate uses.
    expect(progress.results[2]!.ok).toBe(false);
    expect(progress.results[2]!.error?.code).toBe('SCHEME_DENIED');
    // Only the allowed URL ever reached the browser.
    expect(stub.navigations).toEqual([urls[0]]);
  });

  it('POLICY: an allowlisted host that resolves into a private range is denied per URL', async () => {
    const stub = buildStub({
      pages: { [urls[0]!]: ITEM_HTML },
      // DNS rebinding: the host is on the allowlist but points inside.
      resolve: async (hostname: string) => (hostname === 'www.ebay.ca' ? ['127.0.0.1'] : ['104.18.0.1']),
    });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [urls[0]], siteProfile: 'ebay.ca.v1', mode: 'inline' }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.results[0]!.error?.code).toBe('PRIVATE_NETWORK_DENIED');
    expect(stub.navigations).toEqual([]);
  });

  it('reports that a concurrency request was coerced instead of quietly ignoring it', async () => {
    const stub = buildStub({ pages: { [urls[0]!]: ITEM_HTML } });
    const progress = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: [urls[0]], siteProfile: 'ebay.ca.v1', concurrency: 4 }),
      )
    ).result as unknown as BatchProgress;
    expect(progress.warnings.some((warning) => warning.startsWith('CONCURRENCY_COERCED'))).toBe(true);
  });
});

describe('browser_extract_many job promotion and browser_job_status', () => {
  const manyUrls = Array.from({ length: 6 }, (_, i) => `https://www.ebay.ca/itm/22610000010${i}`);
  const pages = Object.fromEntries(manyUrls.map((url) => [url, ITEM_HTML]));

  it('a batch too large for the call deadline is promoted to a job and polled to completion', async () => {
    const stub = buildStub({ pages });
    const accepted = (
      await executeCommand(stub.host, envelope('extract_many', { urls: manyUrls, siteProfile: 'ebay.ca.v1' }))
    ).result as unknown as BatchProgress;
    // Promotion happens on the call, before any traversal, so the caller
    // gets its jobId immediately.
    expect(accepted.mode).toBe('job');
    expect(accepted.status).toBe('running');
    expect(accepted.jobId).toMatch(/^job_/);
    expect(accepted.requested).toBe(6);

    const finished = await drainJob(stub.host, accepted.jobId!);
    expect(finished.status).toBe('completed');
    expect(finished.succeeded).toBe(6);
    expect(finished.results).toHaveLength(6);
    expect(stub.navigations).toEqual(manyUrls);
  });

  it('sinceIndex returns only the slots a poller has not read yet', async () => {
    const stub = buildStub({ pages });
    const accepted = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: manyUrls, siteProfile: 'ebay.ca.v1', mode: 'job' }),
      )
    ).result as unknown as BatchProgress;
    await drainJob(stub.host, accepted.jobId!);
    const tail = (
      await executeCommand(stub.host, envelope('job_status', { jobId: accepted.jobId, sinceIndex: 4 }, null))
    ).result as unknown as BatchProgress;
    expect(tail.completed).toBe(6);
    expect(tail.resultsFrom).toBe(4);
    expect(tail.results).toHaveLength(2);
  });

  it('mode "inline" forced past the deadline returns partial rather than failing', async () => {
    const stub = buildStub({ pages });
    // An envelope with almost no budget left: the executor's floor gives it
    // 1 s, which the first item consumes.
    const tight = envelope('extract_many', { urls: manyUrls, siteProfile: 'ebay.ca.v1', mode: 'inline' });
    const progress = (
      await executeCommand(stub.host, { ...tight, expiresAt: new Date(Date.now() + 400).toISOString() })
    ).result as unknown as BatchProgress;
    expect(progress.mode).toBe('inline');
    expect(['completed', 'partial']).toContain(progress.status);
    if (progress.status === 'partial') {
      expect(progress.warnings.some((warning) => warning.startsWith('BATCH_DEADLINE_REACHED'))).toBe(true);
      expect(progress.completed).toBeLessThan(6);
    }
  });

  it('an unknown or aged-out jobId is a catalogued error, not a crash', async () => {
    const stub = buildStub({ pages: {} });
    await expect(
      executeCommand(stub.host, envelope('job_status', { jobId: 'job_does_not_exist' }, null)),
    ).rejects.toMatchObject({ code: 'ARTIFACT_EXPIRED' });
  });

  it('a job belongs to the session that started it', async () => {
    const stub = buildStub({ pages });
    const accepted = (
      await executeCommand(
        stub.host,
        envelope('extract_many', { urls: manyUrls, siteProfile: 'ebay.ca.v1', mode: 'job' }),
      )
    ).result as unknown as BatchProgress;
    await drainJob(stub.host, accepted.jobId!);
    expect(stub.jobs.get(accepted.jobId!, 'bs_someoneelsessession1')).toBeUndefined();
    expect(stub.jobs.get(accepted.jobId!, HANDLE)).toBeDefined();
  });
});
