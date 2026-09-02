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
  DEFAULT_SEARCH_COMPACTION,
  EBAY_API_SELLER_DESCRIPTION_MAX_CHARS,
  ebayDomainOfUrl,
  screenEbayUrl,
  type BatchExtractItem,
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
  /** Clock for observedAt stamps and audit rows; defaults to the wall clock. */
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
  url: string;
  domain: EbayApiDomain;
  expectedFormat: EbayApiExpectedFormat | undefined;
}

interface ItemSlot {
  slot: BatchExtractItem;
  requestId: string | null;
  credits: CountdownCredits | null;
  /** True when the reserve gate, not the vendor, refused this slot. */
  refusedByReserve: boolean;
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

/**
 * The balance a set of responses leaves behind: the highest cumulative
 * `used` and the lowest `remaining` seen, because concurrent requests
 * answer in any order and the latest state is the one that matters.
 */
function foldCredits(seen: readonly CountdownCredits[]): { used: number | null; remaining: number | null } {
  let used: number | null = null;
  let remaining: number | null = null;
  for (const credits of seen) {
    const u = toInt(credits.used);
    const r = toInt(credits.remaining);
    if (u !== null && (used === null || u > used)) used = u;
    if (r !== null && (remaining === null || r < remaining)) remaining = r;
  }
  return { used, remaining };
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
 * filter added to its query string, twice.
 */
function buildSearchPlans(input: EbayApiSearchInputType, domain: EbayApiDomain, location: LocationParams): SearchPlan[] {
  const common: CountdownSearchParams = {
    num: input.num,
    ...(input.maxPage > 1 ? { maxPage: input.maxPage } : {}),
    ...location,
    allowRewrittenResults: input.allowRewrittenResults,
  };
  const filters: EbayApiRetrievedUnder[] = input.listingType === 'all' ? ['buy_it_now', 'auction'] : [input.listingType];
  if (input.url !== undefined) {
    const url = input.url;
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

export class CountdownSource {
  readonly creditReserve: number;
  readonly maxConcurrency: number;
  private readonly client: CountdownClient;
  private readonly config: CountdownConfig;
  private readonly store: Pick<Store, 'audit'>;
  private readonly logger: Logger | null;
  private readonly now: () => Date;
  /** The vendor's last reported credits_remaining; null until a response says. */
  private remaining: number | null = null;

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
   */
  assertCredits(kind: SourceCallKind): void {
    if (kind === 'seller') return;
    if (this.remaining === null || this.remaining >= this.creditReserve) return;
    throw new BridgeError(
      'SOURCE_CREDITS_EXHAUSTED',
      `Countdown API credit reserve reached: ${this.remaining} credit(s) remain, below the reserve of ${this.creditReserve}; ${kind} calls are refused until the balance is topped up (seller lookups still run).`,
      { creditsRemaining: this.remaining, creditReserve: this.creditReserve, kind, gate: true },
    );
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
    this.assertCredits('search');
    const domain = input.url === undefined ? input.domain : this.screenedDomain(input.url, ['search']);
    const location = this.locationFor(input.destination, 'search');
    const plans = buildSearchPlans(input, domain, location);
    const auditBase = { domain, destination: input.destination, ...location, page: input.page, maxPage: input.maxPage };

    // Both halves of a split search go out together: a page can take most
    // of a minute at the vendor, and the tool deadline covers the call.
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

    const compaction = input.search ?? DEFAULT_SEARCH_COMPACTION;
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
      { ...compaction, fields: compaction.fields ?? [...EBAY_API_DEFAULT_CANDIDATE_FIELDS] },
    );
    const record = compacted.record;

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
      hasMore: record.hasMore === true,
      nextOffset: typeof record.nextOffset === 'number' ? record.nextOffset : null,
      warnings: mergeWarnings(...mapped.map((entry) => entry.rows.warnings), compacted.warnings),
      credits: foldCredits(mapped.map((entry) => entry.result.credits)),
      requestIds: mapped.map((entry) => entry.result.requestId).filter((id): id is string => id !== null),
    };
  }

  // ---- ebay_api_items (§3.2) ---------------------------------------------

  async items(input: EbayApiItemsInputType, caller?: SourceCaller): Promise<EbayApiItemsOutputType> {
    this.assertCredits('items');
    const location = this.locationFor(input.destination, 'product');
    // Every url is screened before the first request goes out, so a bad
    // one refuses the whole call rather than costing the good ones credits.
    const refs: ItemRef[] = input.items.map((ref) =>
      'url' in ref
        ? { url: ref.url, domain: this.screenedDomain(ref.url, ['item']), expectedFormat: ref.expectedFormat }
        : { url: `https://www.${input.domain}/itm/${ref.itemId}`, domain: input.domain, expectedFormat: ref.expectedFormat },
    );
    const observedAt = this.now().toISOString();
    const slots: ItemSlot[] = [];
    await runPool(refs.length, this.maxConcurrency, async (index) => {
      slots[index] = await this.readItem(refs[index]!, input, location, observedAt, caller);
    });

    const results = slots.map((entry) => entry.slot);
    const succeeded = results.filter((slot) => slot.ok).length;
    const refused = slots.filter((entry) => entry.refusedByReserve).length;
    const warnings: string[] = [];
    if (refused > 0) {
      warnings.push(
        `SOURCE_CREDITS_EXHAUSTED: ${refused} item(s) were not requested because the credit balance fell below the reserve of ${this.creditReserve} during the batch; their slots carry the error.`,
      );
    }
    return {
      mode: 'inline',
      jobId: null,
      status: 'completed',
      requested: refs.length,
      completed: refs.length,
      succeeded,
      failed: refs.length - succeeded,
      compact: input.compact,
      resultsFrom: 0,
      results,
      warnings,
      source: 'countdown',
      credits: foldCredits(slots.map((entry) => entry.credits).filter((credits): credits is CountdownCredits => credits !== null)),
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
      this.assertCredits('items');
      const result = await this.upstream(
        ITEMS_TOOL_NAME,
        'product',
        caller,
        { domain: ref.domain, destination: input.destination, ...location },
        () => this.client.product({ url: ref.url, ...location }),
      );
      const mapped = mapItem({
        body: result.body,
        domain: ref.domain,
        requestedUrl: ref.url,
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
      credits: foldCredits([result.credits]),
      requestIds: result.requestId === null ? [] : [result.requestId],
    };
  }

  private sellerUrl(input: EbayApiSellerInputType): string {
    if (input.url !== undefined) {
      this.screenedDomain(input.url, ['seller']);
      return input.url;
    }
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
   * the two marketplaces or with the wrong scheme or path.
   */
  private screenedDomain(url: string, kinds: readonly EbayUrlKind[]): EbayApiDomain {
    const reason = screenEbayUrl(url, kinds);
    const domain = reason === null ? ebayDomainOfUrl(url) : null;
    if (domain === null) {
      throw new BridgeError('ORIGIN_DENIED', `url is not accepted: ${reason ?? 'host is not an eBay marketplace this source reads'}`, {
        kinds: [...kinds],
      });
    }
    return domain;
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
      if (result.credits.remaining !== null) this.remaining = toInt(result.credits.remaining);
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
