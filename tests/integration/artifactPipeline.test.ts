/**
 * Large-artifact delivery happy paths (audit F-07) and wire-level
 * destination threading (F-09), exercised through the real gateway,
 * WSS link, and agent connection with an injected executor.
 *
 * Paths covered:
 *   ≤1 MiB   → inline on the wire → MCP inline image
 *   1–8 MiB  → agent PUT upload  → re-inlined as MCP image content
 *   >8 MiB   → agent PUT upload  → short-TTL signed HTTPS URL
 *   svg      → refused end to end (F-06)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newArtifactId,
  PENDING_SESSION_HANDLE,
  type CommandEnvelope,
} from '@browser-bridge/protocol';
import type { ExecutionOutcome, ExecutorHost } from '@browser-bridge/windows-agent';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { connectAgent, registerTestDevice, stubSessionHost, type ConnectedAgent } from '../helpers/agentHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const HANDLE = 'bs_pipe_session_000000000001';
const TAB = 'tab_PIPE0000000000000000000001';

/** PNG magic + deterministic filler so sniffing sees image/png. */
function pngBuffer(totalBytes: number): Buffer {
  const buffer = Buffer.alloc(totalBytes, 0x41);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  return buffer;
}

let harness: GatewayHarness;
let urls: { httpUrl: string; wsUrl: string };
let agent: ConnectedAgent;
let client: ModernMcpClient;
let deviceId: string;
const capturedEnvelopes: CommandEnvelope[] = [];
let nextScreenshot: { bytes: Buffer; mimeType: string } = { bytes: pngBuffer(64), mimeType: 'image/png' };

/**
 * Injected executor: session_open/extract/screenshot respond with valid
 * shapes without a browser; screenshot returns whatever `nextScreenshot`
 * holds so tests steer artifact size and MIME.
 */
async function fakeExecute(_host: ExecutorHost, envelope: CommandEnvelope): Promise<ExecutionOutcome> {
  capturedEnvelopes.push(envelope);
  switch (envelope.command) {
    case 'session_open':
      return {
        result: {
          browserSessionHandle: HANDLE,
          deviceId: envelope.deviceId,
          profileName: 'ebay-research',
          status: 'ready',
          tabs: [{ tabId: TAB, url: 'about:blank', title: 'stub', active: true, pageRevision: 0 }],
        },
        pageRevision: null,
        artifacts: [],
      };
    case 'screenshot': {
      const artifactId = newArtifactId();
      return {
        result: { artifactId, width: 640, height: 400, pageRevision: 1 },
        pageRevision: 1,
        artifacts: [{ artifactId, mimeType: nextScreenshot.mimeType, buffer: nextScreenshot.bytes }],
      };
    }
    case 'extract':
      return {
        result: {
          siteProfile: 'ebay.ca.v1',
          pageRevision: 1,
          record: { echoDestination: envelope.arguments.destinationPostalCode ?? null },
          warnings: [],
        },
        pageRevision: 1,
        artifacts: [],
      };
    default:
      throw new Error(`fake executor does not implement ${envelope.command}`);
  }
}

beforeAll(async () => {
  harness = buildGatewayHarness({ env: { EBAY_DESTINATION_POSTAL_CODE: 'M6H 2W9' } });
  urls = await harness.listen();
  const device = await registerTestDevice(harness, 'pipeline-device');
  deviceId = device.identity.deviceId!;
  agent = connectAgent(urls, device.identity, stubSessionHost(HANDLE), { executeCommandImpl: fakeExecute });
  agent.connection.start();
  await agent.waitReady();
  client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
  const open = await client.callTool('browser_session_open', { deviceId });
  expect(open.body.result?.isError).not.toBe(true);
});

afterAll(async () => {
  await agent?.stop();
  await harness?.close();
});

describe('artifact delivery branches (§16, F-07)', () => {
  it('≤1 MiB artifacts travel inline on the wire and arrive as MCP image content', async () => {
    nextScreenshot = { bytes: pngBuffer(64 * 1024), mimeType: 'image/png' };
    const response = await client.callTool('browser_screenshot', {
      browserSessionHandle: HANDLE,
      tabId: TAB,
      mode: 'viewport',
    });
    const image = response.body.result?.content?.find((entry) => entry.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    const artifact = (response.body.result?.structuredContent as { artifact: { delivery: string; byteLength: number } })
      .artifact;
    expect(artifact.delivery).toBe('mcp_inline');
    expect(artifact.byteLength).toBe(64 * 1024);
  });

  it('1–8 MiB artifacts upload via authenticated PUT and re-inline as MCP image content', async () => {
    nextScreenshot = { bytes: pngBuffer(2 * 1024 * 1024), mimeType: 'image/png' };
    const response = await client.callTool('browser_screenshot', {
      browserSessionHandle: HANDLE,
      tabId: TAB,
      mode: 'viewport',
    });
    expect(response.body.result?.isError).not.toBe(true);
    const artifact = (response.body.result?.structuredContent as {
      artifact: { delivery: string; byteLength: number; artifactId: string };
    }).artifact;
    expect(artifact.delivery).toBe('mcp_inline');
    expect(artifact.byteLength).toBe(2 * 1024 * 1024);
    const image = response.body.result?.content?.find((entry) => entry.type === 'image');
    const bytes = Buffer.from(image?.data ?? '', 'base64');
    expect(bytes.length).toBe(2 * 1024 * 1024);
    expect(bytes.subarray(0, 8)).toEqual(pngBuffer(8).subarray(0, 8));
    // Proof the upload path was taken: the artifact store holds the bytes
    // the agent PUT before its result arrived.
    const stored = await harness.artifacts.get(artifact.artifactId);
    expect(stored?.row.byteLength).toBe(2 * 1024 * 1024);
  }, 30_000);

  it('>8 MiB artifacts deliver as a short-TTL signed URL with hardened download headers', async () => {
    nextScreenshot = { bytes: pngBuffer(9 * 1024 * 1024), mimeType: 'image/png' };
    const response = await client.callTool('browser_screenshot', {
      browserSessionHandle: HANDLE,
      tabId: TAB,
      mode: 'viewport',
    });
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as {
      artifact: { delivery: string; byteLength: number; expiresAt: string | null };
    };
    expect(structured.artifact.delivery).toBe('signed_url');
    expect(structured.artifact.byteLength).toBe(9 * 1024 * 1024);
    expect(structured.artifact.expiresAt).not.toBeNull();

    const link = response.body.result?.content?.find(
      (entry) => entry.type === 'text' && entry.text?.includes('/artifacts/'),
    );
    expect(link?.text).toBeTruthy();
    const url = /https:\/\/\S+/.exec(link!.text!)?.[0];
    expect(url).toBeTruthy();

    const download = await harness.fetch(new Request(url!));
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-disposition')).toMatch(/^attachment/);
    const body = Buffer.from(await download.arrayBuffer());
    expect(body.length).toBe(9 * 1024 * 1024);
  }, 60_000);

  it('active-content artifact MIME types are refused end to end (F-06)', async () => {
    nextScreenshot = { bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), mimeType: 'image/svg+xml' };
    const response = await client.callTool('browser_screenshot', {
      browserSessionHandle: HANDLE,
      tabId: TAB,
      mode: 'viewport',
    });
    expect(response.body.result?.isError).toBe(true);
    const parsed = JSON.parse(response.body.result?.content?.[0]?.text ?? '{}') as { error: { code: string } };
    expect(parsed.error.code).toBe('DOWNLOAD_BLOCKED');
  });
});

describe('wire-level destination threading (F-09)', () => {
  it('the gateway stamps its destination on extract envelopes; the public schema stays clean', async () => {
    const response = await client.callTool('browser_extract', {
      browserSessionHandle: HANDLE,
      tabId: TAB,
      siteProfile: 'ebay.ca.v1',
    });
    expect(response.body.result?.isError).not.toBe(true);
    const record = (response.body.result?.structuredContent as { record: { echoDestination: string | null } }).record;
    expect(record.echoDestination).toBe('M6H 2W9');
    const extractEnvelope = capturedEnvelopes.find((envelope) => envelope.command === 'extract');
    expect(extractEnvelope?.arguments.destinationPostalCode).toBe('M6H 2W9');
    // The session_open envelope used the pending placeholder (§14).
    const openEnvelope = capturedEnvelopes.find((envelope) => envelope.command === 'session_open');
    expect(openEnvelope?.browserSessionHandle).toBe(PENDING_SESSION_HANDLE);
  });
});
