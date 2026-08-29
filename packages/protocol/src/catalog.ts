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
  /** Public MCP tool name, e.g. `browser.snapshot`. */
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
 * browser.extract_many has to decide, before it starts, whether a batch can
 * finish inside the gateway's deadline for the call or has to become a job.
 * Both numbers it needs come from this file rather than from a guess:
 *
 *   - The deadline is this tool's own catalog timeoutMs. extract_many is
 *     given DEFAULT_TIMEOUT_MS, the tier browser.navigate and browser.extract
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
    name: 'browser.session_open',
    command: 'session_open',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Launch or reuse the dedicated persistent Google Chrome automation browser context on the paired Windows device. Returns an opaque browserSessionHandle used by every other browser tool.',
    inputSchema: SessionOpenInput,
    outputSchema: SessionOpenOutput,
  },
  {
    name: 'browser.tabs',
    command: 'tabs',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'List open tabs of an application browser session.',
    inputSchema: TabsInput,
    outputSchema: TabsOutput,
  },
  {
    name: 'browser.navigate',
    command: 'navigate',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Navigate a tab to an allowed HTTPS URL. Returns final URL, title, origin, navigation status, and the new page revision.',
    inputSchema: NavigateInput,
    outputSchema: NavigateOutput,
  },
  {
    name: 'browser.snapshot',
    command: 'snapshot',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
    description:
      'Semantic page snapshot with stable elementRef values scoped to the returned pageRevision. Secret field values are redacted.',
    inputSchema: SnapshotInput,
    outputSchema: SnapshotOutput,
  },
  {
    name: 'browser.screenshot',
    command: 'screenshot',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: SCREENSHOT_TIMEOUT_MS,
    description: 'Capture a viewport, full-page, or element screenshot as an image artifact.',
    inputSchema: ScreenshotInput,
    outputSchema: ScreenshotOutput,
  },
  {
    name: 'browser.images',
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
    name: 'browser.image_get',
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
    name: 'browser.click',
    command: 'click',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description:
      'Click a semantic target by elementRef if local policy permits. Protected transaction/account controls are always blocked locally.',
    inputSchema: ClickInput,
    outputSchema: ClickOutput,
  },
  {
    name: 'browser.fill',
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
    name: 'browser.select',
    command: 'select',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Select a variant/radio/select option by elementRef within policy.',
    inputSchema: SelectInput,
    outputSchema: SelectOutput,
  },
  {
    name: 'browser.scroll',
    command: 'scroll',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Scroll the page or a specific element.',
    inputSchema: ScrollInput,
    outputSchema: ScrollOutput,
  },
  {
    name: 'browser.key',
    command: 'key',
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description: 'Send an allowed navigation key to the focused element.',
    inputSchema: KeyInput,
    outputSchema: KeyOutput,
  },
  {
    name: 'browser.wait',
    command: 'wait',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description: 'Wait for a deterministic page condition: text, url pattern, element, or network idle.',
    inputSchema: WaitInput,
    outputSchema: WaitOutput,
  },
  {
    name: 'browser.extract',
    command: 'extract',
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Run versioned site-profile extraction on the current page, dispatched by page kind. eBay (ebay.ca.v1): item /itm/ pages return the full listing record with provenance and confidence; search /sch/ and seller store /str/ or /usr/ pages return an ordered listing-candidate list for traversal. Kijiji (kijiji.ca.v1): ad (VIP) pages return the full record; search /b-* pages return candidates plus next-page pagination. Candidate snippets are traversal hints - follow each candidate URL and extract the item page for canonical evidence.',
    inputSchema: ExtractInput,
    outputSchema: ExtractOutput,
  },
  {
    name: 'browser.open_and_extract',
    command: 'open_and_extract',
    // Classified with browser.navigate, not with browser.extract: this tool
    // moves the tab. Reading it as browser:read/read because "it only
    // extracts afterwards" would let a browser:read token drive navigation,
    // which is precisely the widening §10.2 exists to prevent.
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    description:
      'Navigate a tab to an allowed HTTPS URL and run site-profile extraction on the page it lands on, in one call. Returns exactly what browser.extract returns plus finalUrl and navigationStatus. On a search or store page the optional search object reduces the candidate list server-side (canonical URLs, limit/offset, a field allow-list, and title/price/format filters) and is applied with its defaults when omitted, so a full results page arrives compact rather than as a hundred-kilobyte candidate dump.',
    inputSchema: OpenAndExtractInput,
    outputSchema: OpenAndExtractOutput,
  },
  {
    name: 'browser.extract_many',
    command: 'extract_many',
    // Same reasoning as open_and_extract: a batch navigates, so it carries
    // navigate's scope and policy class. Every URL in the batch goes through
    // the same local URL policy, private-network and protected-endpoint
    // checks a single browser.navigate does; batching is a call-count
    // optimisation and never a policy shortcut.
    scope: SCOPE_INTERACT,
    policyClass: 'reversible',
    timeoutMs: EXTRACT_MANY_TIMEOUT_MS,
    description:
      `Traverse up to ${EXTRACT_MANY_MAX_URLS} item or ad URLs in one call and return one compact record per URL. Read and traversal only: it navigates and extracts, nothing else. Each URL gets its own result slot with its own error, so one dead or blocked page never fails the batch. mode "auto" answers inline for a batch that fits this tool's deadline and otherwise returns a jobId to poll with browser.job_status.`,
    inputSchema: ExtractManyInput,
    outputSchema: ExtractManyOutput,
  },
  {
    name: 'browser.job_status',
    command: 'job_status',
    // A poll reads agent-local job state and touches no page, so it is a
    // read tool — the traversal it reports was already authorised by the
    // browser:interact call that started the job.
    scope: SCOPE_READ,
    policyClass: 'read',
    timeoutMs: INTERACTION_TIMEOUT_MS,
    description:
      'Progress and completed records for a browser.extract_many job: how many URLs are done, how many succeeded, and every result slot finished so far. Pass sinceIndex to receive only slots you have not already read. Answered outside the session command queue so a poll never waits behind the job it is polling.',
    inputSchema: JobStatusInput,
    outputSchema: JobStatusOutput,
  },
  {
    name: 'browser.handoff',
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
};

export const ALL_DASHBOARD_SCOPES: readonly string[] = [
  SCOPE_DASHBOARDS_READ,
  ...Object.values(DASHBOARD_WRITE_SCOPES),
];

export type DashboardToolAction = 'feed' | 'upsert';

export interface DashboardToolCatalogEntry {
  /** Public MCP tool name, e.g. `dashboard.upsert`. */
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
    name: 'dashboard.feed',
    action: 'feed',
    timeoutMs: 30_000,
    description:
      'Read the current Fluxology dashboard feed (deals, office, jobs, or vacation) so a run can diff its findings against stored records before writing. mode "ids" returns root metadata plus per-listing identity/freshness fields only.',
    inputSchema: DashboardFeedInput,
    outputSchema: DashboardFeedOutput,
  },
  {
    name: 'dashboard.upsert',
    action: 'upsert',
    timeoutMs: 30_000,
    description:
      'Upsert listing records into a Fluxology dashboard (deals, office, jobs, or vacation). Records merge by stable id server-side; unrelated and historical records are preserved. Send only new or materially changed records.',
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
