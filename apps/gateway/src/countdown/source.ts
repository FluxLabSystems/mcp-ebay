/**
 * Countdown API source — docs/COUNTDOWN-API-PLAN.md §2, §3 and §6.5.
 *
 * One instance per gateway process, built from GatewayConfig.countdown. It
 * owns the vendor client, the account memory (balance, plan, credit limit)
 * and the reserve gate in front of it, the named-destination mapping (the
 * only two postal codes the gateway ever sends), and the audit row every
 * upstream call leaves behind. The four handlers answer the ebay_api_*
 * tools in their catalogued output shapes; registerSourceTools in ./tools.ts
 * is the MCP face over them.
 *
 * Nothing here fetches a caller-supplied URL: a url input is screened
 * against the §2 policy and then handed to the vendor as its `url`
 * parameter. The vendor key lives in the client and never reaches a
 * result, an error, an audit row or a log line; the account endpoint's echo
 * of it is stripped inside the client.
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
  type EbayApiGateReason,
  type EbayApiItemsInputType,
  type EbayApiItemsOutputType,
  type EbayApiReserveBasis,
  type EbayApiRetrievedUnder,
  type EbayApiSearchInputType,
  type EbayApiSearchOutputType,
  type EbayApiSellerInputType,
  type EbayApiSellerOutputType,
  type EbayApiStatusOutputType,
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
  type CountdownCallOptions,
  type CountdownCredits,
  type CountdownRequestBudget,
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
export const STATUS_TOOL_NAME = 'ebay_api_status';

/** The audit action class every upstream Countdown call is filed under. */
export const SOURCE_AUDIT_ACTION_CLASS = 'source';

/**
 * How long a shut gate trusts the remembered figures before asking the
 * vendor's free account endpoint again (assertCredits): a top-up or a plan
 * upgrade is noticed within a minute, and a refused batch does not probe
 * once per slot. The same interval is the cooldown after a probe that
 * failed or timed out: the gate decides on the last-known figures without
 * asking again until it has passed.
 */
export const CREDIT_PROBE_MIN_INTERVAL_MS = 60_000;

/**
 * The account probe's own timeout, with no retry. A probe is a free,
 * normally sub-second request, and the 2026-09-03 fire showed what happens
 * when the gate awaits one on a charged request's terms: the account
 * endpoint hung against the suspended account, the probe ran the 90 s
 * request timeout and the retry ladder, every search that arrived meanwhile
 * joined the one in flight, and each timed out at the client's 60 s. A
 * probe that cannot answer in 8 s is a failed probe, remembered for
 * CREDIT_PROBE_MIN_INTERVAL_MS; the status tool's probe runs on the same
 * terms so an operator asking about the budget is answered promptly too.
 */
export const CREDIT_PROBE_TIMEOUT_MS = 8_000;

/**
 * How long a vendor 402 that said the account is suspended is remembered:
 * every tool, seller lookups included, is refused without contacting the
 * vendor until it expires. No top-up lifts a suspension (the vendor
 * removes it when a plan is subscribed), so a refused call must be told
 * that and not "top up", and a suspended account must not be polled on
 * every call.
 */
export const SUSPENSION_COOLDOWN_MS = 5 * 60_000;

/**
 * ebay_api_items launches no further vendor request once the tool budget
 * left is under one request's worth of headroom — the configured request
 * timeout or this, whichever is smaller — because a request that cannot
 * finish inside the deadline spends a credit on a result nobody receives.
 */
export const ITEM_LAUNCH_HEADROOM_MS = 15_000;

/**
 * ebay_api_items stops waiting for in-flight requests this long before the
 * tool deadline (or a tenth of a shorter deadline) and answers with what it
 * has, so the partial batch reaches the caller instead of the deadline
 * error the MCP layer would raise.
 */
export const BATCH_RETURN_GUARD_MS = 500;

/** The guard for a given deadline: BATCH_RETURN_GUARD_MS, or a tenth of a deadline too short to spare that much. */
export function batchReturnGuardMs(deadlineMs: number): number {
  return Math.min(BATCH_RETURN_GUARD_MS, Math.floor(deadlineMs / 10));
}

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
 * enforces it (registerSourceTools in ./tools.ts) and with the vendor
 * client, whose per-attempt timeouts and retries fit inside what remains.
 * `signal` aborts when the budget is spent or the call is over, so a vendor
 * fetch never outlives the tool call it was made for. It satisfies the
 * client's CountdownRequestBudget directly.
 */
export interface SourceDeadline extends CountdownRequestBudget {
  readonly deadlineMs: number;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
  readonly expired: boolean;
  readonly signal: AbortSignal;
  /**
   * Resolves once `remainingMs()` is at or under `guardMs` (at once when it
   * already is); `cancel` clears the timer for a caller that finished first.
   */
  whenRemaining(guardMs: number): { promise: Promise<void>; cancel: () => void };
}

export interface StartedDeadline extends SourceDeadline {
  /** Stop the clock and abort anything still in flight; idempotent. */
  dispose(): void;
}

/** Start a deadline clock now. `now` is injectable for tests; the abort timer is real. */
export function startDeadline(deadlineMs: number, now: () => number = Date.now): StartedDeadline {
  const startedAt = now();
  const controller = new AbortController();
  const remainingMs = (): number => Math.max(0, deadlineMs - (now() - startedAt));
  const timer = setTimeout(() => controller.abort(new Error(`tool deadline of ${deadlineMs} ms exceeded`)), deadlineMs);
  return {
    deadlineMs,
    remainingMs,
    get expired(): boolean {
      return controller.signal.aborted || remainingMs() <= 0;
    },
    signal: controller.signal,
    whenRemaining(guardMs: number) {
      let handle: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        const wait = remainingMs() - guardMs;
        if (wait <= 0) {
          resolve();
          return;
        }
        handle = setTimeout(resolve, wait);
      });
      return { promise, cancel: () => clearTimeout(handle) };
    },
    dispose() {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new Error('tool call finished'));
    },
  };
}

/** What the gate lets a charged call know once it has admitted it. */
export interface GateVerdict {
  /** CREDIT_RESERVE_UNRESOLVED when the call was admitted by fallback rather than arithmetic. */
  warnings: string[];
}

/** Why the gate refuses; each is `details.reason` on the SOURCE_CREDITS_EXHAUSTED it throws. */
export type GateRefusalReason = 'below_reserve' | 'reserve_not_below_plan_limit';

/** What one account probe came back with. */
export interface ProbeOutcome {
  ok: boolean;
  httpStatus: number | null;
  error: { code: string; message: string } | null;
  /** When the probe was issued, ISO. */
  at: string;
}

/** Who asked for an account probe; filed on its audit row. */
export type ProbeTrigger = 'startup' | 'gate' | 'status';

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
  /** GATEWAY_BUILD_SHA, reported by ebay_api_status; 'unknown' when absent. */
  buildSha?: string;
  /** Tests only: replaces batchReturnGuardMs(deadline) for ebay_api_items. */
  batchReturnGuardMs?: number;
  /** Tests only: replaces CREDIT_PROBE_TIMEOUT_MS. */
  probeTimeoutMs?: number;
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

/** One answered item: the vendor replied, or refused, or the gate refused the slot. */
interface ItemSlot {
  slot: BatchExtractItem;
  requestId: string | null;
  credits: CountdownCredits | null;
  /** True when the reserve gate, not the vendor, refused this slot. */
  refusedByReserve: boolean;
}

interface ScreenedUrl {
  domain: EbayApiDomain;
  /** The parsed, normalised form — what the vendor is given. */
  href: string;
}

interface ReserveState {
  effective: number | null;
  basis: EbayApiReserveBasis;
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

/**
 * Run `task(0..count-1)` through at most `concurrency` workers; results are
 * the caller's to place by index. A task that returns false tells every
 * worker to hand out no further index.
 */
async function runPool(count: number, concurrency: number, task: (index: number) => Promise<boolean>): Promise<void> {
  let next = 0;
  let stopped = false;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, count)) }, async () => {
    for (;;) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= count) return;
      if (!(await task(index))) stopped = true;
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

/** Whole seconds for the catalog deadlines; one decimal for a sub-second test deadline. */
function formatSeconds(ms: number): string {
  return ms % 1000 === 0 ? String(ms / 1000) : (ms / 1000).toFixed(1);
}

/** The item number when the reference carries one, else the URL as given: what a re-request names. */
function itemLabel(ref: ItemRef): string {
  return /\/itm\/(\d{10,14})(?:[/?#]|$)/.exec(ref.vendorUrl)?.[1] ?? ref.url;
}

/**
 * The slot for an item the tool deadline cut off. Never launched: nothing
 * was sent, nothing charged. In flight: the request was abandoned at the
 * deadline and the vendor may still serve and charge it. Both carry
 * error.details so a run can tell the two apart and re-request either.
 */
function deadlineSlot(ref: ItemRef, deadlineMs: number, inFlight: boolean): BatchExtractItem {
  const seconds = formatSeconds(deadlineMs);
  return {
    url: ref.url,
    finalUrl: null,
    ok: false,
    siteProfile: EBAY_API_SITE_PROFILE_ID,
    pageRevision: 0,
    record: null,
    warnings: [],
    error: {
      code: 'SOURCE_UNAVAILABLE',
      message: inFlight
        ? `Not answered: the request was still in flight at the ${seconds} s tool deadline and was abandoned; the vendor may still have served and charged it. Re-request this item.`
        : `Not requested: the ${seconds} s tool deadline left no room for another vendor request, so nothing was sent and nothing was charged. Re-request this item.`,
      retryable: true,
      details: { reason: 'deadline', requested: inFlight, possiblyCharged: inFlight },
    },
  };
}

/** The client options a call passes so its vendor requests fit the tool deadline. */
function budgetOptions(deadline: SourceDeadline | undefined): CountdownCallOptions | undefined {
  return deadline === undefined ? undefined : { budget: deadline };
}

export class CountdownSource {
  readonly maxConcurrency: number;
  private readonly client: CountdownClient;
  private readonly config: CountdownConfig;
  private readonly store: Pick<Store, 'audit'>;
  private readonly logger: Logger | null;
  private readonly now: () => Date;
  private readonly buildSha: string;
  private readonly batchGuardMs: number | null;
  private readonly probeTimeoutMs: number;
  /** The last accepted credits_remaining; null until a response says. */
  private remaining: number | null = null;
  /**
   * The highest cumulative credits_used accepted so far. Parallel responses
   * land in any order, so a balance is taken only from a response at least
   * this far along (see remember): without it, two requests reporting 501
   * then 499 left the memory at 501 whenever the 501 arrived last.
   */
  private lastUsed: number | null = null;
  /** The plan's credits_limit, plan name and reset date from the last successful account probe; null until one has said. */
  private limit: number | null = null;
  private plan: string | null = null;
  private resetAt: string | null = null;
  /** When the account endpoint was last asked, on the injected clock; null until it was. */
  private lastProbeAt: number | null = null;
  /** When it last answered, on the injected clock; null until it has. */
  private lastGoodProbeAt: number | null = null;
  /** The last probe's outcome, for the status tool's "figures are remembered" note. */
  private lastProbe: ProbeOutcome | null = null;
  /** The probe in flight, shared by every call that hits the gate while it runs. */
  private probeInFlight: Promise<ProbeOutcome> | null = null;
  /** Each of these is logged once per process, not once per refused or admitted call. */
  private unresolvedLogged = false;
  private unsatisfiableLogged = false;
  /** A remembered vendor suspension: refused without contact until this instant on the injected clock, with the vendor's wording. */
  private suspendedUntil: number | null = null;
  private suspensionMessage: string | null = null;

  constructor(options: CountdownSourceOptions) {
    this.config = options.config;
    this.store = options.store;
    this.logger = options.logger ?? null;
    this.now = options.now ?? (() => new Date());
    this.buildSha = options.buildSha ?? 'unknown';
    this.batchGuardMs = options.batchReturnGuardMs ?? null;
    this.probeTimeoutMs = options.probeTimeoutMs ?? CREDIT_PROBE_TIMEOUT_MS;
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

  /** The plan's credits_limit from the last successful account probe; null until one has said. */
  get creditsLimit(): number | null {
    return this.limit;
  }

  /** The plan name from the last successful account probe; null until one has said. */
  get planName(): string | null {
    return this.plan;
  }

  /** COUNTDOWN_CREDIT_RESERVE as configured, normalised ("500" or "5%"). */
  get creditReserveConfigured(): string {
    return this.config.creditReserve.configured;
  }

  /** The credit count the gate holds back right now; null while a percent reserve's limit is unknown. */
  get effectiveCreditReserve(): number | null {
    return this.reserveState().effective;
  }

  /** The per-vendor-request timeout (COUNTDOWN_TIMEOUT_MS): how long an abandoned request may still run at the vendor. */
  get requestTimeoutMs(): number {
    return this.config.timeoutMs;
  }

  // ---- the reserve gate (§2 Credits) ---------------------------------------

  /**
   * Every call passes here before any credit is spent. A remembered account
   * suspension refuses all three kinds; the credit reserve itself never
   * refuses a seller lookup (one credit, rare, and the confirmation step of
   * the deals rules).
   *
   * 1. Nothing is decided on nothing. While the balance — or, under a
   *    percent reserve, the plan's credit limit — is unknown, the vendor's
   *    free account endpoint is read first. The 2026-09-03 restart showed
   *    why: with an empty memory the old gate admitted the first search
   *    against 82 credits and a 500 reserve.
   * 2. An absolute reserve at or above the plan's limit can never be
   *    satisfied, so the call is refused saying exactly that and naming the
   *    fix. The limit is re-read at most once a minute first, because a
   *    plan upgrade is what clears the state.
   * 3. A balance below the effective reserve refuses the call, after the
   *    same once-a-minute re-read, because a top-up is what clears it.
   * 4. What the probe could not resolve does not block: with the balance
   *    or the limit still unknown the reserve counts as 0, the call is
   *    admitted with a CREDIT_RESERVE_UNRESOLVED warning, and the vendor's
   *    own 402 (mapped to SOURCE_CREDITS_EXHAUSTED) is the backstop.
   *
   * A probe runs on its own short terms (CREDIT_PROBE_TIMEOUT_MS, no retry,
   * one in flight shared by every caller that hits the gate meanwhile), and
   * the account is never asked more than once per CREDIT_PROBE_MIN_INTERVAL_MS
   * whatever the last probe said: a failed or timed-out one is not repeated
   * for that long (the gate decides on the last-known figures), and neither
   * is one that answered without figures, so a batch's per-slot re-checks
   * never probe once per slot. A gate must answer in seconds whatever the
   * account endpoint is doing.
   */
  async assertCredits(kind: SourceCallKind, caller?: SourceCaller, deadline?: SourceDeadline): Promise<GateVerdict> {
    this.assertNotSuspended(kind);
    if (kind === 'seller') return { warnings: [] };
    const toolName = kind === 'search' ? SEARCH_TOOL_NAME : ITEMS_TOOL_NAME;
    const options = this.probeOptions(deadline);
    if (this.unknownForGate() && this.probeIsStale()) await this.gateProbe(toolName, caller, options, kind);
    if (this.reserveNotBelowLimit()) {
      if (this.probeIsStale()) await this.gateProbe(toolName, caller, options, kind);
      if (this.reserveNotBelowLimit()) throw this.refusal('reserve_not_below_plan_limit', kind);
    }
    if (this.belowReserve()) {
      if (this.probeIsStale()) await this.gateProbe(toolName, caller, options, kind);
      if (this.belowReserve()) throw this.refusal('below_reserve', kind);
    }
    return { warnings: this.unresolvedWarnings(true) };
  }

  /** A probe on the gate's behalf; a suspension it learns of refuses the call at once. */
  private async gateProbe(toolName: string, caller: SourceCaller | undefined, options: CountdownCallOptions, kind: SourceCallKind): Promise<void> {
    await this.probeAccount(toolName, caller, 'gate', options);
    this.assertNotSuspended(kind);
  }

  /** The probe's terms: its own short timeout, no retry, inside the call's deadline when there is one. */
  private probeOptions(deadline: SourceDeadline | undefined): CountdownCallOptions {
    return { timeoutMs: this.probeTimeoutMs, retry: false, ...(deadline === undefined ? {} : { budget: deadline }) };
  }

  private isSuspended(): boolean {
    if (this.suspendedUntil === null) return false;
    if (this.now().getTime() < this.suspendedUntil) return true;
    this.suspendedUntil = null;
    this.suspensionMessage = null;
    return false;
  }

  /**
   * A vendor 402 that said the account is suspended, remembered for
   * SUSPENSION_COOLDOWN_MS: every kind is refused with the same error the
   * vendor's answer mapped to, without a round trip, because no top-up
   * lifts a suspension and a suspended account must not be polled per call.
   */
  private assertNotSuspended(kind: SourceCallKind): void {
    if (!this.isSuspended()) return;
    const until = new Date(this.suspendedUntil!).toISOString();
    throw new BridgeError(
      'SOURCE_REJECTED',
      `Countdown API account is suspended (vendor: ${this.suspensionMessage ?? 'no message'}); ${kind} calls are refused without contacting the vendor until ${until}. No top-up lifts a suspension: the vendor removes it when a plan is subscribed.`,
      { reason: 'account_suspended', remembered: true, httpStatus: 402, vendorMessage: this.suspensionMessage, suspendedUntil: until, kind },
    );
  }

  /** Remember a suspension the vendor just reported, on a charged request or on the probe. */
  private noteSuspension(bridgeError: BridgeError): void {
    if (bridgeError.code !== 'SOURCE_REJECTED' || bridgeError.details.reason !== 'account_suspended') return;
    const message = bridgeError.details.vendorMessage;
    this.suspendedUntil = this.now().getTime() + SUSPENSION_COOLDOWN_MS;
    this.suspensionMessage = typeof message === 'string' && message.length > 0 ? message : null;
    this.logger?.warn(
      { ...this.accountLogFields(), suspendedUntil: new Date(this.suspendedUntil).toISOString() },
      'Countdown API account suspended by the vendor; every ebay_api_* call is refused without contacting the vendor until the cooldown passes',
    );
  }

  /** The reserve the gate applies now, and where the figure came from. */
  private reserveState(): ReserveState {
    const reserve = this.config.creditReserve;
    if (reserve.kind === 'absolute') return { effective: reserve.credits, basis: 'absolute' };
    if (this.limit === null) return { effective: null, basis: 'unknown_limit' };
    return { effective: Math.floor((this.limit * reserve.percent) / 100), basis: 'plan_limit' };
  }

  private unknownForGate(): boolean {
    return this.remaining === null || (this.config.creditReserve.kind === 'percent' && this.limit === null);
  }

  private belowReserve(): boolean {
    return this.remaining !== null && this.remaining < (this.reserveState().effective ?? 0);
  }

  private reserveNotBelowLimit(): boolean {
    const reserve = this.config.creditReserve;
    return reserve.kind === 'absolute' && this.limit !== null && reserve.credits >= this.limit;
  }

  private probeIsStale(): boolean {
    return this.lastProbeAt === null || this.now().getTime() - this.lastProbeAt >= CREDIT_PROBE_MIN_INTERVAL_MS;
  }

  private refusal(reason: GateRefusalReason, kind: SourceCallKind): BridgeError {
    const reserve = this.config.creditReserve;
    const { effective, basis } = this.reserveState();
    const details = {
      gate: true,
      reason,
      kind,
      creditsRemaining: this.remaining,
      creditsLimit: this.limit,
      plan: this.plan,
      creditReserve: effective,
      reserveConfigured: reserve.configured,
    };
    if (reason === 'reserve_not_below_plan_limit') {
      return new BridgeError(
        'SOURCE_CREDITS_EXHAUSTED',
        `COUNTDOWN_CREDIT_RESERVE=${reserve.configured} is not below the plan's ${this.limit}-credit limit (plan ${JSON.stringify(this.plan ?? 'unknown')}); set it below the limit or to a percentage such as 5%. ${kind} calls are refused until it is (seller lookups still run).`,
        details,
      );
    }
    const basisNote = basis === 'plan_limit' ? ` (${reserve.configured} of the plan's ${this.limit}-credit limit)` : '';
    return new BridgeError(
      'SOURCE_CREDITS_EXHAUSTED',
      `Countdown API credit reserve reached: ${this.remaining} credit(s) remain, below the reserve of ${effective}${basisNote}; ${kind} calls are refused until the balance is topped up (seller lookups still run).`,
      details,
    );
  }

  /**
   * The CREDIT_RESERVE_UNRESOLVED warning for the current memory, empty when
   * the reserve resolves. `log` says whether this is a charged call being
   * admitted by fallback, which the gateway logs once per process.
   */
  private unresolvedWarnings(log: boolean): string[] {
    const reserve = this.config.creditReserve;
    const cause = this.lastProbe?.error === null || this.lastProbe === null ? 'no account read has answered yet' : `account probe failed: ${this.lastProbe.error.code}: ${this.lastProbe.error.message}`;
    let warning: string | null = null;
    if (this.remaining === null) {
      warning = `CREDIT_RESERVE_UNRESOLVED: the credit balance is unknown (${cause}); the ${reserve.configured} reserve cannot be applied to this call and the vendor's own 402 is the backstop`;
    } else if (reserve.kind === 'percent' && this.limit === null) {
      warning = `CREDIT_RESERVE_UNRESOLVED: the plan's credit limit is unknown (${cause}), so the ${reserve.configured} reserve resolves to 0 for this call and the vendor's own 402 is the backstop`;
    }
    if (warning === null) return [];
    if (log && !this.unresolvedLogged) {
      this.unresolvedLogged = true;
      this.logger?.warn(this.accountLogFields(), warning);
    }
    return [warning];
  }

  // ---- the account probe ---------------------------------------------------

  /** One probe at a time: every caller that hits the gate while one runs — the slots of a batch, two concurrent searches — awaits the same promise. */
  private probeAccount(
    toolName: string | null,
    caller: SourceCaller | undefined,
    trigger: ProbeTrigger,
    options: CountdownCallOptions,
  ): Promise<ProbeOutcome> {
    if (this.probeInFlight === null) {
      this.probeInFlight = this.readAccount(toolName, caller, trigger, options).finally(() => {
        this.probeInFlight = null;
      });
    }
    return this.probeInFlight;
  }

  /**
   * GET /account is free (§1.2) and authoritative, so its figures replace
   * the memory outright instead of passing through remember()'s ordering
   * rule: a renewed plan resets credits_used, which that rule would read as
   * a stale response. A failed probe changes nothing — the memory stands —
   * and either way the probe leaves an audit row like every other upstream
   * call. The body the client returns carries no key; nothing of it is
   * logged.
   */
  private async readAccount(
    toolName: string | null,
    caller: SourceCaller | undefined,
    trigger: ProbeTrigger,
    options: CountdownCallOptions,
  ): Promise<ProbeOutcome> {
    const at = this.now();
    this.lastProbeAt = at.getTime();
    const startedAt = Date.now();
    let outcome: ProbeOutcome;
    try {
      const result = await this.client.account(options);
      const account = result.account;
      this.lastUsed = toInt(account.creditsUsed);
      if (account.creditsRemaining !== null) this.remaining = toInt(account.creditsRemaining);
      if (account.creditsLimit !== null) this.limit = toInt(account.creditsLimit);
      if (account.plan !== null) this.plan = account.plan;
      this.resetAt = account.creditsResetAt;
      this.lastGoodProbeAt = at.getTime();
      outcome = { ok: true, httpStatus: result.httpStatus, error: null, at: at.toISOString() };
      await this.audit(toolName, 'account', caller, 'ok', null, result.requestId, {
        probe: true,
        trigger,
        httpStatus: result.httpStatus,
        attempts: result.attempts,
        creditsUsedThisRequest: null,
        creditsRemaining: this.remaining,
        creditsLimit: this.limit,
        plan: this.plan,
        durationMs: Date.now() - startedAt,
      });
      if (this.reserveNotBelowLimit() && !this.unsatisfiableLogged) {
        this.unsatisfiableLogged = true;
        this.logger?.warn(
          this.accountLogFields(),
          `COUNTDOWN_CREDIT_RESERVE=${this.config.creditReserve.configured} is not below the plan's ${this.limit}-credit limit; search and item calls will be refused until it is set below the limit or to a percentage such as 5%`,
        );
      }
    } catch (err) {
      const bridgeError = BridgeError.from(err);
      if (bridgeError.code === 'SOURCE_CREDITS_EXHAUSTED') this.remaining = 0;
      this.noteSuspension(bridgeError);
      const status = bridgeError.details.status;
      const attempts = bridgeError.details.attempts;
      outcome = {
        ok: false,
        httpStatus: typeof status === 'number' ? status : null,
        error: { code: bridgeError.code, message: bridgeError.message },
        at: at.toISOString(),
      };
      await this.audit(toolName, 'account', caller, 'error', bridgeError.code, null, {
        probe: true,
        trigger,
        httpStatus: outcome.httpStatus,
        attempts: typeof attempts === 'number' ? attempts : null,
        creditsUsedThisRequest: null,
        creditsRemaining: this.remaining,
        creditsLimit: this.limit,
        plan: this.plan,
        durationMs: Date.now() - startedAt,
      });
    }
    this.lastProbe = outcome;
    return outcome;
  }

  /**
   * Boot-time account read, best effort: the plan, its limit and the
   * effective reserve go to the startup log, and a percent reserve is
   * resolved before the first call rather than by it. Never throws and
   * never blocks the caller; a failure is logged and the gate simply reads
   * the account again on the first call.
   */
  async startupProbe(): Promise<void> {
    try {
      const outcome = await this.probeAccount(null, undefined, 'startup', this.probeOptions(undefined));
      const fields = this.accountLogFields();
      if (!outcome.ok) {
        this.logger?.warn(
          { ...fields, probeError: outcome.error },
          'Countdown API account probe failed at startup; the reserve gate reads the account again on the first call',
        );
        return;
      }
      const unresolved = this.unresolvedWarnings(false);
      if (unresolved.length > 0) {
        this.logger?.warn(fields, unresolved[0]!);
        return;
      }
      this.logger?.info(fields, 'Countdown API account');
    } catch (err) {
      this.logger?.warn({ err: String(err) }, 'Countdown API startup probe failed');
    }
  }

  /** The account and reserve state, key-free, for every log line about it. */
  private accountLogFields(): Record<string, unknown> {
    const reserve = this.reserveState();
    const gate = this.gateView();
    return {
      build: this.buildSha,
      plan: this.plan,
      creditsLimit: this.limit,
      creditsUsed: this.lastUsed,
      creditsRemaining: this.remaining,
      creditsResetAt: this.resetAt,
      reserveConfigured: this.config.creditReserve.configured,
      reserveEffective: reserve.effective,
      reserveBasis: reserve.basis,
      gateOpen: gate.open,
      gateReason: gate.reason,
      spendable: gate.spendable,
      suspended: this.suspendedUntil !== null && this.now().getTime() < this.suspendedUntil,
    };
  }

  /** Whether a search or item call would be admitted now, why not or why only by fallback, and what it could spend. */
  private gateView(): EbayApiStatusOutputType['gate'] {
    const effective = this.reserveState().effective;
    const spendable = this.remaining === null ? null : Math.max(0, this.remaining - (effective ?? 0));
    let reason: EbayApiGateReason | null = null;
    let open = true;
    if (this.isSuspended()) {
      return { open: false, reason: 'account_suspended', spendable: 0 };
    }
    if (this.reserveNotBelowLimit()) {
      open = false;
      reason = 'reserve_not_below_plan_limit';
    } else if (this.belowReserve()) {
      open = false;
      reason = 'below_reserve';
    } else if (this.remaining === null) {
      reason = 'balance_unknown';
    } else if (this.config.creditReserve.kind === 'percent' && this.limit === null) {
      reason = 'reserve_unresolved';
    }
    return { open, reason, spendable };
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

  // ---- ebay_api_status (§3.4) --------------------------------------------

  /**
   * Always a fresh probe — a stale figure is what a run must not plan
   * against — answered from the memory the probe just refreshed. When the
   * probe fails the remembered figures are reported with probe.ok false;
   * when nothing is remembered at all, SOURCE_UNAVAILABLE rather than an
   * invented balance.
   */
  async status(caller?: SourceCaller, deadline?: SourceDeadline): Promise<EbayApiStatusOutputType> {
    const outcome = await this.probeAccount(STATUS_TOOL_NAME, caller, 'status', this.probeOptions(deadline));
    const suspended = this.isSuspended();
    const nothingKnown = this.remaining === null && this.limit === null && this.plan === null;
    // A suspension is an answer in itself: the status is returned with it
    // whether or not any figure is known.
    if (!outcome.ok && nothingKnown && !suspended) {
      throw new BridgeError(
        'SOURCE_UNAVAILABLE',
        `Countdown API account probe failed and no earlier figures are remembered: ${outcome.error?.message ?? 'unknown error'}`,
        { reason: 'probe_failed', probe: { httpStatus: outcome.httpStatus, error: outcome.error } },
      );
    }
    const reserve = this.reserveState();
    const gate = this.gateView();
    const warnings: string[] = [];
    if (!outcome.ok && outcome.error !== null) {
      const since = this.lastGoodProbeAt === null ? 'from charged responses; no account read has succeeded yet' : `read from the account at ${new Date(this.lastGoodProbeAt).toISOString()}`;
      warnings.push(`ACCOUNT_PROBE_FAILED: ${outcome.error.code}: ${outcome.error.message}; the plan and credit figures are the last remembered ones (${since})`);
    }
    if (suspended) {
      warnings.push(
        `ACCOUNT_SUSPENDED: ${this.suspensionMessage ?? 'the vendor answered 402 with a suspension notice'}; every ebay_api_* call is refused without contacting the vendor until ${new Date(this.suspendedUntil!).toISOString()}. No top-up lifts a suspension: the vendor removes it when a plan is subscribed`,
      );
    }
    if (gate.reason === 'reserve_not_below_plan_limit') {
      warnings.push(
        `RESERVE_NOT_BELOW_PLAN_LIMIT: COUNTDOWN_CREDIT_RESERVE=${this.config.creditReserve.configured} is not below the plan's ${this.limit}-credit limit (plan ${JSON.stringify(this.plan ?? 'unknown')}); search and item calls are refused until it is set below the limit or to a percentage such as 5%`,
      );
    }
    warnings.push(...this.unresolvedWarnings(false));
    return {
      source: 'countdown',
      siteProfile: EBAY_API_SITE_PROFILE_ID,
      probedAt: outcome.at,
      probe: { ok: outcome.ok, httpStatus: outcome.httpStatus, error: outcome.error },
      plan: { name: this.plan, creditsLimit: this.limit, creditsResetAt: this.resetAt },
      account: { suspended, vendorMessage: suspended ? this.suspensionMessage : null },
      credits: { used: this.lastUsed, remaining: this.remaining },
      reserve: { configured: this.config.creditReserve.configured, effective: reserve.effective, basis: reserve.basis },
      gate,
      build: { gateway: this.buildSha },
      warnings,
    };
  }

  // ---- ebay_api_search (§3.1) --------------------------------------------

  async search(input: EbayApiSearchInputType, caller?: SourceCaller, deadline?: SourceDeadline): Promise<EbayApiSearchOutputType> {
    // The url is screened before the gate: refusing a bad URL is free and
    // local, and must not cost even the probe.
    const screened = input.url === undefined ? null : this.screenedUrl(input.url, ['search']);
    const gate = await this.assertCredits('search', caller, deadline);
    const domain = screened === null ? input.domain : screened.domain;
    const location = this.locationFor(input.destination, 'search');
    const plans = buildSearchPlans(input, domain, location, screened === null ? null : screened.href);
    const auditBase = { domain, destination: input.destination, ...location, page: input.page, maxPage: input.maxPage };
    const options = budgetOptions(deadline);

    // Both halves of a split search go out together: a page can take most
    // of a minute at the vendor, and the catalog deadline registerSourceTools
    // races the call against (SOURCE_SEARCH_TIMEOUT_MS) is sized for the two
    // in parallel, not one after the other.
    const responses = await Promise.all(
      plans.map(async (plan) => ({
        retrievedUnder: plan.retrievedUnder,
        result: await this.upstream(SEARCH_TOOL_NAME, 'search', caller, { ...auditBase, listingType: plan.retrievedUnder }, () =>
          this.client.search(plan.params, options),
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
    const warnings = mergeWarnings(...mapped.map((entry) => entry.rows.warnings), compacted.warnings, gate.warnings);
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
    const location = this.locationFor(input.destination, 'product');
    // Every url is screened before the gate and before the first request
    // goes out, so a bad one refuses the whole call rather than costing the
    // good ones credits — or even the probe.
    const refs: ItemRef[] = input.items.map((ref) => {
      if ('url' in ref) {
        const screened = this.screenedUrl(ref.url, ['item']);
        return { url: ref.url, vendorUrl: screened.href, domain: screened.domain, expectedFormat: ref.expectedFormat };
      }
      const url = `https://www.${input.domain}/itm/${ref.itemId}`;
      return { url, vendorUrl: url, domain: input.domain, expectedFormat: ref.expectedFormat };
    });
    const gate = await this.assertCredits('items', caller, deadline);
    const observedAt = this.now().toISOString();
    const slots: Array<ItemSlot | undefined> = refs.map(() => undefined);
    const launched = new Set<number>();
    const launchHeadroomMs = Math.min(this.config.timeoutMs, ITEM_LAUNCH_HEADROOM_MS);

    // The pool launches no request the remaining budget could not hold,
    // and the call stops waiting shortly before the deadline: the answered
    // slots go back now, the rest are marked for re-request, and whatever
    // is still in flight is aborted when the MCP layer disposes of the
    // deadline (nothing leaks; an abandoned request may still be charged).
    const pool = runPool(refs.length, this.maxConcurrency, async (index) => {
      if (deadline !== undefined && deadline.remainingMs() < launchHeadroomMs) return false;
      launched.add(index);
      slots[index] = await this.readItem(refs[index]!, input, location, observedAt, caller, deadline);
      return true;
    });
    if (deadline === undefined) {
      await pool;
    } else {
      const guard = deadline.whenRemaining(this.batchGuardMs ?? batchReturnGuardMs(deadline.deadlineMs));
      try {
        await Promise.race([pool, guard.promise]);
      } finally {
        guard.cancel();
      }
    }

    const unanswered: string[] = [];
    const results = refs.map((ref, index) => {
      const answered = slots[index];
      if (answered !== undefined) return answered.slot;
      unanswered.push(itemLabel(ref));
      return deadlineSlot(ref, deadline?.deadlineMs ?? 0, launched.has(index));
    });
    const answeredSlots = slots.filter((entry): entry is ItemSlot => entry !== undefined);
    const succeeded = answeredSlots.filter((entry) => entry.slot.ok).length;
    const refused = answeredSlots.filter((entry) => entry.refusedByReserve).length;
    const warnings: string[] = [...gate.warnings];
    if (refused > 0) {
      warnings.push(
        `SOURCE_CREDITS_EXHAUSTED: ${refused} item(s) were not requested because the credit balance fell below the reserve of ${this.reserveState().effective ?? 0} during the batch; their slots carry the error.`,
      );
    }
    if (unanswered.length > 0 && deadline !== undefined) {
      warnings.push(
        `BATCH_TRUNCATED_BY_DEADLINE: ${unanswered.length} of ${refs.length} items not answered within the ${formatSeconds(deadline.deadlineMs)} s tool budget; re-request the listed ids: ${unanswered.join(', ')}`,
      );
    }
    // Only slots the vendor answered are charged, one credit each by
    // contract; a refused, failed, abandoned or unrequested slot carries no
    // credits.
    const credits = foldCredits(answeredSlots.flatMap((entry) => (entry.credits === null ? [] : [{ credits: entry.credits, contractCost: 1 }])));
    this.remember(credits);
    return {
      mode: 'inline',
      jobId: null,
      // 'partial' means what it means on the Bridge: the slots answered are
      // final, and the rest were not answered by this call.
      status: unanswered.length > 0 ? 'partial' : 'completed',
      requested: refs.length,
      completed: answeredSlots.length,
      succeeded,
      failed: answeredSlots.length - succeeded,
      compact: input.compact,
      resultsFrom: 0,
      results,
      warnings,
      source: 'countdown',
      credits,
      requestIds: answeredSlots.map((entry) => entry.requestId).filter((id): id is string => id !== null),
    };
  }

  private async readItem(
    ref: ItemRef,
    input: EbayApiItemsInputType,
    location: LocationParams,
    observedAt: string,
    caller: SourceCaller | undefined,
    deadline: SourceDeadline | undefined,
  ): Promise<ItemSlot> {
    const base = { url: ref.url, siteProfile: EBAY_API_SITE_PROFILE_ID, pageRevision: 0 } as const;
    try {
      // Re-checked per request, not only once per batch: a batch that
      // starts above the reserve can cross it part-way, and the reserve is
      // meant to stop the next request, not the next call. The refusal
      // lands in this slot; every slot already read stays intact.
      await this.assertCredits('items', caller, deadline);
      const result = await this.upstream(
        ITEMS_TOOL_NAME,
        'product',
        caller,
        { domain: ref.domain, destination: input.destination, ...location },
        () => this.client.product({ url: ref.vendorUrl, ...location }, budgetOptions(deadline)),
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

  async seller(input: EbayApiSellerInputType, caller?: SourceCaller, deadline?: SourceDeadline): Promise<EbayApiSellerOutputType> {
    const url = this.sellerUrl(input);
    // Exempt from the credit reserve, not from a remembered suspension.
    await this.assertCredits('seller', caller, deadline);
    const result = await this.upstream(SELLER_TOOL_NAME, 'seller_profile', caller, { domain: ebayDomainOfUrl(url) }, () =>
      this.client.sellerProfile({ url }, budgetOptions(deadline)),
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
      this.noteSuspension(bridgeError);
      const status = bridgeError.details.status;
      const attempts = bridgeError.details.attempts;
      await this.audit(toolName, requestType, caller, 'error', bridgeError.code, null, {
        ...metadata,
        httpStatus: typeof status === 'number' ? status : null,
        attempts: typeof attempts === 'number' ? attempts : null,
        creditsUsedThisRequest: null,
        creditsRemaining: this.remaining,
        ...(bridgeError.details.reason === 'deadline' ? { abandoned: true, possiblyCharged: bridgeError.details.possiblyCharged === true } : {}),
        durationMs: Date.now() - startedAt,
      });
      throw bridgeError;
    }
  }

  /**
   * Shaped like the broker's rows so audit_events reads as one ledger: no
   * device, session or tab (nothing is on the device path), the vendor's
   * request id in requestId, the credit figures in metadata. toolName is
   * null for the startup probe, which no tool asked for. Never the key and
   * never the outbound URL; a postal code is fine.
   */
  private async audit(
    toolName: string | null,
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
