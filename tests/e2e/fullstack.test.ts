/**
 * End-to-end (§27, Appendix D "Demonstration"): an MCP client retrieves a
 * snapshot, screenshot, gallery images, and a structured extraction from
 * a live browser through the full gateway → WSS → agent → Playwright
 * stack — with the local test browser and fixture site standing in for
 * the on-site branded Chrome + eBay.ca (which require the Windows PC).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestLaunchPlan } from '@browser-bridge/browser-core';
import { createPagePolicy, SessionManager } from '@browser-bridge/windows-agent';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { connectAgent, registerTestDevice, type ConnectedAgent } from '../helpers/agentHarness.js';
import { resolveTestExecutablePath } from '../helpers/browserHarness.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixtureServer.js';
import { makeFixtureProfile } from '../helpers/testProfile.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

let fixtures: FixtureServer;
let harness: GatewayHarness;
let agent: ConnectedAgent;
let sessions: SessionManager;
let client: ModernMcpClient;
let deviceId: string;
let handle: string;
let tabId: string;

beforeAll(async () => {
  fixtures = await startFixtureServer();
  harness = buildGatewayHarness();
  const urls = await harness.listen();
  const device = await registerTestDevice(harness, 'e2e-device');
  deviceId = device.identity.deviceId!;

  const logger = pino({ level: 'silent' });
  sessions = new SessionManager({
    profileDir: mkdtempSync(join(tmpdir(), 'bridge-e2e-profile-')),
    policy: createPagePolicy(makeFixtureProfile()),
    logger,
    planOverride: buildTestLaunchPlan(mkdtempSync(join(tmpdir(), 'bridge-e2e-userdata-')), resolveTestExecutablePath()),
  });
  agent = connectAgent(urls, device.identity, sessions, { expectedPostalCode: 'M6H 2W9' });
  agent.connection.start();
  await agent.waitReady();
  client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
}, 120_000);

afterAll(async () => {
  await agent?.stop();
  await sessions?.close();
  await harness?.close();
  await fixtures?.close();
});

function structuredOf(response: { body: { result?: { structuredContent?: Record<string, unknown> } } }): Record<string, unknown> {
  return response.body.result?.structuredContent ?? {};
}

describe('full stack: MCP client → gateway → agent → real browser', () => {
  it('opens a real browser session', async () => {
    const response = await client.callTool('browser.session_open', { deviceId });
    expect(response.body.result?.isError).not.toBe(true);
    const structured = structuredOf(response) as { browserSessionHandle: string; tabs: Array<{ tabId: string }>; status: string };
    handle = structured.browserSessionHandle;
    tabId = structured.tabs[0]!.tabId;
    expect(handle).toMatch(/^bs_/);
    expect(structured.status).toBe('ready');
  }, 60_000);

  it('navigates the fixture listing and snapshots semantic state', async () => {
    const navigation = await client.callTool('browser.navigate', {
      browserSessionHandle: handle,
      tabId,
      url: `${fixtures.baseUrl}/itm/123456789012`,
      waitUntil: 'load',
    });
    expect(structuredOf(navigation)).toMatchObject({ navigationStatus: 'committed' });

    const snapshot = await client.callTool('browser.snapshot', { browserSessionHandle: handle, tabId });
    const structured = structuredOf(snapshot) as { snapshot: Array<{ name: string }>; pageRevision: number };
    expect(structured.snapshot.some((node) => node.name.includes('LEGO Friends Bulk Lot'))).toBe(true);
  }, 60_000);

  it('returns a PNG screenshot as inline MCP image content with descriptor', async () => {
    const response = await client.callTool('browser.screenshot', {
      browserSessionHandle: handle,
      tabId,
      mode: 'viewport',
    });
    const image = response.body.result?.content?.find((entry) => entry.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const bytes = Buffer.from(image?.data ?? '', 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const structured = structuredOf(response) as { artifact: { delivery: string; mimeType: string } };
    expect(structured.artifact.delivery).toBe('mcp_inline');
  }, 60_000);

  it('enumerates the gallery and fetches an image end to end', async () => {
    const images = await client.callTool('browser.images', { browserSessionHandle: handle, tabId, scope: 'gallery' });
    const structured = structuredOf(images) as { images: Array<{ imageId: string; order: number }> };
    expect(structured.images.length).toBeGreaterThanOrEqual(3);
    const first = structured.images[0]!;
    const fetched = await client.callTool('browser.image_get', {
      browserSessionHandle: handle,
      tabId,
      imageId: first.imageId,
    });
    const artifact = (structuredOf(fetched) as { artifact: { mimeType: string; byteLength: number } }).artifact;
    expect(artifact.mimeType).toBe('image/png');
    expect(artifact.byteLength).toBeGreaterThan(100);
  }, 60_000);

  it('extracts the structured listing record with warnings', async () => {
    const response = await client.callTool('browser.extract', {
      browserSessionHandle: handle,
      tabId,
      siteProfile: 'ebay.ca.v1',
    });
    const structured = structuredOf(response) as {
      siteProfile: string;
      record: { itemId: { value: string }; itemPrice: { value: number }; listingStatus: string };
      warnings: string[];
    };
    expect(structured.siteProfile).toBe('ebay.ca.v1');
    expect(structured.record.itemId.value).toBe('123456789012');
    expect(structured.record.itemPrice.value).toBe(35);
    expect(structured.record.listingStatus).toBe('active');
  }, 60_000);

  it('waits, clicks, and keeps revisions consistent through the wire', async () => {
    const wait = await client.callTool('browser.wait', {
      browserSessionHandle: handle,
      tabId,
      condition: { text: 'LEGO Friends' },
      timeoutMs: 5000,
    });
    expect(structuredOf(wait)).toMatchObject({ satisfied: true });

    const snapshot = await client.callTool('browser.snapshot', { browserSessionHandle: handle, tabId });
    const nodes = (structuredOf(snapshot) as { snapshot: Array<{ name: string; elementRef: string | null }> }).snapshot;
    const buyNow = nodes.find((node) => node.name === 'Buy It Now');
    expect(buyNow?.elementRef).toBeTruthy();
    const blocked = await client.callTool('browser.click', {
      browserSessionHandle: handle,
      tabId,
      elementRef: buyNow!.elementRef!,
    });
    expect(blocked.body.result?.isError).toBe(true);
    const parsed = JSON.parse(blocked.body.result?.content?.[0]?.text ?? '{}') as { error: { code: string } };
    expect(parsed.error.code).toBe('ACTION_BLOCKED');
  }, 60_000);
});
