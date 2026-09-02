/**
 * Countdown API source — docs/COUNTDOWN-API-PLAN.md §2, §3 and §6.5.
 *
 * One instance per gateway process, built from GatewayConfig.countdown. It
 * owns the vendor client, the last-known credit balance and the reserve
 * gate in front of it, the named-destination mapping (the only two postal
 * codes the gateway ever sends), and the audit row every upstream call
 * leaves behind. The three handlers answer the ebay_api_* tools in their
 * catalogued output shapes; registerSourceTools in ./tools.ts is the MCP
 * face over them.
 *
 * Nothing here fetches a caller-supplied URL: a url input is screened
 * against the §2 policy and then handed to the vendor as its `url`
 * parameter. The vendor key lives in the client and never reaches a
 * result, an error, an audit row or a log line.
 */
import { buildAuditEvent, type AuditOutcome } from '@browser-bridge/audit';
import { compactItemRecord, compactSearchPage } from '@browser-bridge/compact';
import type { CountdownConfig } from '@browser-bridge/config';
import {
  BridgeError,
  EBAY_API_DEFAULT_SEARCH_COMPACTION,
  EBAY_API_SELLER_DESCRIPTION_MAX_CHARS,
  ebayDomainOfUrl,
  screenEbayUrl,
  type BatchExtractItem,
  type EbayApiCredits,
  type EbayApiDestination,
  type EbayApiDomain,
  type EbayApiExpectedFormat,
  type EbayApiItemsInputType,
  type EbayApiItemsOutputType,
  type EbayApiRetrievedUnder,
  type EbayApiSearchInputType,
  type EbayApiSearchOutputType,
  type EbayApiSellerInputType,
  type EbayApiSellerOutputType,
  type EbayUrlKind,
} from '@browser-bridge/protocol';
import { EBAY_API_SITE_PROFILE_ID } from '@browser-bridge/site-ebay';
import {
  CountdownClient,
  mapItem,
  mapSearchRows,
  mapSellerProfile,
  mergeSplitSearch,
  mergeWarnings,
  readPagination,
  type ApiListingCandidate,
  type CountdownCredits,
  type CountdownRequestType,
  type CountdownResult,
  type CountdownSearchParams,
  type SearchResponse,
} from '@browser-bridge/source-countdown';
import type { Logger } from 'pino';
import type { Store } from '../store/types.js';

export const SEARCH_TOOL_NAME = 'ebay_api_search';
export const ITEMS_TOOL_NAME = 'ebay_api_items';
export const SELLER_TOOL_NAME = 'ebay_api_seller';

/** The audit action class every upstream Countdown call is filed under. */
export const SOURCE_AUDIT_ACTION_CLASS = 'source';

/**
 * How long a refused search or item call trusts the remembered balance
 * before asking the vendor's free account endpoint again (assertCredits).
 */
export const CREDIT_PROBE_MIN_INTERVAL_MS = 60_000;

/**
 * Candidate keys kept when the caller names no `search.fields`. The
 * compactor's own eBay default was chosen for what a rendered result card
 * carries; an API row carries different things. shippingCost is the whole
 * point of a zip-scoped search, priceRange marks the tier lots a deals run
 * has to open, condition and sellerName feed the roster rules, and the two
 * fields an API row can never fill (bidCount, isNewListing) are left out so
 * they do not show up as "unreadable" on every page — the
 * BID_COUNT_UNAVAILABLE_FROM_SOURCE warning already says so once. Anything
 * else on a row is one `search.fields` entry away, exactly as on the Bridge.
 */
export const EBAY_API_DEFAULT_CANDIDATE_FIELDS: readonly string[] = [
  'itemId',
  'url',
  'title',
  'snippetPrice',
  'priceRange',
  'sellingFormat',
  'shippingCost',
  'condition',
  'itemLocationText',
  'sellerName',
];

/** The kinds of call the reserve gate tells apart; seller lookups are exempt. */
export type SourceCallKind = 'search' | 'items' | 'seller';

/** Who is calling, for the audit row — the same identity ladder the broker uses. */
export interface SourceCaller {
  subject: string | null;
  traceparent: string | null;
}

/**
 * The catalog deadline a call runs under, shared with the MCP layer that
 * enforces it: registerSourceTools (./tools.ts) races each handler against
 * its entry's timeoutMs and flips `expired` when the race is lost. The item
 * pool reads the flag before every vendor request, because once the caller
 * has been answered with SOURCE_UNAVAILABLE a request issued after that
 * spends a credit on a result nobody receives.
 */
export interface SourceDeadline {
  readonly deadlineMs: number;
  expired: boolean;
}

export interface CountdownSourceOptions {
  config: CountdownConfig;
  /** Audit rows go to store.audit, one per upstream call. */
  store: Pick<Store, 'audit'>;
  logger?: Logger;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Tests only: the client's retry backoff and its sleep. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Clock for observedAt stamps, audit rows and the account-probe throttle; defaults to the wall clock. */
  now?: () => Date;
}

interface LocationParams {
  customerLocation?: string;
  customerZipcode?: string;
}

interface SearchPlan {
  retrievedUnder: EbayApiRetrievedUnder;
  params: CountdownSearchParams;
}

interface ItemRef {
  /** The URL as the caller gave it (or built from its itemId); echoed on the slot so results line up with the input. */
  url: string;
  /** The WHATWG-normalised href, the only form handed to the vendor. */
  vendorUrl: string;
  domain: EbayApiDomain;
  expectedFormat: EbayApiExpectedFormat | undefined;
}

interface ItemSlot {
  slot: BatchExtractItem;
  requestId: string | null;
  credits: CountdownCredits | null;
  /** True when the reserve gate, not the vendor, refused this slot. */
  refusedByReserve: boolean;
  /** True when the tool deadline passed before the pool reached this slot; no vendor request was made. */
  unattempted: boolean;
}

interface ScreenedUrl {
  domain: EbayApiDomain;
  /** The parsed, normalised form — what the vendor is given. */
  href: string;
}

/** eBay's own query-string spelling of each listing filter. */
const EBAY_LISTING_FILTER_PARAM: Readonly<Record<EbayApiRetrievedUnder, string>> = {
  buy_it_now: 'LH_BIN',
  auction: 'LH_Auction',
  accepts_offers: 'LH_BO',
};

/** Uppercase, no whitespace: the vendor forwards the value to eBay unnormalised (§1.1). */
function compactZip(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function toInt(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.trunc(value);
}

/** One charged vendor response, with what its request costs by contract when the response does not say. */
interface SpentCredits {
  credits: CountdownCredits;
  /**
   * The credits the request costs by contract — one per page fetched, so 1
   * for a product or seller request and the pages fetched for a search —
   * used only when the vendor omitted credits_used_this_request.
   */
  contractCost: number;
}

/**
 * The credit figures a set of charged responses leaves behind.
 *
 * `used` and `remaining` are account-level, not per-call: the vendor's
 * credits_used is its month-to-date total (the 2026-09-02 live check saw
 * three parallel one-credit calls all report used 15), so the fold keeps
 * the highest `used` and the lowest `remaining` seen, because concurrent
 * requests answer in any order and the latest state is the one that
 * matters.
 *
 * `usedThisRequest` is this call's own spend: credits_used_this_request
 * summed over every response. A response that omits the figure is counted
 * at its contract cost — a successful vendor request is charged whether or
 * not it says so — and the sum is null only when no response carried the
 * figure at all, so an entirely assumed total is never reported as a
 * measured one. Failed requests are not in `seen` (the vendor documents
 * 402, 503 and its transient 500 as uncharged), so a call nothing answered
 * spent 0.
 */
function foldCredits(seen: readonly SpentCredits[]): EbayApiCredits {
  let used: number | null = null;
  let remaining: number | null = null;
  let spent = 0;
  let reported = false;
  for (const { credits, contractCost } of seen) {
    const u = toInt(credits.used);
    const r = toInt(credits.remaining);
    if (u !== null && (used === null || u > used)) used = u;
    if (r !== null && (remaining === null || r < remaining)) remaining = r;
    const thisRequest = toInt(credits.usedThisRequest);
    if (thisRequest !== null) reported = true;
    spent += Math.max(0, thisRequest ?? contractCost);
  }
  return { used, remaining, usedThisRequest: seen.length > 0 && !reported ? null : spent };
}

/** `request_metadata.ebay_url`, or the first page's URL when max_page > 1 moved it into `pages[]` (§1.2). */
function pageUrlOf(body: SearchResponse): string | null {
  const metadata = body.request_metadata;
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata.ebay_url === 'string' && metadata.ebay_url.length > 0) return metadata.ebay_url;
  const first = metadata.pages?.[0];
  return typeof first?.ebay_url === 'string' && first.ebay_url.length > 0 ? first.ebay_url : null;
}

/**
 * The listing filter a caller's /sch/ URL already declares. The vendor
 * ignores `listing_type` beside `url` (§1.1), so the filter can only live
 * in the URL's own query string: LH_Auction=1 alone is an auction search,
 * LH_BIN=1 alone a buy-it-now search, and neither or both is unfiltered.
 */
function listingFilterOfUrl(url: string): EbayApiRetrievedUnder | null {
  const params = new URL(url).searchParams;
  const auction = params.get('LH_Auction') === '1';
  const bin = params.get('LH_BIN') === '1';
  if (auction && !bin) return 'auction';
  if (bin && !auction) return 'buy_it_now';
  return null;
}

/** The same URL constrained to one listing filter; every other parameter is kept. */
function withListingFilter(url: string, filter: EbayApiRetrievedUnder): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('LH_Auction');
  parsed.searchParams.delete('LH_BIN');
  parsed.searchParams.set(EBAY_LISTING_FILTER_PARAM[filter], '1');
  return parsed.toString();
}

/**
 * The vendor requests one search input costs. `listingType: 'all'` is two
 * filtered requests, buy_it_now then auction, merged by item id afterwards:
 * an unfiltered vendor search reports is_auction false on live auctions
 * (§1.3), so one is never issued. A url search that already carries one
 * filter is one request under that filter; one that carries none gets the
 * filter added to its query string, twice. `url` is the screened,
 * normalised href of a url search, null for a term search.
 */
function buildSearchPlans(
  input: EbayApiSearchInputType,
  domain: EbayApiDomain,
  location: LocationParams,
  url: string | null,
): SearchPlan[] {
  const common: CountdownSearchParams = {
    num: input.num,
    ...(input.maxPage > 1 ? { maxPage: input.maxPage } : {}),
    ...location,
    allowRewrittenResults: input.allowRewrittenResults,
  };
  const filters: EbayApiRetrievedUnder[] = input.listingType === 'all' ? ['buy_it_now', 'auction'] : [input.listingType];
  if (url !== null) {
    const declared = listingFilterOfUrl(url);
    if (declared !== null) return [{ retrievedUnder: declared, params: { ...common, url } }];
    return filters.map((filter) => ({ retrievedUnder: filter, params: { ...common, url: withListingFilter(url, filter) } }));
  }
  return filters.map((filter) => ({
    retrievedUnder: filter,
    params: {
      ...common,
      ebayDomain: domain,
      searchTerm: input.searchTerm,
      listingType: filter,
      ...(input.sortBy === undefined ? {} : { sortBy: input.sortBy }),
      ...(input.condition === 'all' ? {} : { condition: input.condition }),
      ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
      ...(input.page > 1 ? { page: input.page } : {}),
    },
  }));
}

/** Run `task(0..count-1)` through at most `concurrency` workers; results are the caller's to place by index. */
async function runPool(count: number, concurrency: number, task: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await task(index);
    }
  });
  await Promise.all(workers);
}

/** The mapper's own account of why a slot holds no listing, when it gave one. */
function unavailableMessage(warnings: readonly string[]): string {
  const stated = warnings.find((warning) => /^LISTING_(UNAVAILABLE|REDIRECTED):/.test(warning));
  return stated ?? 'The source returned no listing for this item.';
}

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The slot for an item the pool never requested because the tool deadline had passed. */
function unattemptedSlot(ref: ItemRef, deadline: SourceDeadline): ItemSlot {
  return {
    slot: {
      url: ref.url,
      finalUrl: null,
      ok: false,
      siteProfile: EBAY_API_SITE_PROFILE_ID,
      pageRevision: 0,
      record: null,
      warnings: [],
      error: {
        code: 'SOURCE_UNAVAILABLE',
        message: `Not requested: the tool deadline of ${deadline.deadlineMs} ms passed before the pool reached this item; re-issue it.`,
        retryable: true,
      },
    },
    requestId: null,
    credits: null,
    refusedByReserve: false,
    unattempted: true,
  };
}

export class CountdownSource {
  readonly creditReserve: number;
  readonly maxConcurrency: number;
  private readonly client: CountdownClient;
  private readonly config: CountdownConfig;
  private readonly store: Pick<Store, 'audit'>;
  private readonly logger: Logger | null;
  private readonly now: () => Date;
  /** The last accepted credits_remaining; null until a response says. */
  private remaining: number | null = null;
  /**
   * The highest cumulative credits_used accepted so far. Parallel responses
   * land in any order, so a balance is taken only from a response at least
   * this far along (see remember): without it, two requests reporting 501
   * then 499 left the memory at 501 whenever the 501 arrived last.
   */
  private lastUsed: number | null = null;
  /** When the account endpoint was last asked for the balance, on the injected clock; null until it was. */
  private lastProbeAt: number | null = null;
  /** The probe in flight, shared by every call that hits the gate while it runs. */
  private probeInFlight: Promise<void> | null = null;

  constructor(options: CountdownSourceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger ?? null;
    this.now = options.now ?? (() => new Date());
    this.creditReserve = options.config.creditReserve;
    this.maxConcurrency = options.config.maxConcurrency;
    this.client = new CountdownClient({
      apiKey: options.config.apiKey,
      baseUrl: options.config.baseUrl,
      timeoutMs: options.config.timeoutMs,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.retryDelaysMs === undefined ? {} : { retryDelaysMs: options.retryDelaysMs }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
  }

  /** Last known credits_remaining, for operators and tests; null when no response has said yet. */
  get creditsRemaining(): number | null {
    return this.remaining;
  }

  /**
   * The reserve gate (§2, Credits). Search and item calls are refused once
   * the last observed balance is below the reserve; seller lookups (one
   * credit, rare, and the confirmation step of the deals rules) still run.
   * An unknown balance never blocks: the first call of a process is how the
   * balance becomes known.
   *
   * A shut gate would never reopen on its own — nothing charged runs while
   * it is shut, so nothing would ever report the topped-up balance — so a
   * call about to be refused first re-reads the balance from the vendor's
   * free account endpoint, at most once a minute, and is refused only if
   * the fresh figure is still below the reserve.
   */
  async assertCredits(kind: SourceCallKind, caller?: SourceCaller): Promise<void> {
    if (kind === 'seller') return;
    if (this.belowReserve() && this.probeIsStale()) await this.probeAccount(kind, caller);
    if (!this.belowReserve()) return;
    throw new BridgeError(
      'SOURCE_CREDITS_EXHAUSTED',
      `Countdown API credit reserve reached: ${this.remaining} credit(s) remain, below the reserve of ${this.creditReserve}; ${kind} calls are refused until the balance is topped up (seller lookups still run).`,
      { creditsRemaining: this.remaining, creditReserve: this.creditReserve, kind, gate: true },
    );
  }

  private belowReserve(): boolean {
    return this.remaining !== null && this.remaining < this.creditReserve;
  }

  private probeIsStale(): boolean {
    return this.lastProbeAt === null || this.now().getTime() - this.lastProbeAt >= CREDIT_PROBE_MIN_INTERVAL_MS;
  }

  /** One probe at a time: the slots of a batch that all hit the gate together share it. */
  private probeAccount(kind: SourceCallKind, caller: SourceCaller | undefined): Promise<void> {
    if (this.probeInFlight === null) {
      this.probeInFlight = this.readAccount(kind, caller).finally(() => {
        this.probeInFlight = null;
      });
    }
    return this.probeInFlight;
  }

  /**
   * GET /account is free (§1.2) and authoritative, so its figures replace
   * the memory outright instead of passing through remember()'s ordering
   * rule: a renewed plan resets credits_used, which that rule would read as
   * a stale response. A failed probe changes nothing — the memory stands
   * and the gate stays shut — and either way the probe leaves an audit row
   * like every other upstream call.
   */
  private async readAccount(kind: SourceCallKind, caller: SourceCaller | undefined): Promise<void> {
    this.lastProbeAt = this.now().getTime();
    const toolName = kind === 'search' ? SEARCH_TOOL_NAME : ITEMS_TOOL_NAME;
    const startedAt = Date.now();
    try {
      const result = await this.client.account();
      this.lastUsed = toInt(result.credits.used);
      if (result.credits.remaining !== null) this.remaining = toInt(result.credits.remaining);
      await this.audit(toolName, 'account', caller, 'ok', null, result.requestId, {
        probe: true,
        httpStatus: result.httpStatus,
        attempts: result.attempts,
        creditsUsedThisRequest: null,
        creditsRemaining: result.credits.remaining,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const bridgeError = BridgeError.from(err);
      if (bridgeError.code === 'SOURCE_CREDITS_EXHAUSTED') this.remaining = 0;
      const status = bridgeError.details.status;
      const attempts = bridgeError.details.attempts;
      await this.audit(toolName, 'account', caller, 'error', bridgeError.code, null, {
        probe: true,
        httpStatus: typeof status === 'number' ? status : null,
        attempts: typeof attempts === 'number' ? attempts : null,
        creditsUsedThisRequest: null,
        creditsRemaining: this.remaining,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Remember a balance. A response's `remaining` is accepted only when its
   * cumulative `used` is null or at least the highest accepted so far, so
   * an older response that lands late cannot overwrite a newer one's figure.
   * The fold of a batch or a split search (highest used, lowest remaining)
   * goes through the same rule when the batch completes, so the memory ends
   * on the batch's true floor whatever order its responses arrived in.
   */
  private remember(credits: { used: number | null; remaining: number | null }): void {
    const used = toInt(credits.used);
    const remaining = toInt(credits.remaining);
    if (used !== null && this.lastUsed !== null && used < this.lastUsed) return;
    if (used !== null) this.lastUsed = used;
    if (remaining !== null) this.remaining = remaining;
  }

  /**
   * The vendor parameters a named destination stands for. A search carries
   * both the country and the postal code (eBay renders each card's shipping
   * for it via _stpos); a product request carries the country only, because
   * the vendor rejects customer_zipcode on type=product (§1.2).
   */
  locationFor(destination: EbayApiDestination, requestType: 'search' | 'product'): LocationParams {
    if (destination === 'domain_default') return {};
    const target = this.config.destinations[destination];
    if (requestType === 'product') return { customerLocation: target.customerLocation };
    return { customerLocation: target.customerLocation, customerZipcode: compactZip(target.customerZipcode) };
  }

  // ---- ebay_api_search (§3.1) --------------------------------------------

  async search(input: EbayApiSearchInputType, caller?: SourceCaller): Promise<EbayApiSearchOutputType> {
    await this.assertCredits('search', caller);
    const screened = input.url === undefined ? null : this.screenedUrl(input.url, ['search']);
    const domain = screened === null ? input.domain : screened.domain;
    const location = this.locationFor(input.destination, 'search');
    const plans = buildSearchPlans(input, domain, location, screened === null ? null : screened.href);
    const auditBase = { domain, destination: input.destination, ...location, page: input.page, maxPage: input.maxPage };

    // Both halves of a split search go out together: a page can take most
    // of a minute at the vendor, and the catalog deadline registerSourceTools
    // races the call against (SOURCE_SEARCH_TIMEOUT_MS) is sized for the two
    // in parallel, not one after the other.
    const responses = await Promise.all(
      plans.map(async (plan) => ({
        retrievedUnder: plan.retrievedUnder,
        result: await this.upstream(SEARCH_TOOL_NAME, 'search', caller, { ...auditBase, listingType: plan.retrievedUnder }, () =>
          this.client.search(plan.params),
        ),
      })),
    );
    const mapped = responses.map(({ retrievedUnder, result }) => ({
      retrievedUnder,
      rows: mapSearchRows({ body: result.body, domain, retrievedUnder, ...(input.url === undefined ? { page: input.page } : {}) }),
      pagination: readPagination(result.body),
      result,
    }));

    const first = mapped[0];
    const second = mapped[1];
    const candidates: ApiListingCandidate[] =
      first === undefined ? [] : second === undefined ? first.rows.value : mergeSplitSearch(first.rows.value, second.rows.value);

    // Pagination across the filters walked: a split search's total is the
    // sum of both filters' totals — an upper bound on the union, since a
    // row in both sets is counted twice — and it has a next page when
    // either filter does.
    const totals = mapped.map((entry) => entry.pagination.totalResults).filter((total): total is number => total !== null);
    const totalResults = totals.length === 0 ? null : totals.reduce((sum, total) => sum + total, 0);
    const pagesFetched = mapped.reduce((max, entry) => Math.max(max, entry.pagination.pagesFetched), 0);
    const flags = mapped.map((entry) => entry.pagination.hasNextPage);
    const hasNextPage = flags.some((flag) => flag === true) ? true : flags.every((flag) => flag === null) ? null : false;
    const pageUrl = first === undefined ? null : pageUrlOf(first.result.body);

    const compaction = input.search ?? EBAY_API_DEFAULT_SEARCH_COMPACTION;
    const compacted = compactSearchPage(
      {
        siteProfile: EBAY_API_SITE_PROFILE_ID,
        pageKind: 'search',
        pageUrl,
        totalResults,
        hasNextPage,
        candidateCount: candidates.length,
        candidates,
      },
      {
        ...compaction,
        fields: compaction.fields ?? [...EBAY_API_DEFAULT_CANDIDATE_FIELDS],
        // The compactor's scan cap bounds a caller's regex against one
        // rendered page. A split search is two pages merged with the
        // auction-only rows last, so every merged row is scanned here or a
        // format filter never sees an auction.
        maxScanned: candidates.length,
      },
    );
    const record = compacted.record;
    const hasMore = record.hasMore === true;
    const warnings = mergeWarnings(...mapped.map((entry) => entry.rows.warnings), compacted.warnings);
    if (hasMore) {
      // On the Bridge the next window is one navigate away; here it is the
      // same vendor requests again, which is why the default window is a
      // whole page (EBAY_API_SEARCH_DEFAULT_LIMIT) and paging past it is
      // said out loud.
      warnings.push(
        'OFFSET_PAGING_REISSUES_REQUESTS: paging with search.offset re-issues the vendor requests and spends credits again; raise search.limit instead',
      );
    }
    // A search request costs one credit per page fetched by contract; that
    // is the count when the vendor omits credits_used_this_request.
    const credits = foldCredits(
      mapped.map((entry) => ({ credits: entry.result.credits, contractCost: Math.max(1, entry.pagination.pagesFetched) })),
    );
    this.remember(credits);

    return {
      source: 'countdown',
      siteProfile: EBAY_API_SITE_PROFILE_ID,
      pageKind: 'search',
      pageUrl,
      domain,
      destination: input.destination,
      retrievedUnder: mapped.map((entry) => entry.retrievedUnder),
      totalResults,
      candidateCount: candidates.length,
      pagesFetched,
      hasNextPage,
      candidates: Array.isArray(record.candidates) ? (record.candidates as Record<string, unknown>[]) : [],
      offset: typeof record.offset === 'number' ? record.offset : compaction.offset,
      hasMore,
      nextOffset: typeof record.nextOffset === 'number' ? record.nextOffset : null,
      warnings,
      credits,
      requestIds: mapped.map((entry) => entry.result.requestId).filter((id): id is string => id !== null),
    };
  }

  // ---- ebay_api_items (§3.2) ---------------------------------------------

  async items(input: EbayApiItemsInputType, caller?: SourceCaller, deadline?: SourceDeadline): Promise<EbayApiItemsOutputType> {
    await this.assertCredits('items', caller);
    const location = this.locationFor(input.destination, 'product');
    // Every url is screened before the first request goes out, so a bad
    // one refuses the whole call rather than costing the good ones credits.
    const refs: ItemRef[] = input.items.map((ref) => {
      if ('url' in ref) {
        const screened = this.screenedUrl(ref.url, ['item']);
        return { url: ref.url, vendorUrl: screened.href, domain: screened.domain, expectedFormat: ref.expectedFormat };
      }
      const url = `https://www.${input.domain}/itm/${ref.itemId}`;
      return { url, vendorUrl: url, domain: input.domain, expectedFormat: ref.expectedFormat };
    });
    const observedAt = this.now().toISOString();
    const slots: ItemSlot[] = [];
    await runPool(refs.length, this.maxConcurrency, async (index) => {
      const ref = refs[index]!;
      // Checked before each request, not once per batch: the deadline can
      // pass while earlier slots are in flight, and a request issued after
      // the caller has already been answered spends a credit on nothing.
      slots[index] =
        deadline?.expired === true ? unattemptedSlot(ref, deadline) : await this.readItem(ref, input, location, observedAt, caller);
    });

    const results = slots.map((entry) => entry.slot);
    const attempted = slots.filter((entry) => !entry.unattempted);
    const succeeded = attempted.filter((entry) => entry.slot.ok).length;
    const refused = slots.filter((entry) => entry.refusedByReserve).length;
    const unattempted = slots.length - attempted.length;
    const warnings: string[] = [];
    if (refused > 0) {
      warnings.push(
        `SOURCE_CREDITS_EXHAUSTED: ${refused} item(s) were not requested because the credit balance fell below the reserve of ${this.creditReserve} during the batch; their slots carry the error.`,
      );
    }
    if (unattempted > 0 && deadline !== undefined) {
      warnings.push(
        `BATCH_DEADLINE_REACHED: ${attempted.length} of ${refs.length} item(s) were requested before the tool deadline of ${deadline.deadlineMs} ms; the rest carry SOURCE_UNAVAILABLE and can be re-issued.`,
      );
    }
    // Only slots the vendor answered are charged, one credit each by
    // contract; a refused, failed or unattempted slot carries no credits.
    const credits = foldCredits(slots.flatMap((entry) => (entry.credits === null ? [] : [{ credits: entry.credits, contractCost: 1 }])));
    this.remember(credits);
    return {
      mode: 'inline',
      jobId: null,
      // 'partial' means what it means on the Bridge: the slots requested are
      // final, and the rest were never attempted.
      status: unattempted > 0 ? 'partial' : 'completed',
      requested: refs.length,
      completed: attempted.length,
      succeeded,
      failed: attempted.length - succeeded,
      compact: input.compact,
      resultsFrom: 0,
      results,
      warnings,
      source: 'countdown',
      credits,
      requestIds: slots.map((entry) => entry.requestId).filter((id): id is string => id !== null),
    };
  }

  private async readItem(
    ref: ItemRef,
    input: EbayApiItemsInputType,
    location: LocationParams,
    observedAt: string,
    caller: SourceCaller | undefined,
  ): Promise<ItemSlot> {
    const base = { url: ref.url, siteProfile: EBAY_API_SITE_PROFILE_ID, pageRevision: 0 } as const;
    try {
      // Re-checked per request, not only once per batch: a batch that
      // starts above the reserve can cross it part-way, and the reserve is
      // meant to stop the next request, not the next call. The refusal
      // lands in this slot; every slot already read stays intact.
      await this.assertCredits('items', caller);
      const result = await this.upstream(
        ITEMS_TOOL_NAME,
        'product',
        caller,
        { domain: ref.domain, destination: input.destination, ...location },
        () => this.client.product({ url: ref.vendorUrl, ...location }),
      );
      const mapped = mapItem({
        body: result.body,
        domain: ref.domain,
        requestedUrl: ref.vendorUrl,
        ...(ref.expectedFormat === undefined ? {} : { expectedFormat: ref.expectedFormat }),
        observedAt,
      });
      const unavailable = mapped.status === 'unavailable';
      const record = input.compact
        ? compactItemRecord(EBAY_API_SITE_PROFILE_ID, mapped.record, mapped.warnings)
        : (mapped.record as unknown as Record<string, unknown>);
      return {
        slot: {
          ...base,
          finalUrl: result.body.request_metadata?.ebay_url ?? null,
          // ok means "produced listing evidence", as on the Bridge: a dead
          // listing keeps its record on the slot but is never an upsert.
          ok: !unavailable,
          record,
          warnings: mapped.warnings,
          error: unavailable ? { code: 'LISTING_UNAVAILABLE', message: unavailableMessage(mapped.warnings), retryable: false } : null,
        },
        requestId: result.requestId,
        credits: result.credits,
        refusedByReserve: false,
        unattempted: false,
      };
    } catch (err) {
      // A slot that fails maps its own error and never fails the batch.
      const bridgeError = BridgeError.from(err);
      return {
        slot: {
          ...base,
          finalUrl: null,
          ok: false,
          record: null,
          warnings: [],
          error: { code: bridgeError.code, message: bridgeError.message, retryable: bridgeError.retryable },
        },
        requestId: null,
        credits: null,
        refusedByReserve: bridgeError.code === 'SOURCE_CREDITS_EXHAUSTED' && bridgeError.details.gate === true,
        unattempted: false,
      };
    }
  }

  // ---- ebay_api_seller (§3.3) --------------------------------------------

  async seller(input: EbayApiSellerInputType, caller?: SourceCaller): Promise<EbayApiSellerOutputType> {
    const url = this.sellerUrl(input);
    const result = await this.upstream(SELLER_TOOL_NAME, 'seller_profile', caller, { domain: ebayDomainOfUrl(url) }, () =>
      this.client.sellerProfile({ url }),
    );
    const mapped = mapSellerProfile({ body: result.body, requestedUrl: url });
    const profile = mapped.seller;
    const seller: EbayApiSellerOutputType['seller'] =
      profile === null || profile.name === null
        ? null
        : {
            name: profile.name,
            profileUrl: profile.profileUrl ?? url,
            loginId: profile.loginId,
            storeSlug: profile.storeSlug,
            memberSince: profile.memberSince,
            positivePercent: profile.positivePercent,
            followers: profile.followersText ?? (profile.followers === null ? null : String(profile.followers)),
            location: profile.location,
            topRated: profile.topRated,
            description: truncate(profile.description, EBAY_API_SELLER_DESCRIPTION_MAX_CHARS),
          };
    return {
      resolved: seller !== null,
      seller,
      warnings: mapped.warnings,
      credits: foldCredits([{ credits: result.credits, contractCost: 1 }]),
      requestIds: result.requestId === null ? [] : [result.requestId],
    };
  }

  private sellerUrl(input: EbayApiSellerInputType): string {
    if (input.url !== undefined) return this.screenedUrl(input.url, ['seller']).href;
    if (input.loginId === undefined) {
      // Unreachable through MCP (the input schema demands exactly one), kept
      // for direct callers so a malformed input never reaches the vendor.
      throw new BridgeError('ACTION_BLOCKED', `${SELLER_TOOL_NAME} needs exactly one of loginId or url.`, { tool: SELLER_TOOL_NAME });
    }
    return `https://www.${input.domain}/usr/${encodeURIComponent(input.loginId)}`;
  }

  // ---- shared -------------------------------------------------------------

  /**
   * The §2 URL policy, applied again here: the tool schemas screen a url
   * first, but this class must refuse on its own so that no path — a direct
   * caller, a future tool, a schema regression — hands the vendor a URL off
   * the two marketplaces or with the wrong scheme or path. What comes back
   * is the marketplace and the WHATWG-normalised href, and the href is the
   * only form ever forwarded: the screen judged the parsed URL, so the
   * parsed URL is what the vendor gets — never the caller's raw string,
   * whose repairs (a backslash read as a slash, say) another parser may
   * not make.
   */
  private screenedUrl(url: string, kinds: readonly EbayUrlKind[]): ScreenedUrl {
    const reason = screenEbayUrl(url, kinds);
    const domain = reason === null ? ebayDomainOfUrl(url) : null;
    if (domain === null) {
      throw new BridgeError('ORIGIN_DENIED', `url is not accepted: ${reason ?? 'host is not an eBay marketplace this source reads'}`, {
        kinds: [...kinds],
      });
    }
    return { domain, href: new URL(url).href };
  }

  /**
   * One upstream call: run it, remember the balance it reports, and file
   * exactly one audit row for it whatever happened. A vendor 402 is the
   * balance saying zero, so it is remembered as such and the reserve gate
   * refuses the next call without spending a round trip.
   */
  private async upstream<T>(
    toolName: string,
    requestType: CountdownRequestType,
    caller: SourceCaller | undefined,
    metadata: Record<string, unknown>,
    call: () => Promise<CountdownResult<T>>,
  ): Promise<CountdownResult<T>> {
    const startedAt = Date.now();
    try {
      const result = await call();
      this.remember(result.credits);
      await this.audit(toolName, requestType, caller, 'ok', null, result.requestId, {
        ...metadata,
        httpStatus: result.httpStatus,
        attempts: result.attempts,
        creditsUsedThisRequest: result.credits.usedThisRequest,
        creditsRemaining: result.credits.remaining,
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      const bridgeError = BridgeError.from(err);
      if (bridgeError.code === 'SOURCE_CREDITS_EXHAUSTED') this.remaining = 0;
      const status = bridgeError.details.status;
      const attempts = bridgeError.details.attempts;
      await this.audit(toolName, requestType, caller, 'error', bridgeError.code, null, {
        ...metadata,
        httpStatus: typeof status === 'number' ? status : null,
        attempts: typeof attempts === 'number' ? attempts : null,
        creditsUsedThisRequest: null,
        creditsRemaining: this.remaining,
        durationMs: Date.now() - startedAt,
      });
      throw bridgeError;
    }
  }

  /**
   * Shaped like the broker's rows so audit_events reads as one ledger: no
   * device, session or tab (nothing is on the device path), the vendor's
   * request id in requestId, the credit figures in metadata. Never the key
   * and never the outbound URL; a postal code is fine.
   */
  private async audit(
    toolName: string,
    requestType: CountdownRequestType,
    caller: SourceCaller | undefined,
    outcome: AuditOutcome,
    errorCode: string | null,
    vendorRequestId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const fields = { source: 'countdown', requestType, ...metadata };
    try {
      await this.store.audit.insert(
        buildAuditEvent(
          {
            userSubject: caller?.subject ?? null,
            deviceId: null,
            browserSessionHandle: null,
            tabId: null,
            toolName,
            requestId: vendorRequestId,
            actionClass: SOURCE_AUDIT_ACTION_CLASS,
            outcome,
            errorCode,
            traceId: caller?.traceparent ?? null,
            metadata: fields,
          },
          this.now(),
        ),
      );
    } catch (err) {
      this.logger?.error({ err: String(err) }, 'Countdown audit write failed');
    }
    this.logger?.info({ toolName, vendorRequestId, outcome, errorCode, ...fields }, 'Countdown API request');
  }
}
