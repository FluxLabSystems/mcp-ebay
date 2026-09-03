/**
 * Countdown API HTTP client — docs/COUNTDOWN-API-PLAN.md §1.1, §1.4, §2, §6.2.
 *
 * Injectable fetch, one request timeout, bounded retries on 5xx / network /
 * timeout (the vendor's transient "(G)" 500 is uncharged and cleared on the
 * identical retry every time it was seen), status codes mapped to the §2
 * error codes. The API key never appears in an error: every message and every
 * `details` value is redacted, and the outbound URL is never attached to an
 * error at all, so its query string cannot leak.
 */
import { BridgeError, type BridgeErrorCode } from '@browser-bridge/protocol';
import type * as z from 'zod/v4';
import type { CountdownDomain } from './common.js';
import {
  AccountResponseSchema,
  ProductResponseSchema,
  SearchResponseSchema,
  SellerProfileResponseSchema,
  parseCountdownBody,
  stripAccountSecrets,
  summarizeAccount,
  type AccountResponse,
  type CountdownAccountInfo,
  type ProductResponse,
  type SearchResponse,
  type SellerProfileResponse,
} from './schemas.js';

export const COUNTDOWN_DEFAULT_BASE_URL = 'https://api.countdownapi.com';
/**
 * Per-request default when no timeout is configured. The gateway passes
 * COUNTDOWN_TIMEOUT_MS (default 45 s, at most the 50 s tool deadline less
 * 2 s): a request has to time out on its own before the tool deadline cuts
 * the call off, because the MCP client allows a tool 60 s in all.
 */
export const COUNTDOWN_DEFAULT_TIMEOUT_MS = 45_000;
/** 2 s then 6 s: two retries, per §6.2. */
export const COUNTDOWN_DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2000, 6000];
/**
 * A retry is attempted only when, after its backoff, at least this much of
 * the tool's budget remains: a vendor request given less than 10 s is a
 * second timeout rather than a second chance, and the tool deadline would
 * cut it off with the credit possibly charged.
 */
export const COUNTDOWN_RETRY_MIN_BUDGET_MS = 10_000;

/**
 * The tool-call budget a request runs under (docs/COUNTDOWN-API-PLAN.md
 * §1.4: the MCP client allows a tool 60 s). Every attempt's timeout is
 * capped to what remains, a retry is skipped when the remainder could not
 * hold one, and `signal` — which the gateway aborts at the deadline and
 * when the call is over — cancels an in-flight fetch so no vendor request
 * outlives the tool call it was made for.
 */
export interface CountdownRequestBudget {
  /** Milliseconds left in the tool call; never negative. */
  remainingMs(): number;
  signal?: AbortSignal;
}

export interface CountdownCallOptions {
  budget?: CountdownRequestBudget;
  /** A per-call cap on the request timeout (the account probe runs on 8 s, not the configured 45 s). */
  timeoutMs?: number;
  /** False disables the retry ladder for this call: a probe that cannot answer once is not answered by asking thrice. */
  retry?: boolean;
}

export interface CountdownClientOptions {
  apiKey: string;
  /** Overridable for the integration stub only. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Per upstream request; a five-page search can take most of a minute. */
  timeoutMs?: number;
  /** One entry per retry; the length is the retry budget. `[]` disables retries. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export type CountdownSortBy =
  | 'best_match'
  | 'price_high_to_low'
  | 'price_low_to_high'
  | 'price_high_to_low_plus_postage'
  | 'price_low_to_high_plus_postage'
  | 'newly_listed'
  | 'ending_soonest';

export type CountdownListingType = 'all' | 'buy_it_now' | 'auction' | 'accepts_offers';

/**
 * `type=search` parameters (§1.2). Names are camelCase here and mapped to the
 * vendor's snake_case in `search()`. When `url` is given the vendor ignores
 * ebayDomain, sortBy, searchTerm, listingType, condition and page.
 */
export interface CountdownSearchParams {
  ebayDomain?: CountdownDomain;
  searchTerm?: string;
  url?: string;
  sortBy?: CountdownSortBy;
  listingType?: CountdownListingType;
  condition?: string;
  categoryId?: string;
  num?: 60 | 120 | 240;
  page?: number;
  /** ≤ 5 on real-time requests; each page costs one credit. */
  maxPage?: number;
  customerLocation?: string;
  /** Passed through exactly as given; the gateway normalises it first. */
  customerZipcode?: string;
  allowRewrittenResults?: boolean;
  includeHtml?: boolean;
}

/** `type=product` parameters. `customerZipcode` is deliberately absent: the vendor rejects it on products (§1.2). */
export interface CountdownProductParams {
  ebayDomain?: CountdownDomain;
  url?: string;
  epid?: string;
  customerLocation?: string;
  includeHtml?: boolean;
}

export interface CountdownSellerProfileParams {
  ebayDomain?: CountdownDomain;
  url?: string;
  sellerName?: string;
}

export interface CountdownCredits {
  /** `request_info.credits_used`; null when the vendor omitted it. */
  used: number | null;
  /** `request_info.credits_remaining`; null when omitted. */
  remaining: number | null;
  /** `request_info.credits_used_this_request`; null when omitted. */
  usedThisRequest: number | null;
}

export interface CountdownResult<T> {
  body: T;
  credits: CountdownCredits;
  /** `request_metadata.id`; null when the vendor omitted it. */
  requestId: string | null;
  httpStatus: number;
  /** Fetch attempts made, retries included. */
  attempts: number;
}

/** `account()`: the response plus the plan and credit figures read out of it, typed and key-free. */
export interface CountdownAccountResult extends CountdownResult<AccountResponse> {
  account: CountdownAccountInfo;
}

export type CountdownRequestType = 'search' | 'product' | 'seller_profile' | 'account';

type QueryValue = string | number | boolean | undefined | null;

type Attempt =
  | { kind: 'response'; status: number; text: string; headers: Headers }
  | { kind: 'timeout'; message: string }
  | { kind: 'network'; message: string };

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readVendorMessage(parsed: unknown): string | null {
  const root = asRecord(parsed);
  if (root === null) return null;
  const info = asRecord(root.request_info);
  for (const candidate of [info?.message, root.message, root.error]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function readNumberish(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `retry_after` from the body (root or request_info) else the Retry-After header, in seconds. */
function readRetryAfter(parsed: unknown, headers: Headers | null): number | null {
  const root = asRecord(parsed);
  const info = root === null ? null : asRecord(root.request_info);
  const fromBody = readNumberish(root?.retry_after) ?? readNumberish(info?.retry_after);
  if (fromBody !== null) return fromBody;
  const header = headers?.get('retry-after') ?? null;
  return header === null ? null : readNumberish(header);
}

/** A query string (anything after `?` up to whitespace or a quote) that names api_key. */
const QUERY_WITH_KEY_RE = /\?[^\s"'<>]*api_key=[^\s"'<>]*/g;

/** The vendor's suspension wording on a 402, wherever it puts the message (request_info.message or the body's message). */
const SUSPENDED_RE = /suspend/i;

function snippet(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export class CountdownClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly redactions: readonly string[];

  constructor(options: CountdownClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw new Error('CountdownClient: apiKey must be a non-empty string');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? COUNTDOWN_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? COUNTDOWN_DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? COUNTDOWN_DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // The key as typed and as URLSearchParams would encode it.
    this.redactions = [...new Set([this.apiKey, encodeURIComponent(this.apiKey)])];
  }

  /** `type=search`; one credit per page (`maxPage` pages). */
  async search(params: CountdownSearchParams, options?: CountdownCallOptions): Promise<CountdownResult<SearchResponse>> {
    const query = this.query({
      type: 'search',
      ebay_domain: params.ebayDomain,
      search_term: params.searchTerm,
      url: params.url,
      sort_by: params.sortBy,
      listing_type: params.listingType,
      condition: params.condition,
      category_id: params.categoryId,
      num: params.num,
      page: params.page,
      max_page: params.maxPage,
      customer_location: params.customerLocation,
      customer_zipcode: params.customerZipcode,
      allow_rewritten_results: params.allowRewrittenResults,
      include_html: params.includeHtml,
    });
    return this.call('/request', query, SearchResponseSchema, 'search', options);
  }

  /** `type=product`; one credit. Never sends customer_zipcode (rejected by the vendor). */
  async product(params: CountdownProductParams, options?: CountdownCallOptions): Promise<CountdownResult<ProductResponse>> {
    const query = this.query({
      type: 'product',
      ebay_domain: params.ebayDomain,
      url: params.url,
      epid: params.epid,
      customer_location: params.customerLocation,
      include_html: params.includeHtml,
    });
    return this.call('/request', query, ProductResponseSchema, 'product', options);
  }

  /** `type=seller_profile`; one credit. The `url` form returns the fuller set (§1.3). */
  async sellerProfile(params: CountdownSellerProfileParams, options?: CountdownCallOptions): Promise<CountdownResult<SellerProfileResponse>> {
    const query = this.query({
      type: 'seller_profile',
      ebay_domain: params.ebayDomain,
      url: params.url,
      seller_name: params.sellerName,
    });
    return this.call('/request', query, SellerProfileResponseSchema, 'seller_profile', options);
  }

  /**
   * `GET /account`; free, no credits. The vendor echoes the account's own
   * api_key (and email) in `account_info`; both are removed from the body
   * before it leaves the client, and `account` is the typed reading of what
   * remains.
   */
  async account(options?: CountdownCallOptions): Promise<CountdownAccountResult> {
    const result = await this.call('/account', this.query({}), AccountResponseSchema, 'account', options);
    return { ...result, body: stripAccountSecrets(result.body), account: summarizeAccount(result.body) };
  }

  private query(entries: Record<string, QueryValue>): URLSearchParams {
    const query = new URLSearchParams();
    query.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === null) continue;
      query.set(key, typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value));
    }
    return query;
  }

  /** One fetch, bounded by `timeoutMs` and, when the call has a budget, cancelled by its signal. */
  private async attempt(url: string, timeoutMs: number, external: AbortSignal | undefined): Promise<Attempt> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = external === undefined ? timeout : AbortSignal.any([timeout, external]);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return isTimeoutError(err) ? { kind: 'timeout', message } : { kind: 'network', message };
    }
    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return isTimeoutError(err) ? { kind: 'timeout', message } : { kind: 'network', message };
    }
    return { kind: 'response', status: response.status, text, headers: response.headers };
  }

  private async call<S extends z.ZodType>(
    path: '/request' | '/account',
    query: URLSearchParams,
    schema: S,
    requestType: CountdownRequestType,
    options: CountdownCallOptions = {},
  ): Promise<CountdownResult<z.output<S>>> {
    const url = `${this.baseUrl}${path}?${query.toString()}`;
    const budget = options.budget;
    const remainingMs = (): number => (budget === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(budget.remainingMs())));
    // A function, not a narrowed property read: the signal flips while the
    // attempt is awaited, and a property narrowed before the await would
    // read as still false after it.
    const deadlinePassed = (): boolean => budget?.signal?.aborted === true;
    for (let attempt = 0; ; attempt += 1) {
      const attempts = attempt + 1;
      const base: Record<string, unknown> = { requestType, endpoint: path, attempts };
      // On a retry the deadline passed during the backoff: an earlier
      // attempt was sent, so the vendor may still have charged it.
      if (deadlinePassed()) throw this.abandoned(requestType, base, attempt > 0);

      // The attempt's timeout is the configured one (or the call's own
      // cap), capped to what the tool call has left, so the request always
      // fails on its own terms before the tool deadline fails it.
      const timeoutMs = Math.max(1, Math.min(this.timeoutMs, options.timeoutMs ?? this.timeoutMs, remainingMs()));
      const outcome = await this.attempt(url, timeoutMs, budget?.signal);
      if (deadlinePassed()) throw this.abandoned(requestType, base, true);

      // A retry needs its backoff plus a real request to fit the budget;
      // one skipped for want of budget says so on the error.
      const delay = this.retryDelaysMs[attempt] ?? 0;
      const retryAllowed = options.retry !== false && attempt < this.retryDelaysMs.length;
      const retryFits = remainingMs() - delay >= COUNTDOWN_RETRY_MIN_BUDGET_MS;
      const canRetry = retryAllowed && retryFits;
      const budgetNote = retryAllowed && !retryFits ? { retrySkippedForBudget: true, remainingBudgetMs: remainingMs() } : {};

      if (outcome.kind !== 'response') {
        if (canRetry) {
          await this.sleep(delay);
          continue;
        }
        if (outcome.kind === 'timeout') {
          throw this.fail(
            'SOURCE_UNAVAILABLE',
            `Countdown API ${requestType} request timed out after ${timeoutMs} ms (${attempts} attempt(s))`,
            { ...base, reason: 'timeout', timeoutMs, ...budgetNote },
          );
        }
        throw this.fail('SOURCE_UNAVAILABLE', `Countdown API ${requestType} request failed: ${outcome.message}`, {
          ...base,
          reason: 'network',
          cause: outcome.message,
          ...budgetNote,
        });
      }

      const { status, text, headers } = outcome;
      const parsed = tryParseJson(text);
      const vendorMessage = readVendorMessage(parsed) ?? (status >= 400 ? snippet(text) : null);
      const suffix = vendorMessage !== null && vendorMessage.length > 0 ? `: ${vendorMessage}` : '';

      if (status >= 500) {
        if (canRetry) {
          await this.sleep(delay);
          continue;
        }
        const retryAfter = readRetryAfter(parsed, headers);
        throw this.fail('SOURCE_UNAVAILABLE', `Countdown API ${requestType} returned HTTP ${status}${suffix}`, {
          ...base,
          status,
          reason: status === 503 ? 'incident' : 'server_error',
          vendorMessage,
          ...(retryAfter !== null ? { retryAfter } : {}),
          ...budgetNote,
        });
      }

      if (status >= 400) {
        const details: Record<string, unknown> = { ...base, status, vendorMessage };
        if (status === 402) {
          // The vendor answers 402 for two different things. Out of credits
          // is the reserve gate's business. A suspended account (2026-09-03:
          // "temporarily suspended as our systems detected multiple Free
          // Trial accounts … removed when you subscribe to a Plan") is not:
          // no top-up lifts it, so it is a rejection, never a charge.
          if (vendorMessage !== null && SUSPENDED_RE.test(vendorMessage)) {
            throw this.fail('SOURCE_REJECTED', `Countdown API account suspended (HTTP 402)${suffix}`, {
              ...details,
              httpStatus: status,
              reason: 'account_suspended',
            });
          }
          throw this.fail('SOURCE_CREDITS_EXHAUSTED', `Countdown API credits exhausted (HTTP 402)${suffix}`, details);
        }
        if (status === 429) {
          const retryAfter = readRetryAfter(parsed, headers);
          throw this.fail('RATE_LIMITED', `Countdown API rate limit exceeded (HTTP 429)${suffix}`, {
            ...details,
            ...(retryAfter !== null ? { retryAfter } : {}),
          });
        }
        throw this.fail(
          'SOURCE_REJECTED',
          `Countdown API rejected the ${requestType} request (HTTP ${status})${suffix}`,
          details,
        );
      }

      if (parsed === undefined) {
        throw this.fail('SOURCE_UNAVAILABLE', `Countdown API ${requestType} returned a non-JSON body (HTTP ${status})`, {
          ...base,
          status,
          reason: 'non_json',
          bodySnippet: snippet(text),
        });
      }

      const root = asRecord(parsed);
      const info = root === null ? null : asRecord(root.request_info);
      if (info !== null && info.success === false) {
        throw this.fail('SOURCE_REJECTED', `Countdown API reported failure on the ${requestType} request${suffix}`, {
          ...base,
          status,
          vendorMessage,
        });
      }

      let body: z.output<S>;
      try {
        body = parseCountdownBody(schema, parsed, requestType);
      } catch (err) {
        if (err instanceof BridgeError) throw this.fail(err.code, err.message, { ...err.details, ...base });
        throw err;
      }

      const metadata = root === null ? null : asRecord(root.request_metadata);
      const requestId = typeof metadata?.id === 'string' ? metadata.id : null;
      const account = root === null ? null : asRecord(root.account_info);
      return {
        body,
        credits: {
          used: readNumberish(info?.credits_used) ?? readNumberish(account?.credits_used),
          remaining: readNumberish(info?.credits_remaining) ?? readNumberish(account?.credits_remaining),
          usedThisRequest: readNumberish(info?.credits_used_this_request),
        },
        requestId,
        httpStatus: status,
        attempts,
      };
    }
  }

  /**
   * The tool deadline passed: before the request went out (nothing sent,
   * nothing charged) or while it was in flight, in which case the vendor may
   * still serve and charge the request the gateway stopped waiting for.
   */
  private abandoned(requestType: CountdownRequestType, base: Record<string, unknown>, inFlight: boolean): BridgeError {
    return this.fail(
      'SOURCE_UNAVAILABLE',
      inFlight
        ? `Countdown API ${requestType} request abandoned at the tool deadline while in flight; the vendor may still have served and charged it`
        : `Countdown API ${requestType} request not sent: the tool deadline had already passed`,
      { ...base, reason: 'deadline', requested: inFlight, possiblyCharged: inFlight },
    );
  }

  private fail(code: BridgeErrorCode, message: string, details: Record<string, unknown>): BridgeError {
    return new BridgeError(code, this.redact(message), this.redactDeep(details) as Record<string, unknown>);
  }

  /**
   * The key as typed and as encoded, plus any query string that carries an
   * api_key parameter: a fetch implementation may quote the outbound URL in
   * its own error message, and the URL must never surface with its query.
   */
  private redact(text: string): string {
    let out = text;
    for (const secret of this.redactions) {
      if (secret.length === 0) continue;
      out = out.split(secret).join('[REDACTED]');
    }
    return out.replace(QUERY_WITH_KEY_RE, '?[REDACTED]');
  }

  private redactDeep(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactDeep(entry));
    const record = asRecord(value);
    if (record !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(record)) out[this.redact(key)] = this.redactDeep(entry);
      return out;
    }
    return value;
  }
}
