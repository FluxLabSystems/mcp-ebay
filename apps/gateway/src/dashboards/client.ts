/**
 * Fluxology dashboard write-path — gateway-served, no Windows device on the
 * path. Talks to the fluxology dashboard-api (/v1/{scope}/feed|upsert) with
 * the per-dashboard ingest tokens from gateway configuration, so scheduled
 * research runs get an authenticated write tool without credentials ever
 * appearing in task text, tool arguments, or output.
 */
import {
  BridgeError,
  type DashboardId,
} from '@browser-bridge/protocol';

export interface DashboardClientOptions {
  baseUrl: string;
  tokens: Partial<Record<DashboardId, string>>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface DashboardFeedResult {
  dashboard: DashboardId;
  /** Listings in the returned root — after filtering, when a filter ran. */
  listingCount: number;
  /** Listings the dashboard holds; equal to listingCount when unfiltered. */
  totalListingCount: number;
  root: Record<string, unknown>;
}

export interface DashboardFeedOptions {
  filter?: {
    active?: boolean;
    status?: readonly string[];
    marketplace?: string;
  };
  fields?: readonly string[];
}

export interface DashboardTouch {
  id: string;
  lastSeen: string;
}

export interface DashboardUpsertResult {
  dashboard: DashboardId;
  ok: boolean;
  summary: Record<string, unknown>;
  result: Record<string, unknown>;
}

const IDENTITY_FIELDS = ['id', 'firstSeen', 'lastSeen', 'lastChanged', 'lastVerified', 'status', 'active'] as const;

/** Strip a listing down to identity + freshness fields for mode "ids". */
function toIdentity(listing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) {
    if (listing[field] !== undefined) out[field] = listing[field];
  }
  return out;
}

/**
 * Project a listing onto a caller-named field allow-list. `id` survives
 * whether or not it was asked for: a record the caller cannot identify can
 * be neither diffed against nor written back, so dropping it would turn a
 * saving into a loss.
 */
function toProjection(listing: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (listing.id !== undefined) out.id = listing.id;
  for (const field of fields) {
    if (listing[field] !== undefined) out[field] = listing[field];
  }
  return out;
}

function statusOf(listing: Record<string, unknown>): string | null {
  return typeof listing.status === 'string' ? listing.status.toLowerCase() : null;
}

/**
 * A listing's marketplace: its own field when it has one, and otherwise the
 * `ebay-`/`kijiji-` prefix of its stable id. The id convention is the only
 * marketplace signal a v3 record is guaranteed to carry.
 */
function marketplaceOf(listing: Record<string, unknown>): string | null {
  if (typeof listing.marketplace === 'string' && listing.marketplace.length > 0) {
    return listing.marketplace.toLowerCase();
  }
  if (typeof listing.id === 'string') {
    const dash = listing.id.indexOf('-');
    if (dash > 0) return listing.id.slice(0, dash).toLowerCase();
  }
  return null;
}

/**
 * Filtering happens here rather than upstream because the dashboard API
 * serves the whole feed and has no query surface. It still earns its keep:
 * the budget a deals run actually exhausts is the model's context, not the
 * gateway's bandwidth.
 */
function matchesFilter(
  listing: Record<string, unknown>,
  filter: NonNullable<DashboardFeedOptions['filter']>,
): boolean {
  if (filter.active !== undefined) {
    // The boards' retirement convention: a record is active unless its own
    // `active` field says false. `status` is a separate lifecycle vocabulary
    // (watching, tracked, needs_revalidation, …) and does not decide
    // retirement — matching it here made active:true match nothing and
    // active:false match everything.
    const isActive = listing.active !== false;
    if (isActive !== filter.active) return false;
  }
  if (filter.status !== undefined) {
    const status = statusOf(listing);
    if (status === null) return false;
    if (!filter.status.some((wanted) => wanted.toLowerCase() === status)) return false;
  }
  if (filter.marketplace !== undefined) {
    const marketplace = marketplaceOf(listing);
    if (marketplace === null || marketplace !== filter.marketplace.toLowerCase()) return false;
  }
  return true;
}

/**
 * The diff the dashboard API computed, lifted out of the upstream body so a
 * run can read what its write changed without parsing the whole response.
 * Only counts the upstream actually sent appear: zero-filling would make
 * "nothing changed" indistinguishable from "the API did not say".
 */
const SUMMARY_FIELDS = ['upserted', 'unchanged', 'created', 'updated', 'skipped', 'removed', 'total'] as const;

function toSummary(result: Record<string, unknown>, sent: number, touched: number): Record<string, unknown> {
  const summary: Record<string, unknown> = { sent, touched };
  for (const field of SUMMARY_FIELDS) {
    if (typeof result[field] === 'number') summary[field] = result[field];
  }
  return summary;
}

function upstreamError(status: number, bodyText: string, context: Record<string, unknown>): BridgeError {
  const details = { ...context, status, body: bodyText.slice(0, 500) };
  if (status === 401 || status === 403) {
    return new BridgeError('ACTION_BLOCKED', 'Dashboard API rejected the ingest token.', details);
  }
  if (status === 429) {
    return new BridgeError('RATE_LIMITED', 'Dashboard API rate limit exceeded.', details);
  }
  if (status === 400 || status === 404 || status === 413) {
    return new BridgeError('ACTION_BLOCKED', `Dashboard API rejected the request (HTTP ${status}).`, details);
  }
  // 409 concurrent-write conflicts and 5xx are retryable upstream failures.
  return new BridgeError('INTERNAL_ERROR', `Dashboard API request failed (HTTP ${status}).`, details);
}

export class DashboardClient {
  private readonly baseUrl: string;
  private readonly tokens: Partial<Record<DashboardId, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DashboardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.tokens = options.tokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  hasWriteToken(dashboard: DashboardId): boolean {
    return typeof this.tokens[dashboard] === 'string';
  }

  async feed(
    dashboard: DashboardId,
    mode: 'full' | 'ids',
    options: DashboardFeedOptions = {},
  ): Promise<DashboardFeedResult> {
    const root = await this.request('GET', `/v1/${dashboard}/feed`, undefined, undefined, { dashboard });
    const listings = Array.isArray(root.listings) ? (root.listings as Record<string, unknown>[]) : [];
    const filter = options.filter;
    const kept =
      filter === undefined ? listings : listings.filter((listing) => matchesFilter(listing, filter));

    // With neither a filter nor `fields`, this is the pre-Phase-2 path
    // exactly: `full` returns the upstream root untouched, object identity
    // and all.
    const projected =
      options.fields !== undefined
        ? kept.map((listing) => toProjection(listing, options.fields!))
        : mode === 'ids'
          ? kept.map((listing) => toIdentity(listing))
          : kept;
    const shaped =
      projected === listings ? root : { ...root, listings: projected };
    return {
      dashboard,
      listingCount: projected.length,
      totalListingCount: listings.length,
      root: shaped,
    };
  }

  async upsert(
    dashboard: DashboardId,
    listings: Record<string, unknown>[] = [],
    touch: readonly DashboardTouch[] = [],
  ): Promise<DashboardUpsertResult> {
    const token = this.tokens[dashboard];
    if (token === undefined) {
      throw new BridgeError(
        'ACTION_BLOCKED',
        `The gateway has no ingest token configured for the "${dashboard}" dashboard (set ${dashboard.toUpperCase()}_INGEST_TOKEN).`,
        { dashboard },
      );
    }
    // A touch is an ordinary upsert of a two-field record: the dashboard
    // API merges by stable id and preserves every field it is not sent, so
    // "still there" costs one {id, lastSeen} instead of the whole record.
    // An id that also arrives as a full listing keeps its full listing —
    // that record carries its own lastSeen and it is the fresher statement.
    const fullIds = new Set(listings.map((listing) => String(listing.id)));
    const touchRecords = touch
      .filter((entry) => !fullIds.has(entry.id))
      .map((entry) => ({ id: entry.id, lastSeen: entry.lastSeen }));
    const payload = [...listings, ...touchRecords];
    if (payload.length === 0) {
      throw new BridgeError('ACTION_BLOCKED', 'An upsert must carry at least one listing or touch.', {
        dashboard,
      });
    }
    const result = await this.request('POST', `/v1/${dashboard}/upsert`, { listings: payload }, token, {
      dashboard,
      listingCount: payload.length,
    });
    return {
      dashboard,
      ok: result.ok === true,
      summary: toSummary(result, payload.length, touchRecords.length),
      result,
    };
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    token: string | undefined,
    context: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BridgeError('INTERNAL_ERROR', 'Dashboard API is unreachable.', {
        ...context,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    const text = await response.text();
    if (!response.ok) throw upstreamError(response.status, text, context);
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('non-object JSON body');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new BridgeError('INTERNAL_ERROR', 'Dashboard API returned a malformed response.', {
        ...context,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
