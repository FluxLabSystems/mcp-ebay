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
    /**
     * Linear downscale factor for cheaper captures (0.5 = half width and
     * height, roughly a quarter of the bytes). Absent = full resolution,
     * byte-identical to the pre-scale behavior. 2026-09-01 operator
     * request for parity with the Claude-in-Chrome screenshot surface.
     * NOTE: adding this field changed the advertised tool schema — a
     * gateway redeploy plus a claude.ai connector reconnect applies.
     */
    scale: z.number().min(0.1).max(1).optional(),
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
  /**
   * The fate of a popup the click opened (target=_blank / window.open).
   * `changed` describes the ORIGINAL tab and is false for a successful
   * popup, which is what the 2026-09-02 wardrobe fire saw on Zazzle's
   * "Personalize this design (opens in new tab)" button with no way to tell
   * a popup that opened from one the URL policy denied and closed.
   * openedTab: the adopted tab, addressable by every other browser_* tool.
   * popupDenied: the URL of a popup refused by the site allowlist.
   * NOTE: adding these fields changed the advertised tool schema — a
   * gateway redeploy plus a claude.ai connector reconnect applies.
   */
  openedTab: z.object({ tabId: z.string(), url: z.string() }).nullable(),
  popupDenied: z.string().nullable(),
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
// rows) and never reached dashboard_upsert, so the findings were lost.
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
 * Absent on browser_extract this changes nothing (Phase 1 callers get the
 * Phase 1 payload); browser_open_and_extract applies the defaults below
 * when the field is omitted, which is what keeps a 240-row page small.
 *
 * Built by a factory because the one thing that differs between the Bridge
 * and the Countdown API source is the default window: on the Bridge the
 * next page is one navigate away, on the API it is the vendor requests
 * again (EbayApiSearchCompactionInput). A refined object cannot be
 * extended over, so both are built from the same shape and the same check.
 */
function searchCompactionInput(defaultLimit: number) {
  return z
    .strictObject({
      /**
       * 40 matches what both marketplaces render per page, so the Bridge
       * default is "one page of results" rather than an arbitrary
       * truncation. The response always reports candidateCount, hasMore and
       * nextOffset, so a caller can see what it did not receive and page
       * through it.
       */
      limit: z.int().min(1).max(240).default(defaultLimit),
      offset: z.int().min(0).default(0),
      /**
       * Allow-list of candidate row keys to keep. Deliberately a string list
       * and not an enum: the site packages add candidate fields on their own
       * cadence, and an enum here would have to be edited in lockstep with
       * every such addition or would start rejecting valid requests. Names
       * the two site profiles spell differently are resolved across both
       * (price/snippetPrice, format/sellingFormat, location/locationText/
       * itemLocationText) and returned under the requested name, so one
       * field list works against eBay and Kijiji pages alike.
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
}

export const SearchCompactionInput = searchCompactionInput(40);
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
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1', 'zazzle.com.v1']),
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

/** Upper bound on URLs one browser_extract_many call may traverse. */
export const EXTRACT_MANY_MAX_URLS = 25;

/**
 * One navigate-plus-extract in a single call. The Phase 1 pairing cost two
 * calls per page and the model paid it on every search page and every
 * canonical item; the output is browser_extract's output plus the two
 * fields browser_navigate contributed, so nothing is lost by collapsing it.
 */
export const OpenAndExtractInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  url: z.url(),
  waitUntil: z.enum(['domcontentloaded', 'load']).default('domcontentloaded'),
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1', 'zazzle.com.v1']),
  /**
   * Compaction for search/candidate pages. Omitted, this tool applies
   * DEFAULT_SEARCH_COMPACTION — unlike browser_extract, which stays
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
  /**
   * True only when the slot produced listing evidence. A page that loaded
   * but is not a listing — eBay's error/removed-item template
   * (listingStatus 'unavailable'), a deleted Kijiji ad, or Kijiji's
   * removed-ad redirect — is ok:false with error.code LISTING_UNAVAILABLE,
   * so an upsert keyed on ok never writes an error page to a dashboard.
   * Sold, ended, and expired listings are still ok:true: those pages carry
   * the evidence a re-validation pass exists to collect.
   */
  ok: z.boolean(),
  siteProfile: z.union([z.string(), z.null()]),
  pageRevision: z.union([z.int(), z.null()]),
  /**
   * Compact projection when compact is true; the provenance record
   * otherwise. Present even on a LISTING_UNAVAILABLE slot — what the dead
   * page said is exactly the evidence needed to retire a stored id.
   */
  record: z.union([z.looseObject({}), z.null()]),
  warnings: z.array(z.string()),
  /**
   * Per-slot failure. Usually a catalogued bridge error from navigation or
   * extraction; the slot-only code LISTING_UNAVAILABLE (not in the §17
   * catalog — it is a page outcome, not a call failure) marks a page that
   * answered but holds no listing.
   */
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
 * 'running'   — a job accepted the batch; poll browser_job_status.
 */
export const BatchStatusSchema = z.enum(['completed', 'partial', 'running']);

export const BatchExtractProgressShape = {
  /** How the call was served. 'auto' resolves to one of these, never itself. */
  mode: z.enum(['inline', 'job']),
  /** Present when mode is 'job'; pass it to browser_job_status. */
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
 * browser_navigate uses, so the local URL allowlist, the private-network
 * rules and the protected-endpoint interception apply per URL exactly as
 * they do to a single navigate — a batch is not a policy shortcut.
 */
export const ExtractManyInput = z.strictObject({
  browserSessionHandle: z.string(),
  tabId: z.string(),
  urls: z.array(z.url()).min(1).max(EXTRACT_MANY_MAX_URLS),
  siteProfile: z.enum(['ebay.ca.v1', 'kijiji.ca.v1', 'zazzle.com.v1']),
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
export const DASHBOARD_IDS = ['deals', 'office', 'jobs', 'vacation', 'wardrobe'] as const;
export type DashboardId = (typeof DASHBOARD_IDS)[number];

export const DashboardFeedInput = z.strictObject({
  dashboard: z.enum(DASHBOARD_IDS),
  /**
   * 'ids' returns root metadata plus per-listing {id, firstSeen, lastSeen,
   * lastChanged, lastVerified, status, active} only — enough to diff a run's
   * findings against the stored feed without pulling every full record into
   * context.
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
       * true keeps only listings not retired with active:false; false keeps
       * only the retired ones. This reads the listing's own `active` field —
       * the boards' retirement flag, where absence means active — not the
       * separate `status` lifecycle vocabulary (watching, tracked, …).
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

/* ------------------------------------------------------------------------- *
 * Deals run checkpoints — gateway-served bookkeeping, no device on the path.
 *
 * Root cause 5 of the deals-run budget audit: nothing on the server knew what
 * a run had already done. A run that hit the per-turn tool-call ceiling
 * mid-traversal started the next turn from zero and re-searched, because the
 * only durable record of the turn was audit_events, which is insert-only by
 * design (§21) and answers "what calls happened", never "what has this run
 * verified". These two tools give a run one small, explicitly-written state
 * row instead, so the next turn resumes from the last checkpoint.
 *
 * A checkpoint carries identifiers and counts only. It is deliberately not a
 * place to park scraped page content: the caps below are sized for stable
 * record ids (`ebay-<itemId>`, `kijiji-<adId>`) and short search labels, and
 * the free-text field is the one channel that could otherwise smuggle listing
 * text or personal data into gateway storage, so it is the smallest field
 * here.
 * ------------------------------------------------------------------------- */

/**
 * How long a checkpoint stays readable and resumable, from its last write.
 * A deals routine fires daily, so half a day is the longest a resume can
 * reach back without ever crossing two scheduled fires — a run resumed
 * across that boundary would be replaying yesterday's prices as today's
 * evidence, which is worse than re-searching.
 */
export const RUN_CHECKPOINT_TTL_SECONDS = 12 * 60 * 60;

export const RUN_ID_MAX_LENGTH = 64;
/**
 * Caller-chosen, but constrained: a runId is echoed into tool output and
 * structured logs, so it stays a flat identifier with no whitespace,
 * newlines, or free text that could carry something it should not.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Search labels already run — queries and facets, not result pages. */
export const RUN_CHECKPOINT_MAX_SEARCHED = 24;
export const RUN_CHECKPOINT_SEARCHED_MAX_CHARS = 160;

/**
 * Per-list id ceiling. 250 is half of dashboard_upsert's 500-record limit:
 * a run holding more verified ids than it could write in one upsert has
 * already outgrown a single run, and the checkpoint should not pretend
 * otherwise.
 */
export const RUN_CHECKPOINT_MAX_IDS = 250;
export const RUN_CHECKPOINT_ID_MAX_CHARS = 128;

/** Free text for the next turn. Short on purpose — see the block comment. */
export const RUN_CHECKPOINT_NOTES_MAX_CHARS = 400;

/**
 * Hard ceiling on the stored payload (the three lists plus notes, as JSON).
 * The per-list caps bound the count; this bounds the bytes, which is the
 * quantity that actually decides whether a checkpoint stays small. Oldest
 * entries are trimmed until the payload fits and the trim is reported in
 * `warnings` — a checkpoint is never refused for being too big, because
 * losing the whole checkpoint costs the run more than losing its oldest ids.
 */
export const RUN_CHECKPOINT_MAX_BYTES = 16 * 1024;

/**
 * 'running'   — the run may still be resumed.
 * 'completed' — the run reached its dashboard_upsert; resume will find it by
 *               id but will not offer it as the latest resumable run.
 * 'abandoned' — the run was given up on deliberately; same treatment.
 */
export const RunStatusSchema = z.enum(['running', 'completed', 'abandoned']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

const RunIdSchema = z.string().min(1).max(RUN_ID_MAX_LENGTH).regex(RUN_ID_PATTERN);

/**
 * Every field except runId is optional, and an omitted field leaves what is
 * stored untouched. That is what makes a checkpoint cheap enough to write
 * often: a turn sends the ids it just learned, not the whole run state it
 * would otherwise have to carry in context to be able to resend.
 */
export const RunCheckpointInput = z.strictObject({
  runId: RunIdSchema,
  /**
   * Accumulated by set-union with what is stored. A completed search is a
   * fact that stays true, so a later checkpoint never un-searches one.
   */
  searched: z
    .array(z.string().min(1).max(RUN_CHECKPOINT_SEARCHED_MAX_CHARS))
    .max(RUN_CHECKPOINT_MAX_SEARCHED)
    .optional(),
  /** Accumulated by set-union, for the same reason as `searched`. */
  verifiedIds: z
    .array(z.string().min(1).max(RUN_CHECKPOINT_ID_MAX_CHARS))
    .max(RUN_CHECKPOINT_MAX_IDS)
    .optional(),
  /**
   * Replaced wholesale, not merged: this is the work still outstanding, and
   * a queue that only ever grew by union could never reach empty.
   */
  pendingIds: z
    .array(z.string().min(1).max(RUN_CHECKPOINT_ID_MAX_CHARS))
    .max(RUN_CHECKPOINT_MAX_IDS)
    .optional(),
  /** Replaced when sent. Send an empty string to clear it. */
  notes: z.string().max(RUN_CHECKPOINT_NOTES_MAX_CHARS).optional(),
  /**
   * Optional rather than defaulted: a default of 'running' would silently
   * resurrect a run that a previous checkpoint had already marked complete.
   * A new run with no status starts 'running'.
   */
  status: RunStatusSchema.optional(),
});

export const RunCheckpointOutput = z.strictObject({
  runId: z.string(),
  dashboard: z.string(),
  status: RunStatusSchema,
  /** Number of checkpoints written to this run, this one included. */
  checkpointCount: z.int().min(0),
  searchedCount: z.int().min(0),
  verifiedCount: z.int().min(0),
  pendingCount: z.int().min(0),
  /** Serialized size of the stored payload against RUN_CHECKPOINT_MAX_BYTES. */
  storedBytes: z.int().min(0),
  updatedAt: z.string(),
  expiresAt: z.string(),
  /** Non-empty when the write had to trim to stay inside its bounds. */
  warnings: z.array(z.string()),
});

/**
 * Read a run back. With no runId this answers with the most recent
 * *resumable* run: still 'running', and last written inside
 * RUN_CHECKPOINT_TTL_SECONDS. Naming a runId reads that run whatever its
 * status, so a caller can tell "already finished" from "never existed".
 */
export const RunResumeInput = z.strictObject({
  runId: RunIdSchema.optional(),
});

export const RunResumeOutput = z.strictObject({
  found: z.boolean(),
  /** status === 'running' and within TTL. False for a run already finished. */
  resumable: z.boolean(),
  runId: z.union([z.string(), z.null()]),
  dashboard: z.string(),
  status: z.union([RunStatusSchema, z.null()]),
  searched: z.array(z.string()),
  verifiedIds: z.array(z.string()),
  pendingIds: z.array(z.string()),
  notes: z.union([z.string(), z.null()]),
  checkpointCount: z.int().min(0),
  startedAt: z.union([z.string(), z.null()]),
  updatedAt: z.union([z.string(), z.null()]),
  expiresAt: z.union([z.string(), z.null()]),
  /** Seconds since the last checkpoint — how stale the resumed state is. */
  ageSeconds: z.union([z.int().min(0), z.null()]),
  warnings: z.array(z.string()),
});

/* ------------------------------------------------------------------------- *
 * Countdown API source tools — gateway-served, no device on the path.
 *
 * docs/COUNTDOWN-API-PLAN.md §2 and §3. The three `ebay_api_*` tools read
 * eBay search pages, item pages and seller profiles through a vendor API
 * rather than through the Bridge browser, so a deals run can sweep both
 * marketplaces without spending its per-turn tool budget on page traversal.
 * The gateway holds the vendor key and maps every named destination to one
 * of two fixed postal codes; what is here is the whole caller-facing
 * contract, and the only place the §2 URL policy is written down.
 *
 * Every call spends vendor credits. Nothing below is a browser tool: the
 * catalog entries live in SOURCE_TOOL_CATALOG, not TOOL_CATALOG, and the
 * browser tools' siteProfile enums are unchanged — the Bridge never produces
 * 'ebay.api.v1'.
 * ------------------------------------------------------------------------- */

/** The two marketplaces the deals routine sweeps — the vendor's `ebay_domain`. */
export const EbayApiDomainSchema = z.enum(['ebay.ca', 'ebay.com']);
export type EbayApiDomain = z.infer<typeof EbayApiDomainSchema>;

/**
 * Shipping destinations are named, never free text. The gateway maps
 * 'toronto' to the deployment's Toronto postal code, 'forwarder' to the
 * MyUS Sarasota suite from the multi-path shipping policy, and
 * 'domain_default' to no location parameters at all. Two fixed values keep
 * the vendor account's distinct-zip cap at two and make the skill's "never
 * invent a destination" rule something code enforces. On a search the zip
 * reaches eBay as _stpos, so a row's shippingCost under 'toronto' is eBay's
 * own card estimate for that postal code; on an item page the vendor's
 * browser resolves delivery to its own zip whatever is sent, so item-page
 * shipping is never destination evidence (see EbayApiItemsInput).
 */
export const EbayApiDestinationSchema = z.enum(['toronto', 'forwarder', 'domain_default']);
export type EbayApiDestination = z.infer<typeof EbayApiDestinationSchema>;

/**
 * 'all' is served as TWO vendor requests, buy_it_now and auction, merged and
 * de-duplicated by item id: an unfiltered vendor search reports
 * is_auction: false on live auctions (plan §1.3), so the filter a row was
 * retrieved under is the only trustworthy source of its selling format.
 * credits.used reports both requests.
 */
export const EbayApiListingTypeSchema = z.enum(['all', 'buy_it_now', 'auction', 'accepts_offers']);
export type EbayApiListingType = z.infer<typeof EbayApiListingTypeSchema>;

export const EbayApiSortBySchema = z.enum([
  'best_match',
  'newly_listed',
  'ending_soonest',
  'price_low_to_high',
  'price_high_to_low',
]);
export type EbayApiSortBy = z.infer<typeof EbayApiSortBySchema>;

export const EbayApiConditionSchema = z.enum(['all', 'new', 'used']);
export type EbayApiCondition = z.infer<typeof EbayApiConditionSchema>;

/**
 * The selling format a search established for a row (§3.1). The item tool
 * takes it from the caller because the vendor's item-page is_auction flag
 * reads false on a live auction, so the page cannot say for itself.
 */
export const EbayApiExpectedFormatSchema = z.enum(['auction', 'auction_with_bin', 'fixed_price']);
export type EbayApiExpectedFormat = z.infer<typeof EbayApiExpectedFormatSchema>;

/**
 * An eBay item number: 12 digits today, allowed 10 to 14 so a format change
 * on eBay's side is not a schema release here. A string, as every record
 * field is, and never the vendor's `epid`, which can be a product id.
 */
export const EBAY_ITEM_ID_PATTERN = /^\d{10,14}$/;
export const EbayItemIdSchema = z
  .string()
  .regex(EBAY_ITEM_ID_PATTERN, 'itemId must be a string of 10 to 14 digits');

/**
 * Same ceiling as browser_extract_many, deliberately: the items tool answers
 * in that tool's output shape, and a shortlist that fits one Bridge batch
 * must fit one API batch so a run can hand the same list to either source.
 */
export const EBAY_API_ITEMS_MAX = EXTRACT_MANY_MAX_URLS;

/** The vendor's real-time search ceiling (plan §1.4); Collections go further but are not this tool. */
export const EBAY_API_MAX_PAGE = 5;

/** Page sizes eBay renders. A page is one vendor request whatever its size. */
export const EBAY_API_PAGE_SIZES = [60, 120, 240] as const;

/** Longest search term the tool forwards; eBay's own search box stops well short of it. */
export const EBAY_API_SEARCH_TERM_MAX_CHARS = 200;

/**
 * An eBay seller login id as the /usr/ path segment carries it. Store slugs
 * (/str/<slug>) are a different namespace and are not login ids.
 */
export const EBAY_SELLER_LOGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._*-]{0,63}$/;

/**
 * The vendor's seller description is free marketplace text. A profile
 * result is not a place to park a page, so the mapper truncates to this and
 * the output schema holds it to the same figure.
 */
export const EBAY_API_SELLER_DESCRIPTION_MAX_CHARS = 500;

// --- URL policy (§2) ---------------------------------------------------------

export type EbayUrlKind = 'search' | 'item' | 'seller';

/**
 * Hosts a caller-supplied URL may name, matched exactly: no other subdomain,
 * no lookalike, no trailing dot. This is separate from the browser
 * allowlist in @browser-bridge/policy on purpose — that list describes what
 * the BROWSER may load (image CDNs included), while these tools load
 * nothing themselves: they hand the URL to a third party, so the set of
 * acceptable hosts is the set of pages the vendor is meant to read.
 */
const EBAY_HOST_DOMAIN: ReadonlyMap<string, EbayApiDomain> = new Map<string, EbayApiDomain>([
  ['www.ebay.ca', 'ebay.ca'],
  ['ebay.ca', 'ebay.ca'],
  ['www.ebay.com', 'ebay.com'],
  ['ebay.com', 'ebay.com'],
]);
export const EBAY_URL_HOSTS: readonly string[] = [...EBAY_HOST_DOMAIN.keys()];

const EBAY_URL_PATH_PREFIXES: Readonly<Record<EbayUrlKind, readonly string[]>> = {
  search: ['/sch/'],
  item: ['/itm/'],
  seller: ['/usr/', '/str/'],
};

/**
 * Screen a caller-supplied eBay URL against the §2 policy before it goes
 * anywhere near the vendor. Returns a human-readable reason to refuse, or
 * null when the URL is acceptable for one of `kinds`. Query strings are not
 * inspected: they pass to the vendor verbatim so the routine's existing
 * _ssn=, _sop=10, _ipg=240 and LH_PrefLoc=2 conventions keep working.
 *
 * The parsed (normalised) form is what is judged — WHATWG parsing lowercases
 * the host, resolves dot segments in the path and drops a default port — so
 * "/sch/../itm/1" is an item path and "WWW.EBAY.CA" is an eBay host, while
 * an IDN lookalike arrives as punycode and matches nothing.
 *
 * Before that, the raw string is refused outright if it carries anything
 * the WHATWG parser would silently repair rather than parse: a backslash
 * (a path separator to WHATWG, a host boundary to an RFC 3986 parser, so
 * "https://www.ebay.ca\itm\1@evil.com/" is an eBay item here and host
 * evil.com to the vendor), a tab or newline (dropped), leading or trailing
 * whitespace (stripped), or any other whitespace or control character. A
 * URL that only passes because it was repaired is not the URL a different
 * parser will see, and the gateway forwards the parsed form for the same
 * reason.
 */
export function screenEbayUrl(url: string, kinds: readonly EbayUrlKind[]): string | null {
  if (url !== url.trim()) {
    return 'url must not have leading or trailing whitespace';
  }
  if (hasForbiddenRawUrlChar(url)) {
    return 'url must not contain a backslash, whitespace or a control character';
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'url is not an absolute URL';
  }
  if (parsed.protocol !== 'https:') {
    return `url scheme must be https, not ${parsed.protocol.replace(/:$/, '')}`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'url must not carry userinfo';
  }
  if (parsed.port !== '') {
    return 'url must not name an explicit port';
  }
  if (!EBAY_HOST_DOMAIN.has(parsed.hostname)) {
    return `url host ${parsed.hostname} is not one of ${EBAY_URL_HOSTS.join(', ')}`;
  }
  if (kinds.length === 0) {
    return 'no URL kind is permitted here';
  }
  const prefixes = kinds.flatMap((kind) => EBAY_URL_PATH_PREFIXES[kind]);
  if (!prefixes.some((prefix) => parsed.pathname.startsWith(prefix))) {
    return `url path must start with ${prefixes.join(' or ')} for a ${kinds.join('/')} URL`;
  }
  return null;
}

/** Backslash, C0 controls and space (0x00–0x20), DEL (0x7F), and any other whitespace. */
function hasForbiddenRawUrlChar(url: string): boolean {
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '\\' || code <= 0x20 || code === 0x7f || /\s/.test(ch)) return true;
  }
  return false;
}

/**
 * The marketplace a URL belongs to, by host alone, or null for any host the
 * policy does not know. A caller's `domain` field is ignored when it passes
 * a url (§3.1), and this is how the gateway recovers the domain the vendor
 * parameter and the currency fallback need. Host only: run screenEbayUrl
 * first, because this function does not judge scheme, userinfo, port or
 * path.
 */
export function ebayDomainOfUrl(url: string): EbayApiDomain | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return EBAY_HOST_DOMAIN.get(hostname) ?? null;
}

// --- ebay_api_search (§3.1) --------------------------------------------------

/**
 * The compaction window of an API search. The Bridge defaults `limit` to
 * one rendered page (40) because its next window is one cheap navigate
 * away; here an offset page re-issues the vendor requests and spends the
 * credits again, so the default is the largest window the schema allows —
 * a whole 240-row page, or a merged split search up to that many rows —
 * and a caller narrows it with search.limit rather than paging past it.
 */
export const EBAY_API_SEARCH_DEFAULT_LIMIT = 240;
export const EbayApiSearchCompactionInput = searchCompactionInput(EBAY_API_SEARCH_DEFAULT_LIMIT);
/** Defaults applied when ebay_api_search is called without a `search` object. */
export const EBAY_API_DEFAULT_SEARCH_COMPACTION: SearchCompaction = EbayApiSearchCompactionInput.parse({});

/**
 * One eBay search, by term or by a caller's own /sch/ URL, answered in the
 * compacted shape browser_open_and_extract returns for a search page so a
 * run's audit and filter rules apply unchanged.
 *
 * Exactly one of searchTerm or url. A url search is the routine's existing
 * URL conventions forwarded verbatim, and the vendor ignores sortBy,
 * listingType, condition, categoryId and page alongside it — so those are
 * refused with a url rather than silently doing nothing. The check compares
 * against the defaults, because defaults are applied before it runs and a
 * caller who spells out a default has not asked for anything the url will
 * fail to deliver. num, maxPage, destination, allowRewrittenResults and
 * search still apply to a url search.
 */
export const EbayApiSearchInput = z
  .strictObject({
    /** Ignored when url is given: the URL's host decides (ebayDomainOfUrl). */
    domain: EbayApiDomainSchema.default('ebay.ca'),
    searchTerm: z
      .string()
      .min(1)
      .max(EBAY_API_SEARCH_TERM_MAX_CHARS)
      .regex(/\S/, 'searchTerm must contain a non-space character')
      .optional(),
    /** An https /sch/ URL on www.ebay.ca, ebay.ca, www.ebay.com or ebay.com; see screenEbayUrl. */
    url: z.url().optional(),
    sortBy: EbayApiSortBySchema.optional(),
    /** 'all' costs two vendor requests per page; see EbayApiListingTypeSchema. */
    listingType: EbayApiListingTypeSchema.default('all'),
    condition: EbayApiConditionSchema.default('all'),
    /** An eBay category number, digits only. */
    categoryId: z.string().regex(/^\d{1,16}$/, 'categoryId must be digits').optional(),
    /**
     * Rows per page. 240 is the most eBay renders and the default because a
     * page is one vendor request whatever its size: fewer, larger pages are
     * the cheapest sweep.
     */
    num: z.literal(EBAY_API_PAGE_SIZES).default(240),
    /** First page to fetch, 1-based. */
    page: z.int().min(1).default(1),
    /**
     * Pages fetched from `page` onwards, each one vendor request (two under
     * listingType 'all'). Bounded by the vendor's real-time ceiling.
     */
    maxPage: z.int().min(1).max(EBAY_API_MAX_PAGE).default(1),
    destination: EbayApiDestinationSchema.default('domain_default'),
    /**
     * eBay pads a query it judges too narrow with rows for a rewritten
     * query. Those rows are dropped by default — the vendor's
     * exclude_rewritten parameter plus a defensive filter, counted in an
     * EXCLUDED_REWRITTEN warning — because a rewritten row is not evidence
     * about the query that was asked.
     */
    allowRewrittenResults: z.boolean().default(false),
    /**
     * The compaction browser_open_and_extract applies (include, fields,
     * limit, offset; same warning codes), run through the same function so
     * the two sources compact identically. One default differs: limit is a
     * whole page here (EBAY_API_SEARCH_DEFAULT_LIMIT), because paging with
     * offset re-issues the vendor requests.
     */
    search: EbayApiSearchCompactionInput.optional(),
  })
  .check((ctx) => {
    const value = ctx.value;
    const hasTerm = value.searchTerm !== undefined;
    const hasUrl = value.url !== undefined;
    if (hasTerm === hasUrl) {
      ctx.issues.push({
        code: 'custom',
        message: 'exactly one of searchTerm or url is required',
        input: value,
        path: [hasUrl ? 'url' : 'searchTerm'],
      });
    }
    if (value.url === undefined) return;
    const reason = screenEbayUrl(value.url, ['search']);
    if (reason !== null) {
      ctx.issues.push({
        code: 'custom',
        message: `url is not accepted: ${reason}`,
        input: value,
        path: ['url'],
      });
    }
    // The vendor ignores these on a url search, so accepting them would make
    // the call claim a sort or a filter it never applied.
    const ignoredWithUrl: string[] = [];
    if (value.sortBy !== undefined) ignoredWithUrl.push('sortBy');
    if (value.listingType !== 'all') ignoredWithUrl.push('listingType');
    if (value.condition !== 'all') ignoredWithUrl.push('condition');
    if (value.categoryId !== undefined) ignoredWithUrl.push('categoryId');
    if (value.page !== 1) ignoredWithUrl.push('page');
    for (const field of ignoredWithUrl) {
      ctx.issues.push({
        code: 'custom',
        message: `${field} cannot be combined with url: the vendor ignores it on a url search, so put it in the URL's query string instead`,
        input: value,
        path: [field],
      });
    }
  });
export type EbayApiSearchInputType = z.infer<typeof EbayApiSearchInput>;

/**
 * The vendor's request_info, carried on every source-tool result. Null when
 * the vendor omitted a figure; never zero-filled, since "0 remaining" and
 * "did not say" differ and the reserve gate reads this.
 */
export const EbayApiCreditsSchema = z.strictObject({
  used: z.union([z.int(), z.null()]),
  remaining: z.union([z.int(), z.null()]),
});
export type EbayApiCredits = z.infer<typeof EbayApiCreditsSchema>;

/** The filtered vendor requests a search was actually served by; 'all' becomes ['buy_it_now', 'auction']. */
export const EbayApiRetrievedUnderSchema = z.enum(['buy_it_now', 'auction', 'accepts_offers']);
export type EbayApiRetrievedUnder = z.infer<typeof EbayApiRetrievedUnderSchema>;

export const EbayApiSearchOutput = z.strictObject({
  source: z.literal('countdown'),
  siteProfile: z.literal('ebay.api.v1'),
  pageKind: z.literal('search'),
  /** The vendor's request_metadata.ebay_url for the first request; null when it sent none. */
  pageUrl: z.union([z.string(), z.null()]),
  domain: EbayApiDomainSchema,
  destination: EbayApiDestinationSchema,
  retrievedUnder: z.array(EbayApiRetrievedUnderSchema),
  /** pagination.total_results as an integer; null when the vendor gave none. */
  totalResults: z.union([z.int(), z.null()]),
  /** Rows received from the vendor, de-duplicated across its requests, before compaction. */
  candidateCount: z.int().min(0),
  pagesFetched: z.int().min(0),
  /** The last fetched page's has_next_page; null when the vendor did not say. */
  hasNextPage: z.union([z.boolean(), z.null()]),
  /** ListingCandidate rows plus the API-only fields of plan §4.1, after compaction. */
  candidates: z.array(z.looseObject({})),
  offset: z.int().min(0),
  hasMore: z.boolean(),
  nextOffset: z.union([z.int().min(0), z.null()]),
  warnings: z.array(z.string()),
  credits: EbayApiCreditsSchema,
  /** The vendor's request_metadata.id for every upstream request, in the order they were issued. */
  requestIds: z.array(z.string()),
});
export type EbayApiSearchOutputType = z.infer<typeof EbayApiSearchOutput>;

// --- ebay_api_items (§3.2) ---------------------------------------------------

/**
 * One item to read, by item number or by its own /itm/ URL (which also sets
 * the domain for that item). expectedFormat is the format the search that
 * found the row established; an auction kind makes the slot return the
 * caller's format with itemPrice, endsAt and timeLeftText null and an
 * AUCTION_DETAIL_UNAVAILABLE_FROM_SOURCE warning, because the Bridge is the
 * only source for a bid, an end time or a landed figure on an auction.
 */
export const EbayApiItemRefSchema = z.union([
  z.strictObject({
    itemId: EbayItemIdSchema,
    expectedFormat: EbayApiExpectedFormatSchema.optional(),
  }),
  z
    .strictObject({
      url: z.url(),
      expectedFormat: EbayApiExpectedFormatSchema.optional(),
    })
    .check((ctx) => {
      const reason = screenEbayUrl(ctx.value.url, ['item']);
      if (reason !== null) {
        ctx.issues.push({
          code: 'custom',
          message: `url is not accepted: ${reason}`,
          input: ctx.value,
          path: ['url'],
        });
      }
    }),
]);
export type EbayApiItemRef = z.infer<typeof EbayApiItemRefSchema>;

/**
 * Up to EBAY_API_ITEMS_MAX item pages in one call, answered in
 * browser_extract_many's slot shape so "only upsert slots with ok:true" and
 * "a LISTING_UNAVAILABLE slot keeps its record as evidence" hold without a
 * new rule. destination sets the vendor's customer_location only: the
 * vendor rejects a zip on product requests and its browser resolves
 * item-page delivery to its own zip, so every slot carries
 * DESTINATION_UNVERIFIED and an item-page shipping figure is never a
 * Canadian, let alone a Toronto, cost.
 */
export const EbayApiItemsInput = z.strictObject({
  items: z.array(EbayApiItemRefSchema).min(1).max(EBAY_API_ITEMS_MAX),
  /** Default for itemId entries; an entry given as a url takes its domain from the url. */
  domain: EbayApiDomainSchema.default('ebay.ca'),
  destination: EbayApiDestinationSchema.default('domain_default'),
  /** compactItemRecord() of the mapped record when true; the full record with source 'api' provenance otherwise. */
  compact: z.boolean().default(true),
});
export type EbayApiItemsInputType = z.infer<typeof EbayApiItemsInput>;

/**
 * ExtractManyOutput plus three source fields. The spread is the contract:
 * every key of BatchExtractProgressShape is present with its exact schema,
 * so stripping `source`, `credits` and `requestIds` from a value of this
 * shape yields a valid ExtractManyOutput — which is what lets a run treat
 * API slots and Bridge slots as one list, and what the integration test
 * asserts. The handler always answers mode 'inline' with jobId null and one
 * slot per input in input order; the shape is not narrowed to say so,
 * because the whole point of it is to be a superset of the Bridge's shape.
 */
export const EbayApiItemsOutput = z.strictObject({
  ...BatchExtractProgressShape,
  source: z.literal('countdown'),
  credits: EbayApiCreditsSchema,
  requestIds: z.array(z.string()),
});
export type EbayApiItemsOutputType = z.infer<typeof EbayApiItemsOutput>;

// --- ebay_api_seller (§3.3) --------------------------------------------------

/**
 * One seller profile, by login id or by a /usr/ or /str/ URL: the /usr/
 * confirmation step of the deals rules. Exactly one of loginId or url;
 * domain is ignored with a url, as in the search tool.
 *
 * One strict object with an exactly-one check rather than a union of two
 * objects, for the reason the file header gives: a root-level oneOf would
 * advertise a tool with no root properties, unlike every other tool on this
 * server, while the validated value set is identical.
 */
export const EbayApiSellerInput = z
  .strictObject({
    loginId: z
      .string()
      .regex(EBAY_SELLER_LOGIN_ID_PATTERN, 'loginId must be an eBay login id')
      .optional(),
    /** An https /usr/ or /str/ URL on an eBay host; see screenEbayUrl. */
    url: z.url().optional(),
    domain: EbayApiDomainSchema.default('ebay.ca'),
  })
  .check((ctx) => {
    const value = ctx.value;
    const hasLoginId = value.loginId !== undefined;
    const hasUrl = value.url !== undefined;
    if (hasLoginId === hasUrl) {
      ctx.issues.push({
        code: 'custom',
        message: 'exactly one of loginId or url is required',
        input: value,
        path: [hasUrl ? 'url' : 'loginId'],
      });
    }
    if (value.url === undefined) return;
    const reason = screenEbayUrl(value.url, ['seller']);
    if (reason !== null) {
      ctx.issues.push({
        code: 'custom',
        message: `url is not accepted: ${reason}`,
        input: value,
        path: ['url'],
      });
    }
  });
export type EbayApiSellerInputType = z.infer<typeof EbayApiSellerInput>;

/**
 * Straight renames of the vendor's seller block (plan §4.3). loginId is the
 * /usr/ path segment of profileUrl and storeSlug the /str/ segment; a store
 * slug is not a login id (plan §1.3), so a profile reached through a store
 * link carries storeSlug with loginId null. Everything the vendor may omit
 * is nullable — the url form returns the fuller set, and the measured
 * profile had no memberSince, location or topRated at all.
 */
export const EbayApiSellerProfileSchema = z.strictObject({
  name: z.string(),
  profileUrl: z.string(),
  loginId: z.union([z.string(), z.null()]),
  storeSlug: z.union([z.string(), z.null()]),
  memberSince: z.union([z.string(), z.null()]),
  positivePercent: z.union([z.number(), z.null()]),
  followers: z.union([z.string(), z.null()]),
  location: z.union([z.string(), z.null()]),
  topRated: z.union([z.boolean(), z.null()]),
  description: z.union([z.string().max(EBAY_API_SELLER_DESCRIPTION_MAX_CHARS), z.null()]),
});
export type EbayApiSellerProfile = z.infer<typeof EbayApiSellerProfileSchema>;

export const EbayApiSellerOutput = z.strictObject({
  /** False when the vendor returned no seller block or an empty name; its message is then in warnings. */
  resolved: z.boolean(),
  seller: z.union([EbayApiSellerProfileSchema, z.null()]),
  warnings: z.array(z.string()),
  credits: EbayApiCreditsSchema,
  requestIds: z.array(z.string()),
});
export type EbayApiSellerOutputType = z.infer<typeof EbayApiSellerOutput>;
