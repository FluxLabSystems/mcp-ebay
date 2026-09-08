/**
 * Output-schema skew between the gateway and an older Windows agent —
 * improvement queue, office 2026-09-08T00:13Z file, fingerprint
 * gateway+schema_drift+browser-snapshot-nodes-omit-required-texttruncated-textlength-response-rejected
 * (BLOCKING: every browser_snapshot on the deployed build was rejected by
 * the MCP client, on every host, so the office routine read provider sites
 * as screenshots).
 *
 * The mechanism, verified against @modelcontextprotocol/server 2.0.0:
 * tools/list advertises `standardSchemaToJsonSchema(outputSchema, "output")`,
 * and in output mode a zod `.default()` field is REQUIRED (the output always
 * has it). On a call the SDK validates the handler's structuredContent with
 * the zod schema — where the defaults fill the gaps, so validation passes —
 * and then sends the handler's ORIGINAL object, not the parsed one. So an
 * agent built before mcp-ebay#58 (nodes without textTruncated/textLength)
 * produced a payload the gateway accepted and every client rejected:
 * "Structured content does not match the tool's output schema:
 * data/snapshot/0 must have required property 'textTruncated' …".
 *
 * The #58 design put the defaults on the schema precisely so an older
 * agent's payload would validate; the gateway just never applied them. The
 * fix parses the broker's result through the tool's output schema before
 * returning it. This test is the tool-boundary check the report asked for:
 * what the gateway sends must satisfy the JSON schema it advertises.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import { SnapshotOutput, type CommandEnvelope } from '@browser-bridge/protocol';
import type { ExecutionOutcome, ExecutorHost } from '@browser-bridge/windows-agent';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { connectAgent, registerTestDevice, stubSessionHost, type ConnectedAgent } from '../helpers/agentHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const HANDLE = 'bs_skew_session_000000000001';
const TAB = 'tab_SKEW0000000000000000000001';

/** A node exactly as a pre-#58 agent emits it: href present (#40), no text markers. */
function oldAgentNode(elementRef: string, role: string, name: string, text: string): Record<string, unknown> {
  return { elementRef, role, name, text, href: null, disabled: false, checked: null, valueRedacted: false };
}

async function oldAgentExecute(_host: ExecutorHost, envelope: CommandEnvelope): Promise<ExecutionOutcome> {
  switch (envelope.command) {
    case 'session_open':
      return {
        result: {
          browserSessionHandle: HANDLE,
          deviceId: envelope.deviceId,
          profileName: 'ebay-research',
          status: 'ready',
          tabs: [{ tabId: TAB, url: 'https://www.zemlar.ca/', title: 'ZEMLAR Offices', active: true, pageRevision: 61 }],
        },
        pageRevision: null,
        artifacts: [],
      };
    case 'snapshot':
      return {
        result: {
          url: 'https://www.zemlar.ca/',
          title: 'Premium Office Space for Rent Toronto GTA | ZEMLAR Offices',
          pageRevision: 61,
          snapshot: [
            oldAgentNode('el_1_1', 'heading', 'Premium Office Space', 'Premium Office Space for Rent'),
            oldAgentNode('el_2_2', 'link', 'Locations', 'Locations'),
          ],
          truncated: false,
        },
        pageRevision: 61,
        artifacts: [],
      };
    default:
      throw new Error(`old-agent executor does not implement ${envelope.command}`);
  }
}

let harness: GatewayHarness;
let agent: ConnectedAgent;
let client: ModernMcpClient;

beforeAll(async () => {
  harness = buildGatewayHarness();
  const urls = await harness.listen();
  const device = await registerTestDevice(harness, 'old-agent-device');
  agent = connectAgent(urls, device.identity, stubSessionHost(HANDLE), { executeCommandImpl: oldAgentExecute });
  agent.connection.start();
  await agent.waitReady();
  client = new ModernMcpClient('https://browser-mcp.test.example/mcp', harness.fetch);
  const open = await client.callTool('browser_session_open', { deviceId: device.identity.deviceId! });
  expect(open.body.result?.isError).not.toBe(true);
});

afterAll(async () => {
  await agent?.stop();
  await harness?.close();
});

interface JsonObjectSchema {
  properties?: Record<string, JsonObjectSchema>;
  items?: JsonObjectSchema;
  required?: string[];
}

describe('what the gateway sends satisfies the output schema it advertises', () => {
  it('tools/list advertises textTruncated and textLength as REQUIRED snapshot-node properties', async () => {
    // The premise, pinned so nobody reads the zod defaults as "optional on
    // the wire": output-mode JSON Schema requires a defaulted field.
    const listed = await client.listTools();
    const tool = listed.body.result?.tools?.find((entry) => entry.name === 'browser_snapshot');
    const items = (tool?.outputSchema as JsonObjectSchema | undefined)?.properties?.snapshot?.items;
    expect(items?.required).toEqual(expect.arrayContaining(['textTruncated', 'textLength']));
    const local = z.toJSONSchema(SnapshotOutput, { io: 'output' }) as JsonObjectSchema;
    expect(local.properties?.snapshot?.items?.required).toEqual(items?.required);
  });

  it('a snapshot from an agent that predates the text markers comes back with every required node property', async () => {
    const listed = await client.listTools();
    const tool = listed.body.result?.tools?.find((entry) => entry.name === 'browser_snapshot');
    const required = (tool?.outputSchema as JsonObjectSchema).properties!.snapshot!.items!.required!;

    const response = await client.callTool('browser_snapshot', { browserSessionHandle: HANDLE, tabId: TAB });
    expect(response.status).toBe(200);
    expect(response.body.result?.isError).not.toBe(true);
    const structured = response.body.result?.structuredContent as { snapshot: Record<string, unknown>[] };
    expect(structured.snapshot).toHaveLength(2);
    // The client's check, applied here: every advertised-required property
    // is present on every node. Before the fix the two text markers were
    // missing on both nodes and the whole response was rejected.
    for (const node of structured.snapshot) {
      for (const key of required) expect(node, `node ${String(node.elementRef)} lacks ${key}`).toHaveProperty(key);
      expect(node.textTruncated).toBe(false);
      expect(node.textLength).toBeNull();
    }
    // The text content mirrors structuredContent, so a client reading the
    // text block sees the same shape.
    const text = response.body.result?.content?.find((entry) => entry.type === 'text')?.text ?? '{}';
    expect(JSON.parse(text)).toEqual(structured);
    // And the full parsed output still satisfies the zod schema exactly.
    expect(SnapshotOutput.safeParse(structured).success).toBe(true);
  });
});
