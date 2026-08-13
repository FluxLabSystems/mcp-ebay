/**
 * Contract layer (§27.1): every MCP tool schema in Appendix A — valid
 * inputs accepted with defaults applied, unknown fields rejected, and
 * conditional rules enforced.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  ArtifactDescriptorSchema,
  ImageCandidateSchema,
  SemanticNodeSchema,
  TabSchema,
  TOOL_CATALOG,
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
  'browser.handoff': { browserSessionHandle: HANDLE, tabId: TAB, message: 'Please solve the challenge' },
};

describe('tool catalog completeness (§15)', () => {
  it('exposes exactly the 15 normative tools with scopes and policy classes', () => {
    expect(TOOL_CATALOG).toHaveLength(15);
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
