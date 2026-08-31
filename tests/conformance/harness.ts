/**
 * Site-profile conformance harness (test-suite Prompt 0, Phase 3).
 *
 * Every shipped site profile — and every profile added later — instantiates
 * `describeProfileConformance()` with a spec and must pass the same cases:
 *
 *   determinism   identical extracts at one pageRevision are byte-identical
 *   paging        offset/limit windows at one revision walk ONE list
 *   decay         repeated extracts stay identical or the revision bumps
 *   wait-refresh  browser.wait bumps the revision iff extractable content drifted
 *   absent        unreadable fields are explicit nulls plus a warning code
 *   fields        unknown `fields` names warn instead of vanishing
 *   dead pages    LISTING_UNAVAILABLE (retryable:false) vs CHALLENGE_PAGE
 *                 (retryable:true) are DISTINCT outcomes
 *   mismatch      declared-profile mismatch warns and auto-corrects
 *   bounds        offset past end, limit cap, empty pages, oversized batches,
 *                 bogus job ids, sinceIndex past end
 *   policy        allowlist, suffix-confusion, scheme, auth-path deny rules
 *                 (direct and per-redirect-hop contexts), protected-endpoint
 *                 anchoring (deny endpoints, never listing slugs)
 *
 * The page-pipeline cases drive the REAL executor stack (executeCommand →
 * executeExtract → pin → site extractors → compaction) over a stateful stub
 * tab whose content() the test mutates — the same trick a live marketplace
 * page plays, minus the network. The stub's goto() models the browser
 * contract (framenavigated bumps the revision and clears the pin), which the
 * real-browser integration file verifies against actual Chromium.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import {
  checkUrl,
  isProtectedEndpoint,
  type SitePolicyProfile,
} from '@browser-bridge/policy';
import { WIRE_PROTOCOL_VERSION, type CommandEnvelope } from '@browser-bridge/protocol';
import {
  createLogger,
  executeCommand,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';

export interface ProfileConformanceSpec {
  /** Wire enum id under test, e.g. 'ebay.ca.v1'. */
  profileId: string;
  /** A DIFFERENT wire enum id, for the declared-mismatch case. */
  mismatchDeclaredId: string;
  /** Production policy profile object (never a test fixture profile). */
  policyProfile: SitePolicyProfile;
  /** A search-results URL on the production host. */
  searchUrl: string;
  /** A canonical listing/ad URL on the production host. */
  listingUrl: string;
  /**
   * Search-page HTML variants. 'v1' fully enriched (>= 4 candidates);
   * 'degraded' same candidates with most enrichment stripped (post-
   * hydration decay); 'cosmetic' v1 plus changes extraction ignores.
   */
  searchHtml: (variant: 'v1' | 'degraded' | 'cosmetic') => string;
  /** Key candidates carry their snippet price under ('snippetPrice' | 'price'). */
  priceKey: string;
  /** Candidate key list expected present on every returned row. */
  requiredCandidateKeys: readonly string[];
  /** A dead/removed page for this profile and the URL it answers on. */
  unavailableHtml: string;
  unavailableUrl: string;
  /** A bot-challenge interstitial for this site. */
  challengeHtml: string;
  /** An empty search page (zero candidates). */
  emptySearchHtml: string;
  /** Policy case URLs. */
  offProfileUrl: string;
  suffixConfusionUrl: string;
  httpUrl: string;
  /** Auth URLs that must be ACTION_BLOCKED (include the post-redirect host form). */
  blockedAuthUrls: readonly string[];
  /** Listing/search URLs with auth-ish words in slugs that must stay allowed. */
  allowedLookalikeUrls: readonly string[];
  /** URLs that must match the transaction-endpoint deny rules. */
  protectedEndpointUrls: readonly string[];
  /** Listing URLs that must NOT match them (segment-anchoring guarantee). */
  unprotectedListingUrls: readonly string[];
  /**
   * URLs on hosts the profile permanently denies (deniedHosts) — ruled-out
   * vendors that must stay ORIGIN_DENIED even though deny-wins means no
   * allowlist widening can ever admit them. Optional; most profiles have none.
   */
  permanentlyDeniedUrls?: readonly string[];
}

// ---------------------------------------------------------------------------
// Stateful stub session — the page pipeline minus Playwright.
// ---------------------------------------------------------------------------

export interface StatefulStub {
  session: BrowserSessionRuntime;
  host: ExecutorHost;
  /** Replace what page.content() serves from now on. */
  setContent(fn: (url: string) => string): void;
  /** Times page.content() has been called (pin effectiveness). */
  contentCalls(): number;
  currentRevision(): number;
}

export function statefulStub(
  profile: SitePolicyProfile,
  initialUrl: string,
  initialContent: (url: string) => string,
): StatefulStub {
  let currentUrl = initialUrl;
  let contentFn = initialContent;
  let contentCalls = 0;

  const tab = {
    tabId: 'tab_CONFORMANCE000000000000001',
    revision: 1,
    dirty: false,
    lastBlock: null,
    imageRegistry: new Map(),
    extractionPin: null as unknown,
    page: {
      url: () => currentUrl,
      content: async () => {
        contentCalls += 1;
        return contentFn(currentUrl);
      },
      // goto models the real browser contract: a committed main-frame
      // navigation fires framenavigated, which bumps the revision and
      // clears the extraction pin (browser-core session.adoptPage).
      goto: async (url: string) => {
        currentUrl = url;
        tab.revision += 1;
        tab.dirty = false;
        tab.extractionPin = null;
        (tab.imageRegistry as Map<string, unknown>).clear();
        return {};
      },
      title: async () => 'stub',
      isClosed: () => false,
      waitForFunction: async () => undefined,
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      // Destination-flow probes (§20.1): the stub page renders no
      // destination indicator and no controls, so the flow reports
      // unverified without interacting.
      evaluate: async () => null,
      locator: () => {
        const empty = {
          count: async () => 0,
          isVisible: async () => false,
          click: async () => undefined,
          fill: async () => undefined,
        };
        return { first: () => empty };
      },
    },
  };

  const session = {
    handle: 'bs_conformance_000000000001',
    profileName: 'conformance-stub',
    policy: {
      profile,
      assertUrlAllowed: async () => ({ allowed: true }),
      checkUrl: async () => ({ allowed: true }),
      assertActionAllowed: () => undefined,
      assertFieldAllowed: () => undefined,
      isProtectedEndpoint: () => false,
      isSecretField: () => false,
    },
    enqueue: <T>(fn: () => Promise<T>) => fn(),
    getTab: () => tab,
  } as unknown as BrowserSessionRuntime;

  const sessions: SessionHost = {
    open: () => Promise.reject(new Error('session_open is not exercised by the conformance harness')),
    resolve: () => session,
    listActive: () => [session],
    isDegraded: false,
  };
  const host: ExecutorHost = {
    sessions,
    logger: createLogger('fatal', 'conformance-harness'),
    expectedPostalCode: 'M6H 2W9',
  };

  return {
    session,
    host,
    setContent: (fn) => {
      contentFn = fn;
    },
    contentCalls: () => contentCalls,
    currentRevision: () => tab.revision,
  };
}

let requestCounter = 0;

export function commandEnvelope(
  command: string,
  args: Record<string, unknown>,
): CommandEnvelope {
  requestCounter += 1;
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: `req-conformance-${requestCounter}`,
    deviceId: 'dev-conformance-1',
    browserSessionHandle: 'bs_conformance_000000000001',
    tabId: 'tab_CONFORMANCE000000000000001',
    command,
    arguments: args,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: `idem-conformance-${requestCounter}`,
    policyClass: 'read',
    traceparent: null,
  } as CommandEnvelope;
}

/** Public-address DNS stub so policy cases never do real lookups. */
const resolvePublic = async (): Promise<string[]> => ['93.184.216.34'];

interface CandidateRecord {
  candidates: Record<string, unknown>[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// The parameterized suite.
// ---------------------------------------------------------------------------

export function describeProfileConformance(spec: ProfileConformanceSpec): void {
  const extractArgs = (extra: Record<string, unknown> = {}) => ({
    siteProfile: spec.profileId,
    ...extra,
  });

  describe(`${spec.profileId} conformance`, () => {
    it('determinism: five identical extracts at one pageRevision are byte-identical', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const first = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      // The live page now "decays" under the tab — without the revision pin
      // every later call would see this instead.
      stub.setContent(() => spec.searchHtml('degraded'));
      const payloads = [JSON.stringify(first.result)];
      for (let i = 0; i < 4; i += 1) {
        const next = await executeCommand(
          stub.host,
          commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
        );
        payloads.push(JSON.stringify(next.result));
        expect(next.pageRevision).toBe(first.pageRevision);
      }
      for (const payload of payloads.slice(1)) expect(payload).toBe(payloads[0]);
      expect(stub.contentCalls()).toBe(1);
    });

    it('paging: offset/limit windows at one revision walk one coherent list', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const pageOne = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 2, offset: 0 } })),
      );
      stub.setContent(() => spec.searchHtml('degraded'));
      const pageTwo = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 2, offset: 2 } })),
      );
      const one = (pageOne.result.record as CandidateRecord).candidates.map((row) => row.url);
      const two = (pageTwo.result.record as CandidateRecord).candidates.map((row) => row.url);
      expect(one).toHaveLength(2);
      expect(two.length).toBeGreaterThan(0);
      for (const url of two) expect(one).not.toContain(url);
      expect(stub.contentCalls()).toBe(1);
      expect(pageTwo.pageRevision).toBe(pageOne.pageRevision);
    });

    it('decay: repeated extracts on one loaded page stay identical or bump the revision', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const baseline = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      for (const variant of ['degraded', 'degraded', 'degraded'] as const) {
        stub.setContent(() => spec.searchHtml(variant));
        const again = await executeCommand(
          stub.host,
          commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
        );
        const identical = JSON.stringify(again.result) === JSON.stringify(baseline.result);
        const bumped = (again.pageRevision ?? 0) > (baseline.pageRevision ?? 0);
        expect(identical || bumped).toBe(true);
        // And whichever arm holds, the pair must be consistent: same
        // revision REQUIRES identical bytes.
        if (!bumped) expect(identical).toBe(true);
      }
    });

    it('wait-refresh: browser.wait bumps the revision when extractable content drifted', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const before = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      stub.setContent(() => spec.searchHtml('degraded'));
      const waited = await executeCommand(
        stub.host,
        commandEnvelope('wait', { condition: { text: 'anything' }, timeoutMs: 1000 }),
      );
      expect(waited.result.pageRevision as number).toBeGreaterThan(before.pageRevision ?? 0);
      const after = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      expect(after.pageRevision).toBe(waited.result.pageRevision);
      expect(JSON.stringify(after.result)).not.toBe(JSON.stringify(before.result));
      const repeat = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      // Determinism holds again at the NEW revision.
      expect(JSON.stringify(repeat.result)).toBe(JSON.stringify(after.result));
    });

    it('wait-refresh: cosmetic churn does not bump the revision', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const before = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      stub.setContent(() => spec.searchHtml('cosmetic'));
      const waited = await executeCommand(
        stub.host,
        commandEnvelope('wait', { condition: { text: 'anything' }, timeoutMs: 1000 }),
      );
      expect(waited.result.pageRevision).toBe(before.pageRevision);
      const after = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      expect(JSON.stringify(after.result)).toBe(JSON.stringify(before.result));
    });

    it('absent is explicit: unreadable candidate fields are null plus a warning code', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('degraded'));
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
      );
      const record = outcome.result.record as CandidateRecord;
      expect(record.candidates.length).toBeGreaterThan(1);
      for (const candidate of record.candidates) {
        for (const key of spec.requiredCandidateKeys) {
          expect(candidate).toHaveProperty(key);
        }
      }
      const hasNullEnrichment = record.candidates.some(
        (candidate) => candidate.title === null || candidate[spec.priceKey] === null,
      );
      expect(hasNullEnrichment).toBe(true);
      const warnings = outcome.result.warnings as string[];
      expect(warnings.some((warning) => warning.startsWith('CANDIDATE_FIELDS_NULL'))).toBe(true);
    });

    it('unknown `fields` names warn instead of silently vanishing', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope(
          'extract',
          extractArgs({ search: { limit: 10, fields: ['url', 'snipetPrice-typo'] } }),
        ),
      );
      const warnings = outcome.result.warnings as string[];
      expect(
        warnings.some(
          (warning) =>
            warning.startsWith('UNKNOWN_FIELDS_IGNORED') && warning.includes('snipetPrice-typo'),
        ),
      ).toBe(true);
    });

    it('aliased `fields` names resolve without a warning', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope('extract', extractArgs({ search: { limit: 10, fields: ['url', 'price'] } })),
      );
      const warnings = outcome.result.warnings as string[];
      expect(warnings.some((warning) => warning.startsWith('UNKNOWN_FIELDS_IGNORED'))).toBe(false);
      const record = outcome.result.record as CandidateRecord;
      expect(record.candidates.some((candidate) => candidate.price !== undefined)).toBe(true);
    });

    it('dead pages: LISTING_UNAVAILABLE, retryable false, record retained', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.unavailableHtml);
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope('extract_many', {
          urls: [spec.unavailableUrl],
          siteProfile: spec.profileId,
          mode: 'inline',
        }),
      );
      const results = outcome.result.results as {
        ok: boolean;
        record: unknown;
        error: { code: string; retryable: boolean } | null;
      }[];
      expect(results).toHaveLength(1);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.error?.code).toBe('LISTING_UNAVAILABLE');
      expect(results[0]!.error?.retryable).toBe(false);
      expect(results[0]!.record).not.toBeNull();
    });

    it('challenge pages: CHALLENGE_PAGE, retryable true, distinct from unavailable', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, (url) =>
        url === spec.unavailableUrl ? spec.unavailableHtml : spec.challengeHtml,
      );
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope('extract_many', {
          urls: [spec.unavailableUrl, spec.listingUrl],
          siteProfile: spec.profileId,
          mode: 'inline',
        }),
      );
      const results = outcome.result.results as {
        url: string;
        ok: boolean;
        record: { pageKind?: string } | null;
        error: { code: string; retryable: boolean } | null;
      }[];
      expect(results).toHaveLength(2);
      const dead = results.find((slot) => slot.url === spec.unavailableUrl)!;
      const challenged = results.find((slot) => slot.url === spec.listingUrl)!;
      expect(dead.error?.code).toBe('LISTING_UNAVAILABLE');
      expect(dead.error?.retryable).toBe(false);
      expect(challenged.ok).toBe(false);
      expect(challenged.error?.code).toBe('CHALLENGE_PAGE');
      expect(challenged.error?.retryable).toBe(true);
      expect(challenged.error?.code).not.toBe(dead.error?.code);
    });

    it('declared-profile mismatch warns and auto-corrects, never refuses', async () => {
      const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
      const outcome = await executeCommand(
        stub.host,
        commandEnvelope('extract', {
          siteProfile: spec.mismatchDeclaredId,
          search: { limit: 5 },
        }),
      );
      expect(outcome.result.siteProfile).toBe(spec.profileId);
      const warnings = outcome.result.warnings as string[];
      expect(warnings.some((warning) => warning.startsWith('DECLARED_SITE_PROFILE_MISMATCH'))).toBe(true);
    });

    describe('bounds', () => {
      it('offset past the end returns an empty window, not an error', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
        const outcome = await executeCommand(
          stub.host,
          commandEnvelope('extract', extractArgs({ search: { limit: 5, offset: 200 } })),
        );
        const record = outcome.result.record as CandidateRecord & {
          returnedCount: number;
          hasMore: boolean;
        };
        expect(record.returnedCount).toBe(0);
        expect(record.candidates).toHaveLength(0);
        expect(record.hasMore).toBe(false);
      });

      it('the 240 limit cap is accepted', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
        const outcome = await executeCommand(
          stub.host,
          commandEnvelope('extract', extractArgs({ search: { limit: 240 } })),
        );
        expect((outcome.result.record as CandidateRecord).candidates.length).toBeGreaterThan(0);
      });

      it('a zero-result search reports NO_LISTING_CANDIDATES, not a failure', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.emptySearchHtml);
        const outcome = await executeCommand(
          stub.host,
          commandEnvelope('extract', extractArgs({ search: { limit: 10 } })),
        );
        const warnings = outcome.result.warnings as string[];
        expect(warnings.some((warning) => warning.startsWith('NO_LISTING_CANDIDATES'))).toBe(true);
        expect((outcome.result.record as CandidateRecord).candidates).toHaveLength(0);
      });

      it('a batch above EXTRACT_MANY_MAX_URLS is rejected at validation', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
        const urls = Array.from({ length: 26 }, (_, i) => `${spec.listingUrl}?n=${i}`);
        await expect(
          executeCommand(
            stub.host,
            commandEnvelope('extract_many', { urls, siteProfile: spec.profileId }),
          ),
        ).rejects.toThrow();
      });

      it('a bogus jobId fails with ARTIFACT_EXPIRED', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
        await expect(
          executeCommand(
            stub.host,
            commandEnvelope('job_status', { jobId: 'job_00000000000000000000000000' }),
          ),
        ).rejects.toMatchObject({ code: 'ARTIFACT_EXPIRED' });
      });

      it('sinceIndex past the end clamps to an empty slice', async () => {
        const stub = statefulStub(spec.policyProfile, spec.searchUrl, () => spec.searchHtml('v1'));
        const started = await executeCommand(
          stub.host,
          commandEnvelope('extract_many', {
            urls: [spec.listingUrl, `${spec.listingUrl}?n=2`, `${spec.listingUrl}?n=3`],
            siteProfile: spec.profileId,
            mode: 'job',
          }),
        );
        const jobId = started.result.jobId as string;
        expect(jobId).toBeTruthy();
        // The stub enqueue runs the traversal on the microtask queue; give
        // it a beat to finish, then poll far past the end.
        for (let i = 0; i < 50; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const poll = await executeCommand(
            stub.host,
            commandEnvelope('job_status', { jobId, sinceIndex: 500 }),
          );
          if (poll.result.status !== 'running') {
            expect(poll.result.results).toHaveLength(0);
            expect(poll.result.resultsFrom).toBe(poll.result.completed);
            return;
          }
        }
        throw new Error('stub batch job never finished');
      });
    });

    describe('policy', () => {
      const options = { resolve: resolvePublic };

      it('an off-profile host is ORIGIN_DENIED', async () => {
        const decision = await checkUrl(spec.offProfileUrl, spec.policyProfile, 'navigation', options);
        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe('ORIGIN_DENIED');
      });

      it('a suffix-confusion lookalike host is ORIGIN_DENIED', async () => {
        const decision = await checkUrl(
          spec.suffixConfusionUrl,
          spec.policyProfile,
          'navigation',
          options,
        );
        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe('ORIGIN_DENIED');
      });

      it('http:// is SCHEME_DENIED on a production profile', async () => {
        const decision = await checkUrl(spec.httpUrl, spec.policyProfile, 'navigation', options);
        expect(decision.allowed).toBe(false);
        expect(decision.errorCode).toBe('SCHEME_DENIED');
      });

      it('auth surfaces are ACTION_BLOCKED — for the requested URL and for a redirect hop', async () => {
        for (const url of spec.blockedAuthUrls) {
          for (const context of ['navigation', 'redirect'] as const) {
            const decision = await checkUrl(url, spec.policyProfile, context, options);
            expect(decision.allowed, `${url} (${context})`).toBe(false);
            expect(decision.errorCode, `${url} (${context})`).toBe('ACTION_BLOCKED');
          }
        }
      });

      it('listing slugs that merely contain auth-ish words stay reachable', async () => {
        for (const url of spec.allowedLookalikeUrls) {
          const decision = await checkUrl(url, spec.policyProfile, 'navigation', options);
          expect(decision.allowed, url).toBe(true);
        }
      });

      it('transaction endpoints stay denied', () => {
        for (const url of spec.protectedEndpointUrls) {
          expect(isProtectedEndpoint(url, spec.policyProfile), url).toBe(true);
        }
      });

      it('listing slugs never match the transaction-endpoint deny rules', () => {
        for (const url of spec.unprotectedListingUrls) {
          expect(isProtectedEndpoint(url, spec.policyProfile), url).toBe(false);
        }
      });

      it('the production profile carries no test escape hatches', () => {
        expect(spec.policyProfile.testOnly).toBeUndefined();
      });

      it('permanently denied hosts stay ORIGIN_DENIED (deny wins)', async () => {
        for (const url of spec.permanentlyDeniedUrls ?? []) {
          const decision = await checkUrl(url, spec.policyProfile, 'navigation', options);
          expect(decision.allowed, url).toBe(false);
          expect(decision.errorCode, url).toBe('ORIGIN_DENIED');
          expect(decision.reason ?? '', url).toContain('deny list');
        }
      });
    });
  });
}
