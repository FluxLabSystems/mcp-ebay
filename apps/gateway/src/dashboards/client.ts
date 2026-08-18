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
  listingCount: number;
  root: Record<string, unknown>;
}

export interface DashboardUpsertResult {
  dashboard: DashboardId;
  ok: boolean;
  result: Record<string, unknown>;
}

const IDENTITY_FIELDS = ['id', 'firstSeen', 'lastSeen', 'lastChanged', 'lastVerified', 'status'] as const;

/** Strip a listing down to identity + freshness fields for mode "ids". */
function toIdentity(listing: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) {
    if (listing[field] !== undefined) out[field] = listing[field];
  }
  return out;
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

  async feed(dashboard: DashboardId, mode: 'full' | 'ids'): Promise<DashboardFeedResult> {
    const root = await this.request('GET', `/v1/${dashboard}/feed`, undefined, undefined, { dashboard });
    const listings = Array.isArray(root.listings) ? (root.listings as Record<string, unknown>[]) : [];
    const shaped =
      mode === 'ids' ? { ...root, listings: listings.map((listing) => toIdentity(listing)) } : root;
    return { dashboard, listingCount: listings.length, root: shaped };
  }

  async upsert(dashboard: DashboardId, listings: Record<string, unknown>[]): Promise<DashboardUpsertResult> {
    const token = this.tokens[dashboard];
    if (token === undefined) {
      throw new BridgeError(
        'ACTION_BLOCKED',
        `The gateway has no ingest token configured for the "${dashboard}" dashboard (set ${dashboard.toUpperCase()}_INGEST_TOKEN).`,
        { dashboard },
      );
    }
    const result = await this.request('POST', `/v1/${dashboard}/upsert`, { listings }, token, {
      dashboard,
      listingCount: listings.length,
    });
    return { dashboard, ok: result.ok === true, result };
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
