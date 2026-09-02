/**
 * Contract layer (§27.1): every MCP tool schema in Appendix A — valid
 * inputs accepted with defaults applied, unknown fields rejected, and
 * conditional rules enforced.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  ArtifactDescriptorSchema,
  DASHBOARD_TOOL_CATALOG,
  DashboardFeedInput,
  DashboardUpsertInput,
  dashboardScopeSatisfies,
  EBAY_API_ITEMS_MAX,
  EBAY_API_MAX_PAGE,
  EbayApiItemsOutput,
  EXTRACT_MANY_MAX_URLS,
  ExtractManyOutput,
  getSourceToolEntry,
  ImageCandidateSchema,
  RUN_CHECKPOINT_MAX_IDS,
  RUN_CHECKPOINT_MAX_SEARCHED,
  RUN_CHECKPOINT_NOTES_MAX_CHARS,
  RUN_CHECKPOINT_TTL_SECONDS,
  RUN_ID_MAX_LENGTH,
  RUN_TOOL_CATALOG,
  runToolDashboardAction,
  SEARCH_TITLE_REGEX_MAX_LENGTH,
  SemanticNodeSchema,
  SOURCE_TOOL_CATALOG,
  TabSchema,
  TOOL_CATALOG,
  getRunToolEntry,
  getToolEntry,
  scopeSatisfies,
  SCOPE_INTERACT,
  SCOPE_READ,
} from '@browser-bridge/protocol';

const HANDLE = 'bs_0123456789abcdefgh';
const TAB = 'tab_0123456789';

const VALID_INPUTS: Record<string, Record<string, unknown>> = {
  'browser_session_open': { deviceId: 'dev_1' },
  'browser_tabs': { browserSessionHandle: HANDLE },
  'browser_navigate': { browserSessionHandle: HANDLE, tabId: TAB, url: 'https://www.ebay.ca/itm/1' },
  'browser_snapshot': { browserSessionHandle: HANDLE, tabId: TAB },
  'browser_screenshot': { browserSessionHandle: HANDLE, tabId: TAB, mode: 'viewport' },
  'browser_images': { browserSessionHandle: HANDLE, tabId: TAB },
  'browser_image_get': { browserSessionHandle: HANDLE, tabId: TAB, imageId: 'img_0123456789' },
  'browser_click': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc' },
  'browser_fill': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc', value: 'M6H 2W9' },
  'browser_select': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc', value: 'Friends heavy' },
  'browser_scroll': { browserSessionHandle: HANDLE, tabId: TAB, deltaY: 500 },
  'browser_key': { browserSessionHandle: HANDLE, tabId: TAB, key: 'Enter' },
  'browser_wait': { browserSessionHandle: HANDLE, tabId: TAB, condition: { text: 'M6H 2W9' } },
  'browser_extract': { browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'ebay.ca.v1' },
  'browser_open_and_extract': {
    browserSessionHandle: HANDLE,
    tabId: TAB,
    url: 'https://www.ebay.ca/sch/i.html?_nkw=lego+lot',
    siteProfile: 'ebay.ca.v1',
  },
  'browser_extract_many': {
    browserSessionHandle: HANDLE,
    tabId: TAB,
    urls: ['https://www.ebay.ca/itm/226123456789'],
    siteProfile: 'ebay.ca.v1',
  },
  'browser_job_status': { browserSessionHandle: HANDLE, jobId: 'job_01JABCDEF' },
  'browser_handoff': { browserSessionHandle: HANDLE, tabId: TAB, message: 'Please solve the challenge' },
};

describe('tool catalog completeness (§15)', () => {
  it('exposes exactly the 18 normative tools with scopes and policy classes', () => {
    expect(TOOL_CATALOG).toHaveLength(18);
    const expectations: Array<[string, string, string]> = [
      ['browser_session_open', SCOPE_INTERACT, 'reversible'],
      ['browser_tabs', SCOPE_READ, 'read'],
      ['browser_navigate', SCOPE_INTERACT, 'reversible'],
      ['browser_snapshot', SCOPE_READ, 'read'],
      ['browser_screenshot', SCOPE_READ, 'read'],
      ['browser_images', SCOPE_READ, 'read'],
      ['browser_image_get', SCOPE_READ, 'read'],
      ['browser_click', SCOPE_INTERACT, 'reversible'],
      ['browser_fill', SCOPE_INTERACT, 'reversible'],
      ['browser_select', SCOPE_INTERACT, 'reversible'],
      ['browser_scroll', SCOPE_INTERACT, 'reversible'],
      ['browser_key', SCOPE_INTERACT, 'reversible'],
      ['browser_wait', SCOPE_READ, 'read'],
      ['browser_extract', SCOPE_READ, 'read'],
      // The batch traversal tools navigate, so they carry browser_navigate's
      // scope and policy class rather than browser_extract's. Reading them as
      // browser:read would let a read-only token drive the browser.
      ['browser_open_and_extract', SCOPE_INTERACT, 'reversible'],
      ['browser_extract_many', SCOPE_INTERACT, 'reversible'],
      ['browser_job_status', SCOPE_READ, 'read'],
      ['browser_handoff', SCOPE_INTERACT, 'control'],
    ];
    for (const [name, scope, policyClass] of expectations) {
      const entry = getToolEntry(name);
      expect(entry, name).toBeDefined();
      expect(entry?.scope, name).toBe(scope);
      expect(entry?.policyClass, name).toBe(policyClass);
    }
  });

  it('browser:interact includes read tools; browser:admin includes neither (§10.2)', () => {
    expect(scopeSatisfies(['browser:interact'], SCOPE_READ)).toBe(true);
    expect(scopeSatisfies(['browser:read'], SCOPE_INTERACT)).toBe(false);
    expect(scopeSatisfies(['browser:admin'], SCOPE_READ)).toBe(false);
    expect(scopeSatisfies([], SCOPE_READ)).toBe(false);
  });
});

describe('input schema contracts (Appendix A)', () => {
  for (const entry of TOOL_CATALOG) {
    it(`${entry.name}: accepts valid input, rejects unknown fields`, () => {
      const valid = VALID_INPUTS[entry.name];
      expect(valid, `missing valid input sample for ${entry.name}`).toBeDefined();
      const parsed = entry.inputSchema.safeParse(valid);
      expect(parsed.success, JSON.stringify(parsed)).toBe(true);
      const withUnknown = entry.inputSchema.safeParse({ ...valid, unknownField: 1 });
      expect(withUnknown.success).toBe(false);
    });
  }

  it('applies documented defaults', () => {
    const sessionOpen = getToolEntry('browser_session_open')!.inputSchema.parse(VALID_INPUTS['browser_session_open']) as {
      profileName: string;
    };
    expect(sessionOpen.profileName).toBe('ebay-research');
    const navigate = getToolEntry('browser_navigate')!.inputSchema.parse(VALID_INPUTS['browser_navigate']) as {
      waitUntil: string;
    };
    expect(navigate.waitUntil).toBe('domcontentloaded');
    const snapshot = getToolEntry('browser_snapshot')!.inputSchema.parse(VALID_INPUTS['browser_snapshot']) as {
      maxNodes: number;
    };
    expect(snapshot.maxNodes).toBe(3000);
    const images = getToolEntry('browser_images')!.inputSchema.parse(VALID_INPUTS['browser_images']) as {
      scope: string;
    };
    expect(images.scope).toBe('gallery');
    const wait = getToolEntry('browser_wait')!.inputSchema.parse(VALID_INPUTS['browser_wait']) as { timeoutMs: number };
    expect(wait.timeoutMs).toBe(10000);
    const handoff = getToolEntry('browser_handoff')!.inputSchema.parse(VALID_INPUTS['browser_handoff']) as {
      timeoutSeconds: number;
    };
    expect(handoff.timeoutSeconds).toBe(300);
  });

  it('screenshot element mode requires elementRef (Appendix A allOf)', () => {
    const schema = getToolEntry('browser_screenshot')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, mode: 'element' }).success).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, mode: 'element', elementRef: 'el_1_0_a' }).success,
    ).toBe(true);
  });

  it('screenshot scale is optional and bounded to 0.1-1 (2026-09-01 operator request)', () => {
    const schema = getToolEntry('browser_screenshot')!.inputSchema;
    const base = { browserSessionHandle: HANDLE, tabId: TAB, mode: 'viewport' as const };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, scale: 0.5 }).success).toBe(true);
    expect(schema.safeParse({ ...base, scale: 1 }).success).toBe(true);
    expect(schema.safeParse({ ...base, scale: 0.1 }).success).toBe(true);
    // Below the floor a capture is unreadable noise; above 1 is an upscale
    // the bridge never fabricates.
    expect(schema.safeParse({ ...base, scale: 0.05 }).success).toBe(false);
    expect(schema.safeParse({ ...base, scale: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, scale: '0.5' }).success).toBe(false);
  });

  it('wait condition requires exactly one discriminator (Appendix A oneOf)', () => {
    const schema = getToolEntry('browser_wait')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: {} }).success).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: { text: 'a', urlPattern: 'b' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: { networkIdleMs: 500 } }).success,
    ).toBe(true);
  });

  it('browser_key accepts only the allowed navigation keys', () => {
    const schema = getToolEntry('browser_key')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, key: 'F12' }).success).toBe(false);
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, key: 'a' }).success).toBe(false);
  });

  it('browser_extract accepts only the versioned site profile', () => {
    const schema = getToolEntry('browser_extract')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'amazon.v1' }).success).toBe(false);
  });

  it('browser_extract stays byte-compatible: search is optional and additive', () => {
    const schema = getToolEntry('browser_extract')!.inputSchema;
    const base = { browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'ebay.ca.v1' };
    // The Phase 1 call shape parses to the Phase 1 value, with no search key.
    expect(schema.parse(base)).toEqual(base);
    expect(schema.safeParse({ ...base, search: { limit: 10, offset: 20 } }).success).toBe(true);
  });

  it('browser_extract_many bounds the batch and defaults to compact sequential auto', () => {
    const entry = getToolEntry('browser_extract_many')!;
    const parsed = entry.inputSchema.parse(VALID_INPUTS['browser_extract_many']) as {
      compact: boolean;
      concurrency: number;
      mode: string;
      waitUntil: string;
    };
    expect(parsed.compact).toBe(true);
    expect(parsed.concurrency).toBe(1);
    expect(parsed.mode).toBe('auto');
    expect(parsed.waitUntil).toBe('domcontentloaded');
    expect(EXTRACT_MANY_MAX_URLS).toBe(25);
    const tooMany = Array.from({ length: EXTRACT_MANY_MAX_URLS + 1 }, (_, i) => `https://www.ebay.ca/itm/2261234567${i}`);
    expect(
      entry.inputSchema.safeParse({ ...VALID_INPUTS['browser_extract_many'], urls: tooMany }).success,
    ).toBe(false);
    expect(entry.inputSchema.safeParse({ ...VALID_INPUTS['browser_extract_many'], urls: [] }).success).toBe(false);
    expect(
      entry.inputSchema.safeParse({ ...VALID_INPUTS['browser_extract_many'], concurrency: 9 }).success,
    ).toBe(false);
  });

  it('a search titleRegex that could backtrack exponentially is a validation error', () => {
    const schema = getToolEntry('browser_open_and_extract')!.inputSchema;
    const withRegex = (titleRegex: string): boolean =>
      schema.safeParse({
        ...VALID_INPUTS['browser_open_and_extract'],
        search: { include: { titleRegex } },
      }).success;
    // Ordinary filters compile.
    expect(withRegex('lego.*(bulk|lot)')).toBe(true);
    expect(withRegex('\\bminifig(ure)?s?\\b')).toBe(true);
    // Nested quantifiers, overlapping alternation, backreferences, absurd
    // repetition counts, and syntactically invalid patterns are all refused
    // at the schema boundary rather than on the device.
    expect(withRegex('(a+)+$')).toBe(false);
    expect(withRegex('(a|a)*b')).toBe(false);
    expect(withRegex('(lego)\\1')).toBe(false);
    expect(withRegex('a{500}')).toBe(false);
    expect(withRegex('lego(')).toBe(false);
    expect(withRegex('a'.repeat(SEARCH_TITLE_REGEX_MAX_LENGTH + 1))).toBe(false);
  });

  it('dashboard_upsert accepts listings, touch, or both — but not neither', () => {
    const schema = DashboardUpsertInput;
    // The Phase 1 call shape is untouched.
    expect(schema.safeParse({ dashboard: 'deals', listings: [{ id: 'ebay-1' }] }).success).toBe(true);
    expect(
      schema.safeParse({ dashboard: 'deals', touch: [{ id: 'ebay-1', lastSeen: '2026-08-29T12:00:00Z' }] }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        dashboard: 'deals',
        listings: [{ id: 'ebay-1' }],
        touch: [{ id: 'kijiji-2', lastSeen: '2026-08-29T12:00:00Z' }],
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ dashboard: 'deals' }).success).toBe(false);
    // A touch still has to say when it saw the record, in a parseable form.
    expect(schema.safeParse({ dashboard: 'deals', touch: [{ id: 'ebay-1', lastSeen: 'yesterday' }] }).success).toBe(
      false,
    );
  });

  it('dashboard_feed filter and fields are optional additions', () => {
    expect(DashboardFeedInput.parse({ dashboard: 'deals' })).toEqual({ dashboard: 'deals', mode: 'full' });
    expect(
      DashboardFeedInput.safeParse({
        dashboard: 'deals',
        mode: 'ids',
        filter: { active: true, status: ['active'], marketplace: 'ebay' },
        fields: ['title', 'priceCad'],
      }).success,
    ).toBe(true);
  });
});

describe('output schema contracts (Appendix A)', () => {
  it('validates representative structuredContent payloads', () => {
    const tab = { tabId: TAB, url: 'https://www.ebay.ca/', title: 'eBay', active: true, pageRevision: 0 };
    expect(TabSchema.parse(tab)).toBeTruthy();
    expect(
      getToolEntry('browser_session_open')!.outputSchema.safeParse({
        browserSessionHandle: HANDLE,
        deviceId: 'dev_1',
        profileName: 'ebay-research',
        status: 'ready',
        tabs: [tab],
      }).success,
    ).toBe(true);
    expect(
      SemanticNodeSchema.safeParse({
        elementRef: 'el_1_0_abc',
        role: 'button',
        name: 'Change shipping destination',
        text: 'Change',
        disabled: false,
        checked: null,
        valueRedacted: false,
      }).success,
    ).toBe(true);
    expect(
      ImageCandidateSchema.safeParse({
        imageId: 'img_0123456789',
        order: 0,
        thumbnailUrl: null,
        sourceUrl: 'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
        width: null,
        height: null,
        mimeType: null,
      }).success,
    ).toBe(true);
    expect(
      ArtifactDescriptorSchema.safeParse({
        artifactId: 'art_0123456789',
        mimeType: 'image/png',
        byteLength: 1024,
        delivery: 'mcp_inline',
        expiresAt: '2026-08-12T21:15:00Z',
      }).success,
    ).toBe(true);
    // additionalProperties: false on outputs
    expect(
      getToolEntry('browser_navigate')!.outputSchema.safeParse({
        finalUrl: 'https://www.ebay.ca/',
        title: 'eBay',
        origin: 'https://www.ebay.ca',
        pageRevision: 1,
        navigationStatus: 'committed',
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it('screenshot/image_get outputs embed the artifact descriptor', () => {
    const descriptor = {
      artifactId: 'art_0123456789',
      mimeType: 'image/png',
      byteLength: 10,
      delivery: 'signed_url',
      expiresAt: null,
    };
    expect(
      getToolEntry('browser_screenshot')!.outputSchema.safeParse({
        artifact: descriptor,
        pageRevision: 2,
        width: 1280,
        height: 720,
      }).success,
    ).toBe(true);
    expect(
      getToolEntry('browser_image_get')!.outputSchema.safeParse({
        artifact: descriptor,
        sourceUrl: 'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
        pageRevision: 2,
      }).success,
    ).toBe(true);
  });
});

describe('zod → JSON Schema derivation sanity', () => {
  it('strict objects emit additionalProperties: false', () => {
    const json = z.toJSONSchema(getToolEntry('browser_tabs')!.inputSchema as z.ZodType, { io: 'input' });
    expect((json as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});

describe('deals run checkpoint tools (Phase 4)', () => {
  it('are additive: the browser and dashboard catalogs are untouched', () => {
    expect(TOOL_CATALOG).toHaveLength(18);
    expect(DASHBOARD_TOOL_CATALOG.map((entry) => entry.name)).toEqual(['dashboard_feed', 'dashboard_upsert']);
    // The run tools live in their own catalog because they are neither
    // device commands nor dashboard records; getToolEntry, which drives the
    // agent wire, must not know them.
    expect(RUN_TOOL_CATALOG.map((entry) => entry.name)).toEqual(['deals_run_checkpoint', 'deals_run_resume']);
    expect(getToolEntry('deals_run_checkpoint')).toBeUndefined();
    expect(getRunToolEntry('deals_run_checkpoint')).toBeDefined();
  });

  it('reuse the dashboard scope machinery instead of inventing a scope', () => {
    // The tools are named deals.*, but authorisation is keyed on dashboard
    // id: each entry names its dashboard and maps its action onto the
    // existing DashboardToolAction.
    for (const entry of RUN_TOOL_CATALOG) {
      expect(entry.dashboard).toBe('deals');
    }
    expect(runToolDashboardAction('checkpoint')).toBe('upsert');
    expect(runToolDashboardAction('resume')).toBe('feed');

    // Writing a checkpoint authorises like a deals upsert...
    expect(dashboardScopeSatisfies(['deals:write'], 'deals', runToolDashboardAction('checkpoint'))).toBe(true);
    expect(dashboardScopeSatisfies(['dashboards:read'], 'deals', runToolDashboardAction('checkpoint'))).toBe(false);
    expect(dashboardScopeSatisfies(['vacation:write'], 'deals', runToolDashboardAction('checkpoint'))).toBe(false);
    // ...and reading one authorises like a feed read.
    expect(dashboardScopeSatisfies(['dashboards:read'], 'deals', runToolDashboardAction('resume'))).toBe(true);
    expect(dashboardScopeSatisfies(['deals:write'], 'deals', runToolDashboardAction('resume'))).toBe(true);
    expect(dashboardScopeSatisfies(['browser:interact'], 'deals', runToolDashboardAction('resume'))).toBe(false);
  });

  it('deals_run_checkpoint takes a runId and optional deltas, and rejects unknown fields', () => {
    const schema = getRunToolEntry('deals_run_checkpoint')!.inputSchema;
    expect(schema.safeParse({ runId: 'deals-2026-08-29' }).success).toBe(true);
    expect(
      schema.safeParse({
        runId: 'deals-2026-08-29',
        searched: ['ebay: lego bulk lot'],
        verifiedIds: ['ebay-226123456789'],
        pendingIds: ['kijiji-1740940278'],
        notes: 'stopped at page 3',
        status: 'completed',
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ runId: 'r', unknownField: 1 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it('status is optional, not defaulted — a default would reopen a finished run', () => {
    const parsed = getRunToolEntry('deals_run_checkpoint')!.inputSchema.parse({ runId: 'r' }) as {
      status?: string;
    };
    expect(parsed).toEqual({ runId: 'r' });
    expect(parsed.status).toBeUndefined();
    expect(getRunToolEntry('deals_run_checkpoint')!.inputSchema.safeParse({ runId: 'r', status: 'paused' }).success).toBe(
      false,
    );
  });

  it('a runId stays a flat identifier: no whitespace, newlines, or free text', () => {
    const schema = getRunToolEntry('deals_run_checkpoint')!.inputSchema;
    const accepts = (runId: string): boolean => schema.safeParse({ runId }).success;
    expect(accepts('deals-2026-08-29')).toBe(true);
    expect(accepts('deals.2026-08-29:track-a')).toBe(true);
    expect(accepts('run with spaces')).toBe(false);
    expect(accepts('run\nid')).toBe(false);
    expect(accepts('-leading-dash')).toBe(false);
    expect(accepts('')).toBe(false);
    expect(accepts('r'.repeat(RUN_ID_MAX_LENGTH + 1))).toBe(false);
  });

  it('bounds the payload at the schema so a checkpoint cannot become a blob', () => {
    const schema = getRunToolEntry('deals_run_checkpoint')!.inputSchema;
    const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `ebay-${i}`);
    expect(schema.safeParse({ runId: 'r', verifiedIds: ids(RUN_CHECKPOINT_MAX_IDS) }).success).toBe(true);
    expect(schema.safeParse({ runId: 'r', verifiedIds: ids(RUN_CHECKPOINT_MAX_IDS + 1) }).success).toBe(false);
    expect(schema.safeParse({ runId: 'r', pendingIds: ids(RUN_CHECKPOINT_MAX_IDS + 1) }).success).toBe(false);
    expect(
      schema.safeParse({ runId: 'r', searched: ids(RUN_CHECKPOINT_MAX_SEARCHED + 1).map(String) }).success,
    ).toBe(false);
    // notes is the one free-text channel, so it is the smallest field here.
    expect(schema.safeParse({ runId: 'r', notes: 'x'.repeat(RUN_CHECKPOINT_NOTES_MAX_CHARS) }).success).toBe(true);
    expect(schema.safeParse({ runId: 'r', notes: 'x'.repeat(RUN_CHECKPOINT_NOTES_MAX_CHARS + 1) }).success).toBe(false);
    expect(RUN_CHECKPOINT_NOTES_MAX_CHARS).toBeLessThan(RUN_CHECKPOINT_MAX_IDS * 10);
  });

  it('deals_run_resume takes an optional runId and nothing else', () => {
    const schema = getRunToolEntry('deals_run_resume')!.inputSchema;
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ runId: 'deals-2026-08-29' }).success).toBe(true);
    // The dashboard is fixed by the catalog entry; widening the tool past
    // its own name is not something a caller gets to do.
    expect(schema.safeParse({ dashboard: 'vacation' }).success).toBe(false);
  });

  it('resume output distinguishes found, resumable, and stale', () => {
    const schema = getRunToolEntry('deals_run_resume')!.outputSchema;
    const base = {
      found: true,
      resumable: true,
      runId: 'deals-2026-08-29',
      dashboard: 'deals',
      status: 'running',
      searched: ['ebay: lego bulk lot'],
      verifiedIds: ['ebay-226123456789'],
      pendingIds: [],
      notes: null,
      checkpointCount: 2,
      startedAt: '2026-08-29T09:00:00.000Z',
      updatedAt: '2026-08-29T09:20:00.000Z',
      expiresAt: '2026-08-29T21:20:00.000Z',
      ageSeconds: 120,
      warnings: [],
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, found: false, resumable: false, runId: null, status: null }).success).toBe(true);
    expect(schema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    // The TTL is a documented number, not an implementation detail.
    expect(RUN_CHECKPOINT_TTL_SECONDS).toBe(12 * 60 * 60);
  });
});

describe('source tool catalog (Countdown API, plan §3 and §6.3)', () => {
  const SEARCH_URL = 'https://www.ebay.ca/sch/i.html?_nkw=lego+lot&_sop=10&_ipg=240&LH_PrefLoc=2';
  const ITEM_URL = 'https://www.ebay.ca/itm/226123456789';
  const SELLER_URL = 'https://www.ebay.com/usr/brickseller';
  const searchSchema = () => getSourceToolEntry('ebay_api_search')!.inputSchema;

  it('exposes exactly the three ebay_api tools, all browser:read, outside the browser catalog', () => {
    expect(SOURCE_TOOL_CATALOG.map((entry) => entry.name)).toEqual([
      'ebay_api_search',
      'ebay_api_items',
      'ebay_api_seller',
    ]);
    for (const entry of SOURCE_TOOL_CATALOG) {
      expect(entry.scope, entry.name).toBe(SCOPE_READ);
      // Dot-free: the host permission layer rewrites anything else (2026-09-02 rename).
      expect(entry.name).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(entry.timeoutMs, entry.name).toBeGreaterThan(0);
      // Not a browser tool: getToolEntry drives the agent wire and must not know them.
      expect(getToolEntry(entry.name), entry.name).toBeUndefined();
      expect(getSourceToolEntry(entry.name)).toBe(entry);
    }
    expect(TOOL_CATALOG).toHaveLength(18);
    expect(getSourceToolEntry('browser_extract')).toBeUndefined();
  });

  it('ebay_api_search accepts a term or a url and applies the documented defaults', () => {
    const schema = searchSchema();
    expect(schema.parse({ searchTerm: 'lego bulk lot' })).toEqual({
      domain: 'ebay.ca',
      searchTerm: 'lego bulk lot',
      listingType: 'all',
      condition: 'all',
      num: 240,
      page: 1,
      maxPage: 1,
      destination: 'domain_default',
      allowRewrittenResults: false,
    });
    expect(schema.parse({ url: SEARCH_URL, destination: 'toronto', maxPage: 3 })).toMatchObject({
      url: SEARCH_URL,
      destination: 'toronto',
      maxPage: 3,
      domain: 'ebay.ca',
    });
    expect(
      schema.safeParse({
        domain: 'ebay.com',
        searchTerm: 'lego minifigure lot',
        sortBy: 'newly_listed',
        listingType: 'auction',
        condition: 'used',
        categoryId: '19006',
        num: 60,
        page: 2,
        maxPage: EBAY_API_MAX_PAGE,
        destination: 'forwarder',
        allowRewrittenResults: true,
        search: { limit: 10, include: { formats: ['auction'], minPrice: 20 } },
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ searchTerm: 'lego', unknownField: 1 }).success).toBe(false);
  });

  it('ebay_api_search: searchTerm and url are mutually exclusive and one is required', () => {
    const schema = searchSchema();
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', url: SEARCH_URL }).success).toBe(false);
    // Parameters the vendor ignores alongside a url are refused, not
    // silently dropped: the call must never claim a sort it did not apply.
    expect(schema.safeParse({ url: SEARCH_URL, sortBy: 'newly_listed' }).success).toBe(false);
    expect(schema.safeParse({ url: SEARCH_URL, listingType: 'auction' }).success).toBe(false);
    expect(schema.safeParse({ url: SEARCH_URL, condition: 'used' }).success).toBe(false);
    expect(schema.safeParse({ url: SEARCH_URL, categoryId: '19006' }).success).toBe(false);
    expect(schema.safeParse({ url: SEARCH_URL, page: 2 }).success).toBe(false);
    // Spelling out a default asks for nothing the url will fail to honour.
    expect(schema.safeParse({ url: SEARCH_URL, listingType: 'all', condition: 'all', page: 1 }).success).toBe(true);
    // num, maxPage, destination and search still apply to a url search.
    expect(
      schema.safeParse({ url: SEARCH_URL, num: 120, maxPage: 2, destination: 'forwarder', search: { limit: 5 } })
        .success,
    ).toBe(true);
  });

  it('ebay_api_search bounds num, page, maxPage and the term at the schema', () => {
    const schema = searchSchema();
    expect(EBAY_API_MAX_PAGE).toBe(5);
    expect(schema.safeParse({ searchTerm: 'lego', maxPage: EBAY_API_MAX_PAGE }).success).toBe(true);
    expect(schema.safeParse({ searchTerm: 'lego', maxPage: EBAY_API_MAX_PAGE + 1 }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', maxPage: 0 }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', num: 100 }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', num: '240' }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', page: 0 }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', categoryId: 'toys' }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: '' }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: '   ' }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'x'.repeat(201) }).success).toBe(false);
    expect(schema.safeParse({ searchTerm: 'lego', destination: 'M6H 2W9' }).success).toBe(false);
  });

  it('ebay_api_search refuses every url the §2 policy refuses', () => {
    const schema = searchSchema();
    const accepts = (url: string): boolean => schema.safeParse({ url }).success;
    expect(accepts(SEARCH_URL)).toBe(true);
    expect(accepts('https://ebay.com/sch/i.html?_nkw=lego')).toBe(true);
    expect(accepts('https://www.example.com/sch/i.html?_nkw=lego')).toBe(false); // non-eBay host
    expect(accepts('http://www.ebay.ca/sch/i.html?_nkw=lego')).toBe(false); // not https
    expect(accepts('https://user:pw@www.ebay.ca/sch/i.html?_nkw=lego')).toBe(false); // userinfo
    expect(accepts('https://www.ebay.ca:8443/sch/i.html?_nkw=lego')).toBe(false); // explicit port
    expect(accepts(ITEM_URL)).toBe(false); // an item page is not a search
    expect(accepts('https://www.ebay.ca.attacker.io/sch/i.html')).toBe(false);
    expect(accepts('https://i.ebayimg.com/sch/i.html')).toBe(false);
    expect(accepts('https://10.0.0.5/sch/i.html')).toBe(false);
  });

  it('ebay_api_items takes ids or urls, applies defaults, and bounds the batch', () => {
    const schema = getSourceToolEntry('ebay_api_items')!.inputSchema;
    expect(schema.parse({ items: [{ itemId: '226123456789' }] })).toEqual({
      items: [{ itemId: '226123456789' }],
      domain: 'ebay.ca',
      destination: 'domain_default',
      compact: true,
    });
    expect(
      schema.safeParse({
        items: [
          { url: ITEM_URL, expectedFormat: 'auction' },
          { itemId: '1234567890', expectedFormat: 'fixed_price' },
          { itemId: '12345678901234', expectedFormat: 'auction_with_bin' },
        ],
        domain: 'ebay.com',
        destination: 'forwarder',
        compact: false,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ items: [{ itemId: '226123456789' }], unknownField: 1 }).success).toBe(false);
    expect(schema.safeParse({ items: [{ itemId: '226123456789', extra: 1 }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ itemId: '226123456789', url: ITEM_URL }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ expectedFormat: 'auction' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ itemId: 226123456789 }] }).success).toBe(false); // a string, always
    expect(schema.safeParse({ items: [{ itemId: '123456789' }] }).success).toBe(false); // 9 digits
    expect(schema.safeParse({ items: [{ itemId: '123456789012345' }] }).success).toBe(false); // 15 digits
    expect(schema.safeParse({ items: [{ itemId: '226123456789', expectedFormat: 'unknown' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ url: SEARCH_URL }] }).success).toBe(false); // a search is not an item
    expect(schema.safeParse({ items: [{ url: 'http://www.ebay.ca/itm/226123456789' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [{ url: 'https://www.example.com/itm/226123456789' }] }).success).toBe(false);
    expect(schema.safeParse({ items: [] }).success).toBe(false);
    expect(EBAY_API_ITEMS_MAX).toBe(25);
    expect(EBAY_API_ITEMS_MAX).toBe(EXTRACT_MANY_MAX_URLS);
    const many = (count: number) => Array.from({ length: count }, (_, i) => ({ itemId: String(226000000000 + i) }));
    expect(schema.safeParse({ items: many(EBAY_API_ITEMS_MAX) }).success).toBe(true);
    expect(schema.safeParse({ items: many(EBAY_API_ITEMS_MAX + 1) }).success).toBe(false);
  });

  it('ebay_api_items output is ExtractManyOutput plus source, credits and requestIds', () => {
    const slot = {
      url: ITEM_URL,
      finalUrl: ITEM_URL,
      ok: true,
      siteProfile: 'ebay.api.v1',
      pageRevision: 0,
      record: { itemId: '226123456789' },
      warnings: ['DESTINATION_UNVERIFIED: item-page shipping from this source is never resolved to a postal code'],
      error: null,
    };
    const output = {
      mode: 'inline',
      jobId: null,
      status: 'completed',
      requested: 1,
      completed: 1,
      succeeded: 1,
      failed: 0,
      compact: true,
      resultsFrom: 0,
      results: [slot],
      warnings: [],
      source: 'countdown',
      credits: { used: 16, remaining: 9_998, usedThisRequest: 1 },
      requestIds: ['req_1'],
    };
    expect(EbayApiItemsOutput.safeParse(output).success).toBe(true);
    expect(getSourceToolEntry('ebay_api_items')!.outputSchema.safeParse(output).success).toBe(true);
    // The contract the integration test relies on: strip the three source
    // fields and what is left is a Bridge batch result, byte for byte.
    const { source: _source, credits: _credits, requestIds: _requestIds, ...bridgeShaped } = output;
    expect(ExtractManyOutput.safeParse(bridgeShaped).success).toBe(true);
    expect(ExtractManyOutput.safeParse(output).success).toBe(false);
    expect(EbayApiItemsOutput.safeParse(bridgeShaped).success).toBe(false);
    expect(EbayApiItemsOutput.safeParse({ ...output, credits: { used: 1 } }).success).toBe(false);
    // usedThisRequest is the only per-call figure (the vendor's used is the
    // account's month-to-date total), so it is required, a whole number,
    // never negative, and null only when the vendor omitted it throughout.
    expect(EbayApiItemsOutput.safeParse({ ...output, credits: { used: 16, remaining: 9_998 } }).success).toBe(false);
    expect(EbayApiItemsOutput.safeParse({ ...output, credits: { used: 16, remaining: 9_998, usedThisRequest: -1 } }).success).toBe(false);
    expect(EbayApiItemsOutput.safeParse({ ...output, credits: { used: 16, remaining: 9_998, usedThisRequest: 1.5 } }).success).toBe(false);
    expect(EbayApiItemsOutput.safeParse({ ...output, credits: { used: null, remaining: null, usedThisRequest: null } }).success).toBe(true);
  });

  it('ebay_api_seller takes a loginId or a /usr/ or /str/ url, never both', () => {
    const schema = getSourceToolEntry('ebay_api_seller')!.inputSchema;
    expect(schema.parse({ loginId: 'brick-seller_1' })).toEqual({ loginId: 'brick-seller_1', domain: 'ebay.ca' });
    expect(schema.parse({ url: SELLER_URL })).toEqual({ url: SELLER_URL, domain: 'ebay.ca' });
    expect(schema.safeParse({ url: 'https://www.ebay.ca/str/jeremydoherty', domain: 'ebay.com' }).success).toBe(true);
    expect(schema.safeParse({ loginId: 'tweedsidesales', domain: 'ebay.com' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ loginId: 'brickseller', url: SELLER_URL }).success).toBe(false);
    expect(schema.safeParse({ loginId: 'brickseller', unknownField: 1 }).success).toBe(false);
    expect(schema.safeParse({ loginId: '' }).success).toBe(false);
    expect(schema.safeParse({ loginId: 'has space' }).success).toBe(false);
    expect(schema.safeParse({ loginId: '-leading' }).success).toBe(false);
    expect(schema.safeParse({ loginId: 'a'.repeat(65) }).success).toBe(false);
    expect(schema.safeParse({ url: ITEM_URL }).success).toBe(false); // an item page is not a profile
    expect(schema.safeParse({ url: 'http://www.ebay.ca/usr/brickseller' }).success).toBe(false);
    expect(schema.safeParse({ url: 'https://www.notebay.com/usr/brickseller' }).success).toBe(false);
  });

  it('ebay_api_seller output distinguishes resolved from not', () => {
    const schema = getSourceToolEntry('ebay_api_seller')!.outputSchema;
    const resolved = {
      resolved: true,
      seller: {
        name: 'Brick Seller',
        profileUrl: SELLER_URL,
        loginId: 'brickseller',
        storeSlug: null,
        memberSince: null,
        positivePercent: 99.8,
        followers: '1.2K',
        location: null,
        topRated: null,
        description: null,
      },
      warnings: [],
      credits: { used: 16, remaining: null, usedThisRequest: 1 },
      requestIds: ['req_1'],
    };
    expect(schema.safeParse(resolved).success).toBe(true);
    expect(
      schema.safeParse({ ...resolved, resolved: false, seller: null, warnings: ['vendor: Seller not found.'] }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...resolved, extra: 1 }).success).toBe(false);
    expect(
      schema.safeParse({ ...resolved, seller: { ...resolved.seller, description: 'x'.repeat(500) } }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ ...resolved, seller: { ...resolved.seller, description: 'x'.repeat(501) } }).success,
    ).toBe(false);
  });

  it('ebay_api_search output carries the compacted search shape plus source fields', () => {
    const schema = getSourceToolEntry('ebay_api_search')!.outputSchema;
    const output = {
      source: 'countdown',
      siteProfile: 'ebay.api.v1',
      pageKind: 'search',
      pageUrl: SEARCH_URL,
      domain: 'ebay.ca',
      destination: 'toronto',
      retrievedUnder: ['buy_it_now', 'auction'],
      totalResults: 1234,
      candidateCount: 240,
      pagesFetched: 1,
      hasNextPage: true,
      candidates: [{ itemId: '226123456789', url: ITEM_URL, title: 'LEGO lot', sellingFormat: 'fixed_price', bidCount: null }],
      offset: 0,
      hasMore: true,
      nextOffset: 40,
      warnings: ['BID_COUNT_UNAVAILABLE_FROM_SOURCE: search rows carry no bid count or time left; bids and end times come only from the Bridge item page'],
      credits: { used: 17, remaining: 9_998, usedThisRequest: 2 },
      requestIds: ['req_1', 'req_2'],
    };
    expect(schema.safeParse(output).success).toBe(true);
    expect(
      schema.safeParse({ ...output, totalResults: null, hasNextPage: null, nextOffset: null, hasMore: false }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...output, source: 'bridge' }).success).toBe(false);
    expect(schema.safeParse({ ...output, retrievedUnder: ['all'] }).success).toBe(false);
    expect(schema.safeParse({ ...output, extra: 1 }).success).toBe(false);
  });

  it('every source tool advertises a root object schema with additionalProperties: false', () => {
    // The reason the seller input is a strict object with an exactly-one
    // check rather than a root-level union: the MCP tool schema must be an
    // object with properties, like every other tool on this server.
    for (const entry of SOURCE_TOOL_CATALOG) {
      const json = z.toJSONSchema(entry.inputSchema as z.ZodType, { io: 'input' }) as {
        type?: string;
        additionalProperties?: boolean;
        properties?: Record<string, unknown>;
      };
      expect(json.type, entry.name).toBe('object');
      expect(json.additionalProperties, entry.name).toBe(false);
      expect(Object.keys(json.properties ?? {}).length, entry.name).toBeGreaterThan(0);
    }
  });

  it('descriptions state the cost and the caveats in plain words', () => {
    const byName = new Map(SOURCE_TOOL_CATALOG.map((entry) => [entry.name, entry.description]));
    for (const [name, description] of byName) {
      expect(description, name).toMatch(/credit/);
      // The 2026-09-02 live check: three parallel one-credit calls all
      // reported used 15, and no response carried a request id.
      expect(description, name).toMatch(/what this call spent is credits\.usedThisRequest/i);
      expect(description, name).toMatch(/credits\.used is the account's month-to-date total/);
      expect(description, name).toMatch(/credits\.remaining is the balance to put in the completion report/);
      expect(description, name).toMatch(/requestIds is empty when the vendor omits request ids, which it did on every observed response/);
      expect(description, name).not.toMatch(/credits\.used reports/);
    }
    expect(byName.get('ebay_api_search')).toMatch(/two vendor requests/);
    expect(byName.get('ebay_api_search')).toMatch(/Bridge item page/);
    expect(byName.get('ebay_api_seller')).toMatch(/SELLER_FIELDS_ABSENT_FROM_SOURCE/);
    expect(byName.get('ebay_api_search')).toMatch(/only from the Bridge/);
    expect(byName.get('ebay_api_items')).toMatch(/never resolved to a postal code/);
    expect(byName.get('ebay_api_items')).toMatch(/not a Canadian figure/);
    expect(byName.get('ebay_api_items')).toMatch(/auction prices come only from the Bridge/);
  });
});
