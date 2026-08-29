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
  EXTRACT_MANY_MAX_URLS,
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
  'browser.session_open': { deviceId: 'dev_1' },
  'browser.tabs': { browserSessionHandle: HANDLE },
  'browser.navigate': { browserSessionHandle: HANDLE, tabId: TAB, url: 'https://www.ebay.ca/itm/1' },
  'browser.snapshot': { browserSessionHandle: HANDLE, tabId: TAB },
  'browser.screenshot': { browserSessionHandle: HANDLE, tabId: TAB, mode: 'viewport' },
  'browser.images': { browserSessionHandle: HANDLE, tabId: TAB },
  'browser.image_get': { browserSessionHandle: HANDLE, tabId: TAB, imageId: 'img_0123456789' },
  'browser.click': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc' },
  'browser.fill': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc', value: 'M6H 2W9' },
  'browser.select': { browserSessionHandle: HANDLE, tabId: TAB, elementRef: 'el_1_0_abc', value: 'Friends heavy' },
  'browser.scroll': { browserSessionHandle: HANDLE, tabId: TAB, deltaY: 500 },
  'browser.key': { browserSessionHandle: HANDLE, tabId: TAB, key: 'Enter' },
  'browser.wait': { browserSessionHandle: HANDLE, tabId: TAB, condition: { text: 'M6H 2W9' } },
  'browser.extract': { browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'ebay.ca.v1' },
  'browser.open_and_extract': {
    browserSessionHandle: HANDLE,
    tabId: TAB,
    url: 'https://www.ebay.ca/sch/i.html?_nkw=lego+lot',
    siteProfile: 'ebay.ca.v1',
  },
  'browser.extract_many': {
    browserSessionHandle: HANDLE,
    tabId: TAB,
    urls: ['https://www.ebay.ca/itm/226123456789'],
    siteProfile: 'ebay.ca.v1',
  },
  'browser.job_status': { browserSessionHandle: HANDLE, jobId: 'job_01JABCDEF' },
  'browser.handoff': { browserSessionHandle: HANDLE, tabId: TAB, message: 'Please solve the challenge' },
};

describe('tool catalog completeness (§15)', () => {
  it('exposes exactly the 18 normative tools with scopes and policy classes', () => {
    expect(TOOL_CATALOG).toHaveLength(18);
    const expectations: Array<[string, string, string]> = [
      ['browser.session_open', SCOPE_INTERACT, 'reversible'],
      ['browser.tabs', SCOPE_READ, 'read'],
      ['browser.navigate', SCOPE_INTERACT, 'reversible'],
      ['browser.snapshot', SCOPE_READ, 'read'],
      ['browser.screenshot', SCOPE_READ, 'read'],
      ['browser.images', SCOPE_READ, 'read'],
      ['browser.image_get', SCOPE_READ, 'read'],
      ['browser.click', SCOPE_INTERACT, 'reversible'],
      ['browser.fill', SCOPE_INTERACT, 'reversible'],
      ['browser.select', SCOPE_INTERACT, 'reversible'],
      ['browser.scroll', SCOPE_INTERACT, 'reversible'],
      ['browser.key', SCOPE_INTERACT, 'reversible'],
      ['browser.wait', SCOPE_READ, 'read'],
      ['browser.extract', SCOPE_READ, 'read'],
      // The batch traversal tools navigate, so they carry browser.navigate's
      // scope and policy class rather than browser.extract's. Reading them as
      // browser:read would let a read-only token drive the browser.
      ['browser.open_and_extract', SCOPE_INTERACT, 'reversible'],
      ['browser.extract_many', SCOPE_INTERACT, 'reversible'],
      ['browser.job_status', SCOPE_READ, 'read'],
      ['browser.handoff', SCOPE_INTERACT, 'control'],
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
    const sessionOpen = getToolEntry('browser.session_open')!.inputSchema.parse(VALID_INPUTS['browser.session_open']) as {
      profileName: string;
    };
    expect(sessionOpen.profileName).toBe('ebay-research');
    const navigate = getToolEntry('browser.navigate')!.inputSchema.parse(VALID_INPUTS['browser.navigate']) as {
      waitUntil: string;
    };
    expect(navigate.waitUntil).toBe('domcontentloaded');
    const snapshot = getToolEntry('browser.snapshot')!.inputSchema.parse(VALID_INPUTS['browser.snapshot']) as {
      maxNodes: number;
    };
    expect(snapshot.maxNodes).toBe(3000);
    const images = getToolEntry('browser.images')!.inputSchema.parse(VALID_INPUTS['browser.images']) as {
      scope: string;
    };
    expect(images.scope).toBe('gallery');
    const wait = getToolEntry('browser.wait')!.inputSchema.parse(VALID_INPUTS['browser.wait']) as { timeoutMs: number };
    expect(wait.timeoutMs).toBe(10000);
    const handoff = getToolEntry('browser.handoff')!.inputSchema.parse(VALID_INPUTS['browser.handoff']) as {
      timeoutSeconds: number;
    };
    expect(handoff.timeoutSeconds).toBe(300);
  });

  it('screenshot element mode requires elementRef (Appendix A allOf)', () => {
    const schema = getToolEntry('browser.screenshot')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, mode: 'element' }).success).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, mode: 'element', elementRef: 'el_1_0_a' }).success,
    ).toBe(true);
  });

  it('wait condition requires exactly one discriminator (Appendix A oneOf)', () => {
    const schema = getToolEntry('browser.wait')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: {} }).success).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: { text: 'a', urlPattern: 'b' } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, condition: { networkIdleMs: 500 } }).success,
    ).toBe(true);
  });

  it('browser.key accepts only the allowed navigation keys', () => {
    const schema = getToolEntry('browser.key')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, key: 'F12' }).success).toBe(false);
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, key: 'a' }).success).toBe(false);
  });

  it('browser.extract accepts only the versioned site profile', () => {
    const schema = getToolEntry('browser.extract')!.inputSchema;
    expect(schema.safeParse({ browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'amazon.v1' }).success).toBe(false);
  });

  it('browser.extract stays byte-compatible: search is optional and additive', () => {
    const schema = getToolEntry('browser.extract')!.inputSchema;
    const base = { browserSessionHandle: HANDLE, tabId: TAB, siteProfile: 'ebay.ca.v1' };
    // The Phase 1 call shape parses to the Phase 1 value, with no search key.
    expect(schema.parse(base)).toEqual(base);
    expect(schema.safeParse({ ...base, search: { limit: 10, offset: 20 } }).success).toBe(true);
  });

  it('browser.extract_many bounds the batch and defaults to compact sequential auto', () => {
    const entry = getToolEntry('browser.extract_many')!;
    const parsed = entry.inputSchema.parse(VALID_INPUTS['browser.extract_many']) as {
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
      entry.inputSchema.safeParse({ ...VALID_INPUTS['browser.extract_many'], urls: tooMany }).success,
    ).toBe(false);
    expect(entry.inputSchema.safeParse({ ...VALID_INPUTS['browser.extract_many'], urls: [] }).success).toBe(false);
    expect(
      entry.inputSchema.safeParse({ ...VALID_INPUTS['browser.extract_many'], concurrency: 9 }).success,
    ).toBe(false);
  });

  it('a search titleRegex that could backtrack exponentially is a validation error', () => {
    const schema = getToolEntry('browser.open_and_extract')!.inputSchema;
    const withRegex = (titleRegex: string): boolean =>
      schema.safeParse({
        ...VALID_INPUTS['browser.open_and_extract'],
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

  it('dashboard.upsert accepts listings, touch, or both — but not neither', () => {
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

  it('dashboard.feed filter and fields are optional additions', () => {
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
      getToolEntry('browser.session_open')!.outputSchema.safeParse({
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
      getToolEntry('browser.navigate')!.outputSchema.safeParse({
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
      getToolEntry('browser.screenshot')!.outputSchema.safeParse({
        artifact: descriptor,
        pageRevision: 2,
        width: 1280,
        height: 720,
      }).success,
    ).toBe(true);
    expect(
      getToolEntry('browser.image_get')!.outputSchema.safeParse({
        artifact: descriptor,
        sourceUrl: 'https://i.ebayimg.com/images/g/x/s-l1600.jpg',
        pageRevision: 2,
      }).success,
    ).toBe(true);
  });
});

describe('zod → JSON Schema derivation sanity', () => {
  it('strict objects emit additionalProperties: false', () => {
    const json = z.toJSONSchema(getToolEntry('browser.tabs')!.inputSchema as z.ZodType, { io: 'input' });
    expect((json as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});

describe('deals run checkpoint tools (Phase 4)', () => {
  it('are additive: the browser and dashboard catalogs are untouched', () => {
    expect(TOOL_CATALOG).toHaveLength(18);
    expect(DASHBOARD_TOOL_CATALOG.map((entry) => entry.name)).toEqual(['dashboard.feed', 'dashboard.upsert']);
    // The run tools live in their own catalog because they are neither
    // device commands nor dashboard records; getToolEntry, which drives the
    // agent wire, must not know them.
    expect(RUN_TOOL_CATALOG.map((entry) => entry.name)).toEqual(['deals.run_checkpoint', 'deals.run_resume']);
    expect(getToolEntry('deals.run_checkpoint')).toBeUndefined();
    expect(getRunToolEntry('deals.run_checkpoint')).toBeDefined();
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

  it('deals.run_checkpoint takes a runId and optional deltas, and rejects unknown fields', () => {
    const schema = getRunToolEntry('deals.run_checkpoint')!.inputSchema;
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
    const parsed = getRunToolEntry('deals.run_checkpoint')!.inputSchema.parse({ runId: 'r' }) as {
      status?: string;
    };
    expect(parsed).toEqual({ runId: 'r' });
    expect(parsed.status).toBeUndefined();
    expect(getRunToolEntry('deals.run_checkpoint')!.inputSchema.safeParse({ runId: 'r', status: 'paused' }).success).toBe(
      false,
    );
  });

  it('a runId stays a flat identifier: no whitespace, newlines, or free text', () => {
    const schema = getRunToolEntry('deals.run_checkpoint')!.inputSchema;
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
    const schema = getRunToolEntry('deals.run_checkpoint')!.inputSchema;
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

  it('deals.run_resume takes an optional runId and nothing else', () => {
    const schema = getRunToolEntry('deals.run_resume')!.inputSchema;
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ runId: 'deals-2026-08-29' }).success).toBe(true);
    // The dashboard is fixed by the catalog entry; widening the tool past
    // its own name is not something a caller gets to do.
    expect(schema.safeParse({ dashboard: 'vacation' }).success).toBe(false);
  });

  it('resume output distinguishes found, resumable, and stale', () => {
    const schema = getRunToolEntry('deals.run_resume')!.outputSchema;
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
