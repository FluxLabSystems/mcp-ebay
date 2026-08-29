/**
 * MCP tool surface — SDD v0.5 §15 and Appendix A. The JSON Schemas in
 * Appendix A are normative; these Zod v4 shapes are mechanically equivalent
 * and are exposed through the MCP SDK. Tool names and required fields are
 * stable within major API version 1.
 *
 * Conditional constraints that JSON Schema expresses as allOf/if-then or
 * oneOf (screenshot element mode, wait condition) are enforced with
 * refinements: the validated value set is identical.
 */
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Appendix A.1 common $defs
// ---------------------------------------------------------------------------

export const TabSchema = z.strictObject({
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  pageRevision: z.int(),
});
export type Tab = z.infer<typeof TabSchema>;

export const SemanticNodeSchema = z.strictObject({
  elementRef: z.union([z.string(), z.null()]),
  role: z.string(),
  name: z.string(),
  text: z.string(),
  disabled: z.boolean(),
  checked: z.union([z.boolean(), z.null()]),
  valueRedacted: z.boolean(),
});
export type SemanticNode = z.infer<typeof SemanticNodeSchema>;

export const ImageCandidateSchema = z.strictObject({
  imageId: z.string(),
  order: z.int(),
  thumbnailUrl: z.union([z.string(), z.null()]),
  sourceUrl: z.union([z.string(), z.null()]),
  width: z.union([z.int(), z.null()]),
  height: z.union([z.int(), z.null()]),
  mimeType: z.union([z.string(), z.null()]),
});
export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

export const ArtifactDescriptorSchema = z.strictObject({
  artifactId: z.string(),
  mimeType: z.string(),
  byteLength: z.int(),
  delivery: z.enum(['mcp_inline', 'signed_url']),
  expiresAt: z.union([z.iso.datetime({ offset: true }), z.null()]),
});
export type ArtifactDescriptor = z.infer<typeof ArtifactDescriptorSchema>;

// ---------------------------------------------------------------------------
// Tool input/output schemas (Appendix A)
// ---------------------------------------------------------------------------

export const SessionOpenInput = z.strictObject({
  deviceId: z.string(),
  profileName: z.string().default('ebay-research'),
});
export const SessionOpenOutput = z.strictObject({
  browserSessionHandle: z.string(),
  deviceId: z.string(),
  profileName: z.string(),
  status: z.enum(['ready', 'degraded']),
  tabs: z.array(TabSchema),
});

export const TabsInput = z.strictObject({
  browserSessionHandle: z.string(),
});
export const TabsOutput = z.strictObject({
  tabs: z.array(TabSchema),
});

export const NavigateInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  url: z.url(),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
});
export const NavigateOutput = z.strictObject({
  finalUrl: z.string(),
  title: z.string(),
  origin: z.string(),
  pageRevision: z.int().min(0),
  navigationStatus: z.enum(['committed', 'same_document', 'blocked']),
});

export const SnapshotInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  maxNodes: z.int().min(100).max(10000).default(3000),
});
export const SnapshotOutput = z.strictObject({
  url: z.string(),
  title: z.string(),
  pageRevision: z.int(),
  snapshot: z.array(SemanticNodeSchema),
  truncated: z.boolean(),
});

export const ScreenshotInput = z
  .strictObject({
    browserSessionHandle: z.string(),
    tabId: z.string(),
    mode: z.enum(['viewport', 'full_page', 'element']),
    elementRef: z.string().optional(),
    format: z.enum(['png', 'jpeg']).default('png'),
  })
  .check((ctx) => {
    if (ctx.value.mode === 'element' && ctx.value.elementRef === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'elementRef is required when mode is "element"',
        input: ctx.value,
        path: ['elementRef'],
      });
    }
  });
export const ScreenshotOutput = z.strictObject({
  artifact: ArtifactDescriptorSchema,
  pageRevision: z.int(),
  width: z.int(),
  height: z.int(),
});

export const ImagesInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  scope: z.enum(['page', 'gallery']).default('gallery'),
});
export const ImagesOutput = z.strictObject({
  pageRevision: z.int(),
  images: z.array(ImageCandidateSchema),
});

export const ImageGetInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  imageId: z.string(),
});
export const ImageGetOutput = z.strictObject({
  artifact: ArtifactDescriptorSchema,
  sourceUrl: z.string(),
  pageRevision: z.int(),
});

export const ClickInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  button: z.enum(['left']).default('left'),
});
export const ClickOutput = z.strictObject({
  pageRevision: z.int(),
  url: z.string(),
  changed: z.boolean(),
});

export const FillInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  value: z.string().max(4096),
});
export const FillOutput = z.strictObject({
  pageRevision: z.int(),
  filled: z.boolean(),
});

export const SelectInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string(),
  value: z.string(),
});
export const SelectOutput = z.strictObject({
  pageRevision: z.int(),
  selectedValue: z.string(),
});

export const ScrollInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  elementRef: z.string().optional(),
  deltaX: z.int().min(-5000).max(5000).default(0),
  deltaY: z.int().min(-5000).max(5000),
});
export const ScrollOutput = z.strictObject({
  pageRevision: z.int(),
  scrollX: z.number(),
  scrollY: z.number(),
});

export const ALLOWED_KEYS = [
  'Enter',
  'Escape',
  'Tab',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
] as const;

export const KeyInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  key: z.enum(ALLOWED_KEYS),
});
export const KeyOutput = z.strictObject({
  pageRevision: z.int(),
  sent: z.boolean(),
});

const WaitConditionBase = z.object({
  text: z.string().optional(),
  urlPattern: z.string().optional(),
  elementRef: z.string().optional(),
  networkIdleMs: z.int().min(100).max(5000).optional(),
});

export const WaitInput = z
  .strictObject({
    browserSessionHandle: z.string(),
    tabId: z.string(),
    condition: WaitConditionBase,
    timeoutMs: z.int().min(100).max(30000).default(10000),
  })
  .check((ctx) => {
    const cond = ctx.value.condition;
    const present = (['text', 'urlPattern', 'elementRef', 'networkIdleMs'] as const).filter(
      (key) => cond[key] !== undefined,
    );
    if (present.length !== 1) {
      ctx.issues.push({
        code: 'custom',
        message: 'condition must specify exactly one of text, urlPattern, elementRef, networkIdleMs',
        input: ctx.value,
        path: ['condition'],
      });
    }
  });
export const WaitOutput = z.strictObject({
  satisfied: z.boolean(),
  pageRevision: z.int(),
  elapsedMs: z.int(),
});


/**
 * Selling formats a search filter may name. Mirrors the site-ebay record's
 * SellingFormatKind by value; it is restated here rather than imported
 * because @browser-bridge/protocol must stay free of site packages, and a
 * wire enum may not drift when a site profile revises its record shape.
 * 'unknown' is offered deliberately: a caller that filters by format and
 * still wants rows whose format could not be read has to be able to say so.
 */
export const SellingFormatFilterSchema = z.enum([
  'auction',
  'fixed_price',
  'auction_with_bin',
  'unknown',
]);

// ---------------------------------------------------------------------------
// Phase 2 additions — batch traversal and server-side compaction.
//
// Every shape below is ADDITIVE. `search` joins ExtractInput as an optional
// property, which a strictObject accepts without changing what it already
// validated, and the three new tools are new names. A caller written against
// the Phase 1 surface keeps producing byte-identical calls and results.
//
// The motivation is measured, not speculative: a deals run on 2026-08-29 spent
// its whole per-turn tool budget on page-by-page traversal (one eBay search
// page alone cost 8 calls and returned 160 KB of tracking-laden candidate
// rows) and never reached dashboard.upsert, so the findings were lost.
// ---------------------------------------------------------------------------

/**
 * A caller-supplied title filter runs on the agent, inside the command
 * deadline, once per candidate row. JS RegExp has no step limit, so
 * `(a+)+$` against a long title is a denial of service against the user's
 * own device rather than a slow tool call. Four bounds together keep the
 * work linear enough to be safe, and they are enforced at the schema
 * boundary so a pathological pattern is a validation error at the gateway
 * instead of a stalled agent:
 *
 *   1. the pattern is short (SEARCH_TITLE_REGEX_MAX_LENGTH),
 *   2. the subject is short — the agent matches against the first
 *      SEARCH_TITLE_MATCH_MAX_CHARS characters of a title, which is already
 *      more than eBay's 80-character title cap,
 *   3. the shapes that make backtracking super-linear are refused outright
 *      (see screenTitleRegex), and
 *   4. the agent still checks a wall clock between rows, because a screen
 *      is a heuristic and a bounded-but-slow pattern must not eat the
 *      command's whole deadline.
 */
export const SEARCH_TITLE_REGEX_MAX_LENGTH = 200;
export const SEARCH_TITLE_MATCH_MAX_CHARS = 120;

/** Highest explicit repetition count a title filter may ask for. */
const TITLE_REGEX_MAX_REPETITION = 100;
/** Highest number of unbounded quantifiers (`*`, `+`, `{n,}`) in one pattern. */
const TITLE_REGEX_MAX_UNBOUNDED = 4;

const QUANTIFIER_CHARS = new Set(['*', '+', '?', '{']);

/**
 * Static screen for patterns whose worst case is not linear. Returns a
 * human-readable reason to refuse, or null when the pattern is acceptable.
 *
 * The rule that does the real work is #3: an unbounded or repeated
 * quantifier applied to a GROUP whose body contains either another
 * quantifier or an alternation. That single shape covers both classic
 * exponential families — nested quantifiers `(a+)+` and overlapping
 * alternation `(a|a)*` — which a "reject nested quantifiers" check alone
 * would miss. Quantifiers on a single atom or character class (`.*`,
 * `\d+`, `[a-z]{2,4}`) stay allowed: those are what real filters use.
 */
export function screenTitleRegex(pattern: string): string | null {
  if (pattern.length === 0) return 'pattern is empty';
  if (pattern.length > SEARCH_TITLE_REGEX_MAX_LENGTH) {
    return `pattern exceeds ${SEARCH_TITLE_REGEX_MAX_LENGTH} characters`;
  }

  const openStack: number[] = [];
  let unbounded = 0;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[i + 1];
      // Backreferences make the matcher stateful and defeat any linear-time
      // reasoning about the pattern; there is no title filter that needs one.
      if (next !== undefined && (/[1-9]/.test(next) || next === 'k')) {
        return 'backreferences are not permitted in a title filter';
      }
      i += 1;
      continue;
    }
    if (ch === '[') {
      // Character classes may contain unescaped ( ) | * + ? — skip to the close.
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') j += 1;
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '(') {
      openStack.push(i);
      continue;
    }
    if (ch === ')') {
      const open = openStack.pop();
      if (open === undefined) return 'unbalanced ")" in pattern';
      const quantifier = pattern[i + 1];
      if (quantifier === undefined || !QUANTIFIER_CHARS.has(quantifier)) continue;
      if (quantifier === '?') continue; // at most one repetition; cannot drive blowup
      const body = pattern.slice(open + 1, i);
      if (containsQuantifierOrAlternation(body)) {
        return 'a repeated group containing a quantifier or an alternation can backtrack exponentially';
      }
      continue;
    }
    if (ch === '*' || ch === '+') {
      unbounded += 1;
      continue;
    }
    if (ch === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) continue; // literal "{"; RegExp compilation decides
      const body = pattern.slice(i + 1, close);
      if (!/^\d*(?:,\d*)?$/.test(body) || body === '' || body === ',') continue; // literal
      const parts = body.split(',');
      for (const part of parts) {
        if (part !== '' && Number.parseInt(part, 10) > TITLE_REGEX_MAX_REPETITION) {
          return `explicit repetition counts above ${TITLE_REGEX_MAX_REPETITION} are not permitted`;
        }
      }
      if (parts.length === 2 && parts[1] === '') unbounded += 1;
      i = close;
      continue;
    }
  }
  if (openStack.length > 0) return 'unbalanced "(" in pattern';
  if (unbounded > TITLE_REGEX_MAX_UNBOUNDED) {
    return `at most ${TITLE_REGEX_MAX_UNBOUNDED} unbounded quantifiers are permitted`;
  }
  return null;
}

function containsQuantifierOrAlternation(body: string): boolean {
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      while (j < body.length && body[j] !== ']') {
        if (body[j] === '\\') j += 1;
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === '*' || ch === '+' || ch === '{' || ch === '|') return true;
  }
  return false;
}

/**
 * Compile a screened title filter. Case-insensitive because a marketplace
 * title filter always means "match the words"; never global or sticky,
 * since a stateful lastIndex across rows would silently skip listings.
 * Throws a plain Error the caller converts into its own error model.
 */
export function compileTitleRegex(pattern: string): RegExp {
  const reason = screenTitleRegex(pattern);
  if (reason !== null) throw new Error(`titleRegex rejected: ${reason}`);
  return new RegExp(pattern, 'i');
}

/**
 * Server-side reduction of a search/candidate extraction, evaluated on the
 * agent so the ~200 rows the model does not want never cross the wire.
 * Absent on browser.extract this changes nothing (Phase 1 callers get the
 * Phase 1 payload); browser.open_and_extract applies the defaults below
 * when the field is omitted, which is what keeps a 240-row page small.
 */
export const SearchCompactionInput = z
  .strictObject({
    /**
     * 40 matches what both marketplaces render per page, so the default is
     * "one page of results" rather than an arbitrary truncation. The
     * response always reports candidateCount, hasMore and nextOffset, so a
     * caller can see what it did not receive and page through it.
     */
    limit: z.int().min(1).max(240).default(40),
    offset: z.int().min(0).default(0),
    /**
     * Allow-list of candidate row keys to keep. Deliberately a string list
     * and not an enum: the site packages add candidate fields on their own
     * cadence, and an enum here would have to be edited in lockstep with
     * every such addition or would start rejecting valid requests.
     */
    fields: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
    include: z
      .strictObject({
        titleRegex: z.string().min(1).max(SEARCH_TITLE_REGEX_MAX_LENGTH).optional(),
        minPrice: z.number().min(0).max(1_000_000).optional(),
        maxPrice: z.number().min(0).max(1_000_000).optional(),
        formats: z.array(SellingFormatFilterSchema).min(1).max(4).optional(),
      })
      .optional(),
    /**
     * Rewrite each candidate URL to its canonical form, dropping the
     * `_skw`/`itmmeta`/`hash`/`itmprp` tracking payload eBay hangs off
     * every result link. This is most of the size win and it is on by
     * default; set false only to keep the exact href the page rendered.
     */
    canonicalizeUrls: z.boolean().default(true),
  })
  .check((ctx) => {
    const include = ctx.value.include;
    if (include === undefined) return;
    if (include.titleRegex !== undefined) {
      const reason = screenTitleRegex(include.titleRegex);
      if (reason !== null) {
        ctx.issues.push({
          code: 'custom',
          message: `include.titleRegex is not accepted: ${reason}`,
          input: ctx.value,
          path: ['include', 'titleRegex'],
        });
      } else {
        try {
          new RegExp(include.titleRegex, 'i');
        } catch (err) {
          ctx.issues.push({
            code: 'custom',
            message: `include.titleRegex is not a valid regular expression: ${
              err instanceof Error ? err.message : String(err)
            }`,
            input: ctx.value,
            path: ['include', 'titleRegex'],
          });
        }
      }
    }
    if (
      include.minPrice !== undefined &&
      include.maxPrice !== undefined &&
      include.minPrice > include.maxPrice
    ) {
      ctx.issues.push({
        code: 'custom',
        message: 'include.minPrice must not exceed include.maxPrice',
        input: ctx.value,
        path: ['include', 'minPrice'],
      });
    }
  });
export type SearchCompaction = z.infer<typeof SearchCompactionInput>;

/** Defaults applied when a compacting tool is called without a `search` object. */
export const DEFAULT_SEARCH_COMPACTION: SearchCompaction = SearchCompactionInput.parse({});

export const ExtractInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  /**
   * Versioned site profiles the bridge ships extractors for. The agent
   * dispatches by the live page's host and page kind; this field declares
   * caller intent and a mismatch downgrades to a warning, never a refusal.
   */
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1']),
  /**
   * Optional server-side reduction of a search/candidate page, evaluated on
   * the agent. Omitting it is the Phase 1 behavior exactly — the full
   * candidate list, untouched — so existing callers are unaffected; see
   * SearchCompactionInput for what it does when present.
   */
  search: SearchCompactionInput.optional(),
});
export const ExtractOutput = z.strictObject({
  siteProfile: z.string(),
  pageRevision: z.int(),
  record: z.looseObject({}),
  warnings: z.array(z.string()),
});

export const HandoffInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  message: z.string().max(500),
  timeoutSeconds: z.int().min(30).max(1800).default(300),
});
export const HandoffOutput = z.strictObject({
  resumed: z.boolean(),
  pageRevision: z.int(),
  url: z.string(),
});

/** Upper bound on URLs one browser.extract_many call may traverse. */
export const EXTRACT_MANY_MAX_URLS = 25;

/**
 * One navigate-plus-extract in a single call. The Phase 1 pairing cost two
 * calls per page and the model paid it on every search page and every
 * canonical item; the output is browser.extract's output plus the two
 * fields browser.navigate contributed, so nothing is lost by collapsing it.
 */
export const OpenAndExtractInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  url: z.url(),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1']),
  /**
   * Compaction for search/candidate pages. Omitted, this tool applies
   * DEFAULT_SEARCH_COMPACTION — unlike browser.extract, which stays
   * uncompacted when the field is absent so Phase 1 callers see no change.
   * Ignored on item/ad pages, which have no candidate list to reduce.
   */
  search: SearchCompactionInput.optional(),
});
export const OpenAndExtractOutput = z.strictObject({
  siteProfile: z.string(),
  pageRevision: z.int(),
  record: z.looseObject({}),
  warnings: z.array(z.string()),
  finalUrl: z.string(),
  navigationStatus: z.enum(['committed', 'same_document', 'blocked']),
});

/**
 * Per-URL outcome slot. A batch reports one of these for every URL it was
 * given, in the order it was given them: a page that fails to load, is
 * refused by local policy, or extracts nothing occupies its own slot and
 * never fails the batch around it. That is the whole point of the tool —
 * the Phase 1 recovery cost for one bad page was three extra tool calls.
 */
export const BatchExtractItemSchema = z.strictObject({
  /** The URL as requested, so a caller can line results up with its input. */
  url: z.string(),
  /** Where the tab actually landed; null when navigation never committed. */
  finalUrl: z.union([z.string(), z.null()]),
  ok: z.boolean(),
  siteProfile: z.union([z.string(), z.null()]),
  pageRevision: z.union([z.int(), z.null()]),
  /** Compact projection when compact is true; the provenance record otherwise. */
  record: z.union([z.looseObject({}), z.null()]),
  warnings: z.array(z.string()),
  error: z.union([
    z.strictObject({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
    z.null(),
  ]),
});
export type BatchExtractItem = z.infer<typeof BatchExtractItemSchema>;

/**
 * 'completed' — every requested URL has a slot.
 * 'partial'   — the call ran out of its deadline budget and stopped early;
 *               the slots present are final, the rest were never attempted.
 * 'running'   — a job accepted the batch; poll browser.job_status.
 */
export const BatchStatusSchema = z.enum(['completed', 'partial', 'running']);

export const BatchExtractProgressShape = {
  /** How the call was served. 'auto' resolves to one of these, never itself. */
  mode: z.enum(['inline', 'job']),
  /** Present when mode is 'job'; pass it to browser.job_status. */
  jobId: z.union([z.string(), z.null()]),
  status: BatchStatusSchema,
  requested: z.int().min(0),
  completed: z.int().min(0),
  succeeded: z.int().min(0),
  failed: z.int().min(0),
  compact: z.boolean(),
  /** Index of the first slot in `results`, so a poller can resume cheaply. */
  resultsFrom: z.int().min(0),
  results: z.array(BatchExtractItemSchema),
  warnings: z.array(z.string()),
} as const;

/**
 * Traverse up to EXTRACT_MANY_MAX_URLS item/ad pages in one call. Read and
 * traversal only: it navigates and extracts, and has no way to express any
 * other interaction. Each URL is navigated through the same primitive
 * browser.navigate uses, so the local URL allowlist, the private-network
 * rules and the protected-endpoint interception apply per URL exactly as
 * they do to a single navigate — a batch is not a policy shortcut.
 */
export const ExtractManyInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  urls: z.array(z.url()).min(1).max(EXTRACT_MANY_MAX_URLS),
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1']),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
  /** Appendix A compact projection; the reason the batch fits in context. */
  compact: z.boolean().default(true),
  /**
   * Accepted for forward compatibility and bounded at 4. A session executes
   * its commands serially through one FIFO queue and a batch drives a
   * single tab, so the agent currently coerces anything above 1 back to
   * sequential traversal and says so in `warnings` rather than opening tabs
   * behind the session's back.
   */
  concurrency: z.int().min(1).max(4).default(1),
  /**
   * 'auto' (default) answers inline when the batch plausibly fits inside
   * this tool's gateway deadline and promotes to a job when it does not;
   * 'inline' and 'job' force one or the other. A forced inline batch that
   * runs out of budget returns status 'partial' rather than timing out.
   */
  mode: z.enum(['auto', 'inline', 'job']).default('auto'),
});
export const ExtractManyOutput = z.strictObject(BatchExtractProgressShape);

/**
 * Progress and completed records for a batch job. The job store lives on
 * the agent because that is where the browser is, so this call carries
 * browserSessionHandle: the broker routes by handle (apps/gateway/src/
 * broker.ts call()) and without it a poll could reach a different device.
 */
export const JobStatusInput = z.strictObject({
  browserSessionHandle: z.string(),
  jobId: z.string(),
  /**
   * Return only slots at or after this index. A poller that has already
   * seen the first 12 results asks for 12 and pays for the rest only.
   */
  sinceIndex: z.int().min(0).default(0),
});
export const JobStatusOutput = z.strictObject(BatchExtractProgressShape);

/**
 * Fluxology dashboard tools — served by the gateway itself (no Windows
 * device involved). The gateway holds the per-dashboard ingest tokens; the
 * scheduled research runs never see credentials in task text or output.
 */
export const DASHBOARD_IDS = ['deals', 'office', 'jobs', 'vacation'] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

export const DashboardFeedInput = z.strictObject({
  dashboard: z.enum(DASHBOARD_IDS),
  /**
   * 'ids' returns root metadata plus per-listing {id, firstSeen, lastSeen,
   * lastChanged, status} only — enough to diff a run's findings against the
   * stored feed without pulling every full record into context.
   */
  mode: z.enum(['full', 'ids']).default('full'),
  /**
   * Applied by the gateway after fetching, because the dashboard API serves
   * the whole feed and has no query surface. Filtering here still earns its
   * keep: what it saves is the model's context, which is the budget that
   * actually ran out.
   */
  filter: z
    .strictObject({
      /**
       * true keeps only listings whose status reads as active; false keeps
       * only those that do not. A listing with no status at all is not
       * "active" — the run that wrote it never claimed it was.
       */
      active: z.boolean().optional(),
      /** Case-insensitive status allow-list, e.g. ["active","price_drop"]. */
      status: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
      /**
       * Matches a listing's own marketplace field when it carries one, and
       * otherwise the `ebay-`/`kijiji-` prefix of its stable id — the id
       * convention is the only marketplace signal a v3 record is guaranteed
       * to have.
       */
      marketplace: z.string().min(1).max(64).optional(),
    })
    .optional(),
  /**
   * Per-listing field allow-list. `id` is always retained: a record without
   * its id cannot be diffed or written back. Present, this replaces the
   * projection `mode` would have applied; absent, `mode` behaves exactly as
   * it always has.
   */
  fields: z.array(z.string().min(1).max(64)).min(1).max(64).optional(),
});
export const DashboardFeedOutput = z.strictObject({
  dashboard: z.string(),
  /** Listings in the returned root — after filtering, when a filter ran. */
  listingCount: z.int(),
  /** Listings the dashboard actually holds; equal to listingCount unfiltered. */
  totalListingCount: z.int(),
  root: z.looseObject({}),
});

export const DashboardUpsertInput = z
  .strictObject({
    dashboard: z.enum(DASHBOARD_IDS),
    /** Merged by stable id server-side; existing unrelated records are preserved. */
    listings: z.array(z.looseObject({ id: z.string().min(1) })).min(1).max(500).optional(),
    /**
     * lastSeen-only refreshes for records a run re-observed unchanged. The
     * upstream merges by id and preserves every field it is not sent, so a
     * touch is a full-fidelity "still there" without re-uploading a record
     * the dashboard already holds. Ids the same call also sends in
     * `listings` are dropped from the touch set — the full record carries
     * its own lastSeen and must win.
     */
    touch: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          lastSeen: z.iso.datetime({ offset: true }),
        }),
      )
      .min(1)
      .max(500)
      .optional(),
  })
  .check((ctx) => {
    // `listings` used to be required; making it optional is what lets a
    // touch-only call exist, and this keeps the "say something" guarantee
    // that .min(1) used to provide on its own.
    if (ctx.value.listings === undefined && ctx.value.touch === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'at least one of listings or touch is required',
        input: ctx.value,
        path: ['listings'],
      });
    }
  });
export const DashboardUpsertOutput = z.strictObject({
  dashboard: z.string(),
  ok: z.boolean(),
  /**
   * The diff the dashboard API computed, lifted out of `result` so a run can
   * read what its write actually changed without parsing the whole upstream
   * body. Counts absent from the upstream response are absent here too —
   * never zero-filled, since "0 updated" and "did not say" differ.
   */
  summary: z.looseObject({}),
  result: z.looseObject({}),
});

export type WaitCondition = z.infer<typeof WaitConditionBase>;
