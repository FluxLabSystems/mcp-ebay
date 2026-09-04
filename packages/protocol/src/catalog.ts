/**
 * Tool catalog — SDD v0.5 §15 (scope/policy class per tool) and §18
 * (timeouts). The catalog is the single source of truth used by the gateway
 * for scope enforcement, command construction, and deadline budgeting.
 */
import type * as z from 'zod/v4';
import {
  ClickInput,
  ClickOutput,
  DashboardFeedInput,
  DashboardFeedOutput,
  DashboardUpsertInput,
  DashboardUpsertOutput,
  EBAY_API_ITEMS_MAX,
  EBAY_API_MAX_PAGE,
  EBAY_API_SEARCH_DEFAULT_LIMIT,
  EbayApiItemsInput,
  EbayApiItemsOutput,
  EbayApiSearchInput,
  EbayApiSearchOutput,
  EbayApiSellerInput,
  EbayApiSellerOutput,
  EbayApiStatusInput,
  EbayApiStatusOutput,
  EXTRACT_MANY_MAX_URLS,
  ExtractInput,
  ExtractManyInput,
  ExtractManyOutput,
  ExtractOutput,
  FillInput,
  FillOutput,
  HandoffInput,
  HandoffOutput,
  ImageGetInput,
  ImageGetOutput,
  ImagesInput,
  ImagesOutput,
  JobStatusInput,
  JobStatusOutput,
  KeyInput,
  KeyOutput,
  NavigateInput,
  NavigateOutput,
  OpenAndExtractInput,
  OpenAndExtractOutput,
  RunCheckpointInput,
  RunCheckpointOutput,
  RunResumeInput,
  RunResumeOutput,
  ScreenshotInput,
  ScreenshotOutput,
  ScrollInput,
  ScrollOutput,
  SelectInput,
  SelectOutput,
  SessionOpenInput,
  SessionOpenOutput,
  SnapshotInput,
  SnapshotOutput,
  TabsInput,
  TabsOutput,
  WaitInput,
  WaitOutput,
  type DashboardId,
} from './tools.js';

export const SCOPE_READ = 'browser:read';
export const SCOPE_INTERACT = 'browser:interact';
export const SCOPE_ADMIN = 'browser:admin';

export type BridgeScope = typeof SCOPE_READ | typeof SCOPE_INTERACT | typeof SCOPE_ADMIN;

export type PolicyClass = 'read' | 'reversible' | 'control';

export interface ToolCatalogEntry {
  /** Public MCP tool name, e.g. `browser_snapshot`. */
  name: string;
  /** Agent wire command name (§12.1 `command`). */
  command: string;
  /** Required OAuth scope (§10.2). */
  scope: typeof SCOPE_READ | typeof SCOPE_INTERACT;
  /** Policy class stamped on agent command envelopes (§15, §12.1). */
  policyClass: PolicyClass;
  /** Gateway tool-call deadline in milliseconds (§18). */
  timeoutMs: number;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

export const DEFAULT_TIMEOUT_MS = 45_000;
const SCREENSHOT_TIMEOUT_MS = 60_000;
export const INTERACTION_TIMEOUT_MS = 15_000;
export const SNAPSHOT_TIMEOUT_MS = 15_000;

/* ------------------------------------------------------------------------- *
 * Batch response-time ceiling (§18)
 *
 * browser_extract_many has to decide, before it starts, whether a batch can
 * finish inside the gateway's deadline for the call or has to become a job.
 * Both numbers it needs come from this file rather than from a guess:
 *
 *   - The deadline is this tool's own catalog timeoutMs. extract_many is
 *     given DEFAULT_TIMEOUT_MS, the tier browser_navigate and browser_extract
 *     already sit in, because one batch item is exactly one navigate plus one
 *     extract and inventing a new tier for the pair would only hide that.
 *
 *   - The per-item charge is SNAPSHOT_TIMEOUT_MS. A tool's timeoutMs is a
 *     worst case, not an expected cost, so charging navigate+extract their
 *     own deadlines (90 s) would promote every batch to a job and tell us
 *     nothing. SNAPSHOT_TIMEOUT_MS is the only figure the catalog states for
 *     "one operation against one already-addressed page", which is what an
 *     item page costs once the tab is pointed at it, and it is a ceiling —
 *     which is the direction a promotion rule must err in.
 *
 *   - The reserve covers what the call owes outside the traversal: the
 *     agent's ACK deadline plus the 250 ms expiry guard the executor keeps
 *     in remainingBudgetMs().
 *
 * The arithmetic today is floor((45_000 - 2_250) / 15_000) = 2 items inline.
 * That is deliberately conservative: a 25-page traversal cannot honestly fit
 * in 45 s, and the job path costs one extra poll, not one call per page.
 * ------------------------------------------------------------------------- */
export const BATCH_ITEM_BUDGET_MS = SNAPSHOT_TIMEOUT_MS;
export const BATCH_INLINE_RESERVE_MS = 2_250;
export const EXTRACT_MANY_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/** Largest batch `mode: "auto"` will answer inline instead of promoting to a job. */
export const MAX_INLINE_BATCH_ITEMS = Math.max(
  1,
  Math.floor((EXTRACT_MANY_TIMEOUT_MS - BATCH_INLINE_RESERVE_MS) / BATCH_ITEM_BUDGET_MS),
);

/**
 * Wall-clock ceiling for a whole batch job, once promoted. A job outlives the
 * envelope that started it by design, so it needs its own bound: the largest
 * batch the schema allows, at the same per-item charge.
 */
export const BATCH_JOB_DEADLINE_MS = EXTRACT_MANY_MAX_URLS * BATCH_ITEM_BUDGET_MS;

/**
 * Extract-family agent commands. The gateway stamps the deployment's
 * shipping destination onto every one of these (audit F-09); it rides the
 * wire envelope and never the public tool schema.
 */
export const EXTRACT_FAMILY_COMMANDS: ReadonlySet<string> = new Set([
  'extract',
  'open_and_extract',
  'extract_many',
]);

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  {
    name: 'browser_session_open',
    command: 'session_open',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Launch or reuse the persistent Google Chrome automation browser context that profileName names on the paired Windows device. The default profile (ebay-research) is the logged-in eBay research context; any other profileName (letters, digits, ".", "_", "-") gets its own isolated Chrome instance, cookies, handle and tabs, so concurrently scheduled routines never share a tab — open one profile per routine (for example wardrobe-research, office-research) and re-open the same name to reuse it. Returns an opaque browserSessionHandle used by every other browser tool.',
    inputSchema: SessionOpenInput,
    outputSchema: SessionOpenOutput,
  },
  {
    name: 'browser_tabs',
    command: 'tabs',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'List open tabs of an application browser session.',
    inputSchema: TabsInput,
    outputSchema: TabsOutput,
  },
  {
    name: 'browser_navigate',
    command: 'navigate',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Navigate a tab to an allowed HTTPS URL. Returns final URL, title, origin, navigation status, the new page revision, and blockedSubresources: every origin the local site allowlist refused an image, script, frame or fetch from while the page loaded (origin, code, request count, one example URL), so a module that renders as an empty skeleton because its data host is outside the allowlist can be reported by host instead of guessed; an empty list on a page that still renders nothing means the gap is not a policy block. browser_wait returns the same tally read again later.',
    inputSchema: NavigateInput,
    outputSchema: NavigateOutput,
  },
  {
    name: 'browser_snapshot',
    command: 'snapshot',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    description:
      'Semantic page snapshot with stable elementRef values scoped to the returned pageRevision. Link-like nodes carry their resolved absolute href (null on everything else), so a listing grid on a host with no extractor can be traversed by browser_navigate instead of by clicking. Visible text that carries a currency amount and sits outside every interactive element (a product page\'s own price, rendered as styled text) is returned as a role "text" node in document order, so a price never has to be read off a screenshot. Secret field values are redacted.',
    inputSchema: SnapshotInput,
    outputSchema: SnapshotOutput,
  },
  {
    name: 'browser_screenshot',
    command: 'screenshot',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      'Capture a viewport, full-page, or element screenshot as an image artifact. Optional scale (0.1-1) downscales the capture for cheaper transfer; omit it for full resolution.',
    inputSchema: ScreenshotInput,
    outputSchema: ScreenshotOutput,
  },
  {
    name: 'browser_images',
    command: 'images',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Enumerate gallery (default) or page image candidates in display order with stable imageId values for the current page revision.',
    inputSchema: ImagesInput,
    outputSchema: ImagesOutput,
  },
  {
    name: 'browser_image_get',
    command: 'image_get',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description:
      'Fetch a previously enumerated image at the highest accessible resolution; returned inline or as a short-TTL signed artifact URL.',
    inputSchema: ImageGetInput,
    outputSchema: ImageGetOutput,
  },
  {
    name: 'browser_click',
    command: 'click',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description:
      'Click a semantic target by elementRef if local policy permits. Protected transaction/account controls are always blocked locally. A control that opens a new tab reports it as openedTab (use that tabId with the other browser_* tools; changed stays false because the original tab did not change) or, when the popup targets a host outside the site allowlist, as popupDenied with the refused URL. A target another element keeps covering (a consent SDK dark filter, a modal veil — often absent from the snapshot) fails within about 3 s as CLICK_INTERCEPTED, details.interceptor naming the overlay: do not retry the click; traverse by the href browser_snapshot link nodes carry (browser_navigate), and leave dismissing a consent banner to the operator.',
    inputSchema: ClickInput,
    outputSchema: ClickOutput,
  },
  {
    name: 'browser_fill',
    command: 'fill',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description:
      'Fill a non-secret field. Password, payment, 2FA, and other secret fields are always blocked locally.',
    inputSchema: FillInput,
    outputSchema: FillOutput,
  },
  {
    name: 'browser_select',
    command: 'select',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Select a variant/radio/select option by elementRef within policy.',
    inputSchema: SelectInput,
    outputSchema: SelectOutput,
  },
  {
    name: 'browser_scroll',
    command: 'scroll',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Scroll the page or a specific element.',
    inputSchema: ScrollInput,
    outputSchema: ScrollOutput,
  },
  {
    name: 'browser_key',
    command: 'key',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Send an allowed navigation key to the focused element.',
    inputSchema: KeyInput,
    outputSchema: KeyOutput,
  },
  {
    name: 'browser_wait',
    command: 'wait',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Wait for a deterministic page condition: text, url pattern, element, or network idle. Also returns blockedSubresources — the origins the local site allowlist has refused requests from since the tab last navigated, read after the wait — so a module that fetches its data after load (a price widget) can be seen asking a host the allowlist refused; on a roster vendor that host is what a coverage_gap report names.',
    inputSchema: WaitInput,
    outputSchema: WaitOutput,
  },
  {
    name: 'browser_extract',
    command: 'extract',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Run versioned site-profile extraction on the current page, dispatched by page kind. eBay (ebay.ca.v1): item /itm/ pages return the full listing record with provenance and confidence; search /sch/ and seller store /str/ or /usr/ pages return an ordered listing-candidate list for traversal; the signed-in My eBay watch list (/mye/myebay/watchlist, /myb/WatchList) returns pageKind "watchlist" — candidates carrying timeLeftText, endsAt, watchlistStatus, seller and any sellerOffer the card advertises, plus signedIn, totalResults (the count the page states) and next-page pagination — and the bids/offers page (/mye/myebay/bidsoffers, /myb/BidsOffers) returns pageKind "offers" with one row per offer (offerPrice, direction from_seller/from_you, offerStatus, expiresText); both are read in the eBay research profile that holds the session, and a sign-in wall is reported as SIGN_IN_REQUIRED rather than as an empty list. Kijiji (kijiji.ca.v1): ad (VIP) pages return the full record, including the poster\'s sellerId, sellerListingsUrl (/o-profile/<posterId>/1, the "View all listings (N)" link) and sellerListingCount; search /b-* pages return candidates plus next-page pagination; a seller /o-profile/ page returns pageKind "seller" with the same candidate list (no live capture of that page kind exists yet — SELLER_PAGE_UNVERIFIED says what to check). Zazzle (zazzle.com.v1): product pages return the wardrobe record (listed-currency prices, priceBasis discriminator, personalization/promo evidence); /s/ and /c/ pages return candidates. Candidate snippets are traversal hints - follow each candidate URL and extract the item page for canonical evidence.',
    inputSchema: ExtractInput,
    outputSchema: ExtractOutput,
  },
  {
    name: 'browser_open_and_extract',
    command: 'open_and_extract',
    // Classified with browser_navigate, not with browser_extract: this tool
    // moves the tab. Reading it as browser:read/read because "it only
    // extracts afterwards" would let a browser:read token drive navigation,
    // which is precisely the widening §10.2 exists to prevent.
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Navigate a tab to an allowed HTTPS URL and run site-profile extraction on the page it lands on, in one call. Returns exactly what browser_extract returns plus finalUrl and navigationStatus. On a search, store, watch-list or offers page the optional search object reduces the candidate list server-side (canonical URLs, limit/offset, a field allow-list, and title/price/format filters) and is applied with its defaults when omitted, so a full results page arrives compact rather than as a hundred-kilobyte candidate dump. limit/offset walk the candidates the fetched page rendered, never the whole result set: hasMore/nextOffset are page-local, the result set continues through hasNextPage/nextPageUrl (navigate it and extract again), and a window the page could not fill is named by a PAGE_LOCAL_LIMIT warning.',
    inputSchema: OpenAndExtractInput,
    outputSchema: OpenAndExtractOutput,
  },
  {
    name: 'browser_extract_many',
    command: 'extract_many',
    // Same reasoning as open_and_extract: a batch navigates, so it carries
    // navigate's scope and policy class. Every URL in the batch goes through
    // the same local URL policy, private-network and protected-endpoint
    // checks a single browser_navigate does; batching is a call-count
    // optimisation and never a policy shortcut.
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: EXTRACT_MANY_TIMEOUT_MS,
    description:
      `Traverse up to ${EXTRACT_MANY_MAX_URLS} item or ad URLs in one call and return one compact record per URL. Read and traversal only: it navigates and extracts, nothing else. Each URL gets its own result slot with its own error, so one dead or blocked page never fails the batch. A page that loads but is not a listing (an error, removed-listing, or deleted-ad page) is ok:false with error.code LISTING_UNAVAILABLE and keeps its record as evidence — only upsert slots with ok:true. mode "auto" answers inline for a batch that fits this tool's deadline and otherwise returns a jobId to poll with browser_job_status.`,
    inputSchema: ExtractManyInput,
    outputSchema: ExtractManyOutput,
  },
  {
    name: 'browser_job_status',
    command: 'job_status',
    // A poll reads agent-local job state and touches no page, so it is a
    // read tool — the traversal it reports was already authorised by the
    // browser:interact call that started the job.
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description:
      'Progress and completed records for a browser_extract_many job: how many URLs are done, how many succeeded, and every result slot finished so far. Pass sinceIndex to receive only slots you have not already read. Answered outside the session command queue so a poll never waits behind the job it is polling.',
    inputSchema: JobStatusInput,
    outputSchema: JobStatusOutput,
  },
  {
    name: 'browser_handoff',
    command: 'handoff',
    scope: SCOPE_INTERACT,
    policyClass: 'control',
    timeoutMs: 1_830_000,
    description:
      'Pause automation so the user can interact manually with the same tab, then resume. Timeout is bounded by timeoutSeconds.',
    inputSchema: HandoffInput,
    outputSchema: HandoffOutput,
  },
];

const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function getToolEntry(name: string): ToolCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}

/**
 * §10.2: browser:interact includes all browser:read tools; browser:admin is
 * diagnostics-only and never satisfies browser tool scopes.
 */
export function scopeSatisfies(tokenScopes: readonly string[], required: BridgeScope): boolean {
  if (tokenScopes.includes(required)) return true;
  if (required === SCOPE_READ && tokenScopes.includes(SCOPE_INTERACT)) return true;
  return false;
}

/* ------------------------------------------------------------------------- *
 * Fluxology dashboard tools — gateway-served, no device on the path. The
 * gateway holds per-dashboard ingest tokens; OAuth scopes below gate which
 * callers may read feeds or upsert records (defined in the Lane B realm).
 * ------------------------------------------------------------------------- */

export const SCOPE_DASHBOARDS_READ = 'dashboards:read';

export const DASHBOARD_WRITE_SCOPES: Readonly<Record<DashboardId, string>> = {
  deals: 'deals:write',
  office: 'office:write',
  jobs: 'jobs:write',
  vacation: 'vacation:write',
  wardrobe: 'wardrobe:write',
};

export const ALL_DASHBOARD_SCOPES: readonly string[] = [
  SCOPE_DASHBOARDS_READ,
  ...Object.values(DASHBOARD_WRITE_SCOPES),
];

export type DashboardToolAction = 'feed' | 'upsert';

export interface DashboardToolCatalogEntry {
  /** Public MCP tool name, e.g. `dashboard_upsert`. */
  name: string;
  action: DashboardToolAction;
  /** Gateway tool-call deadline in milliseconds. */
  timeoutMs: number;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

export const DASHBOARD_TOOL_CATALOG: readonly DashboardToolCatalogEntry[] = [
  {
    name: 'dashboard_feed',
    action: 'feed',
    timeoutMs: 30_000,
    description:
      'Read the current Fluxology dashboard feed (deals, office, jobs, vacation, or wardrobe) so a run can diff its findings against stored records before writing. mode "ids" returns root metadata plus per-listing identity/freshness fields (including the active retirement flag) only. filter.active reads that flag: a record is active unless retired with active:false.',
    inputSchema: DashboardFeedInput,
    outputSchema: DashboardFeedOutput,
  },
  {
    name: 'dashboard_upsert',
    action: 'upsert',
    timeoutMs: 30_000,
    description:
      'Upsert listing records into a Fluxology dashboard (deals, office, jobs, vacation, or wardrobe). Records merge by stable id server-side; unrelated and historical records are preserved. Send only new or materially changed records.',
    inputSchema: DashboardUpsertInput,
    outputSchema: DashboardUpsertOutput,
  },
];

/**
 * Feed reads accept dashboards:read or any per-dashboard write scope
 * (write implies read); upserts require that dashboard's write scope.
 */
export function dashboardScopeSatisfies(
  tokenScopes: readonly string[],
  dashboard: DashboardId,
  action: DashboardToolAction,
): boolean {
  if (action === 'upsert') return tokenScopes.includes(DASHBOARD_WRITE_SCOPES[dashboard]);
  if (tokenScopes.includes(SCOPE_DASHBOARDS_READ)) return true;
  return Object.values(DASHBOARD_WRITE_SCOPES).some((scope) => tokenScopes.includes(scope));
}

export function requiredDashboardScope(dashboard: DashboardId, action: DashboardToolAction): string {
  return action === 'upsert' ? DASHBOARD_WRITE_SCOPES[dashboard] : SCOPE_DASHBOARDS_READ;
}

/* ------------------------------------------------------------------------- *
 * Deals run checkpoints — gateway-served, backed by the gateway's own Store.
 *
 * These tools are named for the run they serve (`deals.*`) rather than for
 * the dashboard they are authorised against, because a run is not a
 * dashboard record and calling them `dashboard.*` would say it was. The
 * scope machinery is keyed on dashboard id, so each entry names its
 * dashboard explicitly and maps its action onto the existing
 * DashboardToolAction: writing a checkpoint authorises like an upsert
 * (deals:write), reading one authorises like a feed read (dashboards:read
 * or any dashboard write scope). No new scope is introduced — the run
 * bookkeeping for a dashboard is exactly as sensitive as the dashboard.
 * ------------------------------------------------------------------------- */

/** The dashboard whose scopes gate the `deals.*` run tools. */
export const RUN_TOOL_DASHBOARD: DashboardId = 'deals';

export type RunToolAction = 'checkpoint' | 'resume';

export interface RunToolCatalogEntry {
  /** Public MCP tool name, e.g. `deals_run_checkpoint`. */
  name: string;
  action: RunToolAction;
  /** Dashboard whose scopes authorise this tool (§10.2 — no new scopes). */
  dashboard: DashboardId;
  /** Gateway tool-call deadline in milliseconds. */
  timeoutMs: number;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

/**
 * A checkpoint write is a dashboard write; a resume read is a dashboard
 * read. Expressing it as a mapping rather than a second scope table is the
 * point: dashboardScopeSatisfies stays the only place the rule lives.
 */
export function runToolDashboardAction(action: RunToolAction): DashboardToolAction {
  return action === 'checkpoint' ? 'upsert' : 'feed';
}

/** Neither tool touches a browser or the dashboard API; both are pure store I/O. */
const RUN_TOOL_TIMEOUT_MS = 10_000;

export const RUN_TOOL_CATALOG: readonly RunToolCatalogEntry[] = [
  {
    name: 'deals_run_checkpoint',
    action: 'checkpoint',
    dashboard: RUN_TOOL_DASHBOARD,
    timeoutMs: RUN_TOOL_TIMEOUT_MS,
    description:
      'Record what a deals run has already done, so a run that ends at the per-turn tool-call limit resumes instead of re-searching. Bookkeeping only: it writes no listing anywhere and drives no browser. searched and verifiedIds accumulate across checkpoints, pendingIds is replaced, notes is replaced, and an omitted field leaves what is stored untouched — so a turn sends only what it just learned. Store identifiers and counts, never page content.',
    inputSchema: RunCheckpointInput,
    outputSchema: RunCheckpointOutput,
  },
  {
    name: 'deals_run_resume',
    action: 'resume',
    dashboard: RUN_TOOL_DASHBOARD,
    timeoutMs: RUN_TOOL_TIMEOUT_MS,
    description:
      'Read back what a deals run already searched and verified. With no runId it returns the most recent resumable run — still running and checkpointed within the last 12 hours; naming a runId returns that run whatever its status, so "already finished" is distinguishable from "never existed". Call this first in a turn that continues a run.',
    inputSchema: RunResumeInput,
    outputSchema: RunResumeOutput,
  },
];

const RUN_CATALOG_BY_NAME = new Map(RUN_TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function getRunToolEntry(name: string): RunToolCatalogEntry | undefined {
  return RUN_CATALOG_BY_NAME.get(name);
}

/* ------------------------------------------------------------------------- *
 * Countdown API source tools — gateway-served, no device on the path
 * (docs/COUNTDOWN-API-PLAN.md §2, §3, §6.3).
 *
 * Their own catalog, not TOOL_CATALOG: they are not browser tools, carry no
 * agent command or policy class, and getToolEntry — which drives the agent
 * wire — must not know them. Scope is browser:read for all three, the scope
 * that already gates browser_extract: these are marketplace reads of the
 * same sensitivity, they are not browser actions, and reusing the scope
 * avoids a Keycloak realm change (recorded in the ADR). The gateway
 * registers them only when it holds a vendor key; absent tools are the
 * documented "unconfigured" state.
 * ------------------------------------------------------------------------- */

export interface SourceToolCatalogEntry {
  /** Public MCP tool name, e.g. `ebay_api_search`. Dot-free: hosts rewrite dots before permission matching. */
  name: string;
  /** Required OAuth scope (§10.2) — always browser:read; see the block comment. */
  scope: typeof SCOPE_READ;
  /** Gateway tool-call deadline in milliseconds; every entry sits under MCP_CLIENT_TOOL_TIMEOUT_MS. */
  timeoutMs: number;
  /**
   * Whether a call spends vendor credits. Drives the idempotentHint the
   * gateway advertises (a charged call is not free to repeat) and is the
   * one entry that reads false: the account probe behind ebay_api_status.
   */
  spendsCredits: boolean;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
}

/**
 * The MCP client's own tool timeout — Claude Code in the cloud, the runtime
 * the scheduled routines run on — observed 2026-09-03 on the redeployed
 * gateway as `tool "ebay_api_search" timed out after 60s`. A call that
 * outlives it loses its result while the vendor may still charge it, so
 * every source tool's deadline sits under this figure with room for the
 * gateway to map the response and for the answer to travel; the earlier
 * 120 s deadlines (and a 90 s per-request timeout) could never be met.
 * Vendor latency really does reach past a minute: the Phase 0 capture of a
 * 240-row auction search took two 120-second timeouts and then 60 s.
 */
export const MCP_CLIENT_TOOL_TIMEOUT_MS = 60_000;

/**
 * Search and items answer inside 50 s: a split search runs its two vendor
 * requests in parallel, and an item batch returns whatever the pool has
 * answered by then (unanswered items come back as re-requestable slots). A
 * seller profile and the free account probe are one request each.
 */
export const SOURCE_SEARCH_TIMEOUT_MS = 50_000;
export const SOURCE_ITEMS_TIMEOUT_MS = 50_000;
export const SOURCE_SELLER_TIMEOUT_MS = 25_000;
export const SOURCE_STATUS_TIMEOUT_MS = 30_000;

/**
 * Ceiling for COUNTDOWN_TIMEOUT_MS, the per-vendor-request timeout: the
 * charged tools' deadline less 2 s of headroom, so a vendor request times
 * out on its own — and is reported as such — before the tool deadline cuts
 * the whole call off.
 */
export const SOURCE_REQUEST_TIMEOUT_MAX_MS = Math.min(SOURCE_SEARCH_TIMEOUT_MS, SOURCE_ITEMS_TIMEOUT_MS) - 2_000;

const SOURCE_CREDITS_SENTENCE =
  "credits.used is the account's month-to-date total, not this call's spend; credits.remaining is the balance to put in the completion report. requestIds is empty when the vendor omits request ids, which it did on every observed response.";

export const SOURCE_TOOL_CATALOG: readonly SourceToolCatalogEntry[] = [
  {
    name: 'ebay_api_search',
    scope: SCOPE_READ,
    timeoutMs: SOURCE_SEARCH_TIMEOUT_MS,
    spendsCredits: true,
    description:
      `Role: this source is a SECONDARY pathway by default (COUNTDOWN_ROLE=secondary, the operator's standing instruction): the Browser Bridge is the first route for every step, and this call is admitted only with fallbackReason (device_offline, bridge_unreachable, challenge_blocked, extractor_gap, operator_request; fallbackNote for the detail) naming why the Bridge could not do it — otherwise it is refused with SOURCE_REJECTED details.reason 'secondary_role' before any probe or credit, and the answer is to use the Bridge. ebay_api_status reports role.name. Search eBay (ebay.ca or ebay.com) through the Countdown API instead of the browser, by searchTerm or by your own https eBay /sch/ URL, and return the same compacted candidate list browser_open_and_extract returns for a search page, so the usual audit and filter rules apply unchanged. Every page fetched spends one vendor credit (maxPage is capped at ${EBAY_API_MAX_PAGE}), and listingType 'all' costs two vendor requests per page — a buy_it_now search and an auction search merged by item id — because an unfiltered search cannot tell an auction from a fixed price. What this call spent is credits.usedThisRequest (both requests of a split search); ${SOURCE_CREDITS_SENTENCE} Call ebay_api_status first and plan against its gate.spendable: this tool is refused with SOURCE_CREDITS_EXHAUSTED (details.reason 'below_reserve' or 'reserve_not_below_plan_limit') while the balance is below the credit reserve, and it never spends while the balance is unknown — the free account endpoint is read first. A vendor 402 that says the account is suspended is SOURCE_REJECTED with details.reason 'account_suspended' (no top-up lifts it; subscribing to a plan does) and is remembered for five minutes, during which every ebay_api_* call is refused without contacting the vendor. It answers inside its ${SOURCE_SEARCH_TIMEOUT_MS / 1000} s tool deadline (the MCP client allows ${MCP_CLIENT_TOOL_TIMEOUT_MS / 1000} s): a search the vendor has not answered by then fails with SOURCE_UNAVAILABLE carrying details.reason 'deadline' and possiblyCharged true, because a single vendor request cannot be partial and the vendor may still charge the abandoned page, so re-issue it after details.retryAfterMs, with a smaller num if it keeps happening. destination is a named value: 'toronto' makes a row's shippingCost eBay's own card estimate for the Toronto postal code, 'forwarder' uses the US forwarder suite, and 'domain_default' sends no location; a shippingCost of null means the card showed nothing readable, never free. Rows carry no bid count or time left (the default field list omits bidCount, and it is null when search.fields asks for it); bids and end times come only from the Bridge item page, and auction prices only from the Bridge browser tools. With a url, sortBy, listingType, condition, categoryId and page are refused because the vendor ignores them; put them in the URL's query string instead. The returned window defaults to search.limit ${EBAY_API_SEARCH_DEFAULT_LIMIT} (a whole page) because paging with search.offset re-issues the vendor requests and spends credits again; narrow or raise search.limit instead of paging.`,
    inputSchema: EbayApiSearchInput,
    outputSchema: EbayApiSearchOutput,
  },
  {
    name: 'ebay_api_items',
    scope: SCOPE_READ,
    timeoutMs: SOURCE_ITEMS_TIMEOUT_MS,
    spendsCredits: true,
    description:
      `Role: this source is a SECONDARY pathway by default (COUNTDOWN_ROLE=secondary, the operator's standing instruction): the Browser Bridge is the first route for every step, and this call is admitted only with fallbackReason (device_offline, bridge_unreachable, challenge_blocked, extractor_gap, operator_request; fallbackNote for the detail) naming why the Bridge could not do it — otherwise it is refused with SOURCE_REJECTED details.reason 'secondary_role' before any probe or credit, and the answer is to use the Bridge. ebay_api_status reports role.name. Read up to ${EBAY_API_ITEMS_MAX} eBay item pages through the Countdown API in one call, by itemId or by https /itm/ URL, and return one browser_extract_many-style result slot per input in input order (mode 'inline', jobId null), so only slots with ok:true are upsert candidates and a LISTING_UNAVAILABLE slot keeps its record as evidence. Each item spends one vendor credit: what this call spent is credits.usedThisRequest, summed over every item the vendor answered; ${SOURCE_CREDITS_SENTENCE} Call ebay_api_status first and plan against its gate.spendable: the call is refused with SOURCE_CREDITS_EXHAUSTED (details.reason 'below_reserve' or 'reserve_not_below_plan_limit') while the balance is below the credit reserve, it never spends while the balance is unknown, and a reserve crossed mid-batch refuses the remaining slots rather than the batch; a vendor 402 that says the account is suspended is SOURCE_REJECTED with details.reason 'account_suspended' and is remembered for five minutes. It answers inside its ${SOURCE_ITEMS_TIMEOUT_MS / 1000} s tool deadline (the MCP client allows ${MCP_CLIENT_TOOL_TIMEOUT_MS / 1000} s): items the pool could not answer in time come back as ok:false slots with error.code SOURCE_UNAVAILABLE and error.details.reason 'deadline' — requested:false means the item was never sent and never charged, requested:true with possiblyCharged:true means its request was abandoned in flight — under a BATCH_TRUNCATED_BY_DEADLINE warning that names the ids to re-request, and credits.usedThisRequest counts answered items only. Item-page shipping from this source is never resolved to a postal code and is not a Canadian figure: the vendor's browser resolves delivery to its own US zip whatever destination says, so every slot carries a DESTINATION_UNVERIFIED warning and the Bridge shipping pass is still required for a landed cost. Pass expectedFormat from the search that found the row: the vendor's item page reports live auctions as fixed price, so an auction slot returns no price, bids or end time (AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE) — auction prices come only from the Bridge. Without expectedFormat a slot's format is unknown and its price is unconfirmed (PRICE_UNCONFIRMED, confidence 0.4): pass expectedFormat from the search that found the row before treating a price as purchasable. A slot that fails maps its own error and never fails the batch.`,
    inputSchema: EbayApiItemsInput,
    outputSchema: EbayApiItemsOutput,
  },
  {
    name: 'ebay_api_seller',
    scope: SCOPE_READ,
    timeoutMs: SOURCE_SELLER_TIMEOUT_MS,
    spendsCredits: true,
    description:
      `Role: this source is a SECONDARY pathway by default (COUNTDOWN_ROLE=secondary, the operator's standing instruction): the Browser Bridge is the first route for every step, and this call is admitted only with fallbackReason (device_offline, bridge_unreachable, challenge_blocked, extractor_gap, operator_request; fallbackNote for the detail) naming why the Bridge could not do it — otherwise it is refused with SOURCE_REJECTED details.reason 'secondary_role' before any probe or credit, and the answer is to use the Bridge. ebay_api_status reports role.name. Look up one eBay seller profile through the Countdown API, by loginId or by https /usr/ or /str/ URL, for the seller-confirmation step of the deals rules: name, profile URL, login id or store slug, member-since, positive-feedback percent, followers, location, top-rated flag and a short description, each null when the vendor did not return it; when member-since, location, top-rated and description are all missing, warnings carries SELLER_FIELDS_ABSENT_FROM_SOURCE so omission is not mistaken for absence. resolved is false when the vendor returned no seller block, and the vendor's message is then in warnings. Each call spends one vendor credit, even when nothing resolves, and seller lookups are never refused by the credit reserve gate — only by a remembered account suspension (SOURCE_REJECTED, details.reason 'account_suspended', five minutes after a vendor 402 that said so): what this call spent is credits.usedThisRequest; ${SOURCE_CREDITS_SENTENCE} It answers inside its ${SOURCE_SELLER_TIMEOUT_MS / 1000} s tool deadline. This tool reads no listing, so it carries no price and no shipping figure; item-page shipping and auction prices are the concern of ebay_api_items and the Bridge.`,
    inputSchema: EbayApiSellerInput,
    outputSchema: EbayApiSellerOutput,
  },
  {
    name: 'ebay_api_status',
    scope: SCOPE_READ,
    timeoutMs: SOURCE_STATUS_TIMEOUT_MS,
    spendsCredits: false,
    description:
      'Read the Countdown API account budget and the source\'s role in one call that spends no credit. Call it first, before any ebay_api_search or ebay_api_items. role.name is COUNTDOWN_ROLE as the gateway runs it: under \'secondary\' (the default and the operator\'s standing instruction) the Browser Bridge is the first route for every step, a charged call is admitted only with a fallbackReason (role.acceptedFallbackReasons), and gate.spendable is what a declared fallback could spend rather than a budget to plan the fire against; under \'primary\' plan the fire against gate.spendable: the credits the reserve gate will admit before it shuts, max(0, credits.remaining minus reserve.effective), null while the balance is unknown. credits.used is the account\'s month-to-date total (the same figure every charged result reports), never a per-call spend; credits.remaining is the balance that goes in the completion report. plan carries the vendor\'s plan name, credits_limit (the free trial\'s one-time 100 requests, or a paid plan\'s monthly allowance: Hobbyist 500, Starter 10,000, Production 250,000) and credits_reset_at; reserve carries COUNTDOWN_CREDIT_RESERVE as configured ("5%" of the plan limit or an absolute count such as "500"), the credit count it resolves to and its basis. gate.open says whether a search or item call would be admitted now; gate.reason names the refusal (below_reserve; reserve_not_below_plan_limit when an absolute reserve is not below the plan\'s limit and must be lowered or set to a percentage; account_suspended while the gateway remembers a vendor 402 that said the account is suspended, which shuts seller lookups too and which only subscribing to a plan lifts — account.suspended and account.vendorMessage carry the vendor\'s wording) or why the gate is open only by fallback (balance_unknown, reserve_unresolved: the vendor\'s own 402 is then the backstop). Seller lookups are never gated by the reserve. The account is probed fresh on every call with a short 8 s timeout and no retry; when the probe fails, probe.ok is false and the plan and credit figures are the last remembered ones, and when nothing is remembered at all the call fails with SOURCE_UNAVAILABLE (a suspension answer still returns the status). build.gateway is the serving gateway\'s GATEWAY_BUILD_SHA.',
    inputSchema: EbayApiStatusInput,
    outputSchema: EbayApiStatusOutput,
  },
];

const SOURCE_CATALOG_BY_NAME = new Map(SOURCE_TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function getSourceToolEntry(name: string): SourceToolCatalogEntry | undefined {
  return SOURCE_CATALOG_BY_NAME.get(name);
}
