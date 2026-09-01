/**
 * Deals run checkpoints end to end: OAuth-verified MCP call → gateway-served
 * deals.* tool → the gateway's own Store. No Windows device and no
 * dashboard-api are on this path — a checkpoint is bookkeeping, and it must
 * be reachable in the same turn that has already spent its browser budget.
 *
 * The store behind this harness is MemoryStore, which is what a deployment
 * without a DATABASE_URL runs and what the PostgreSQL round-trip in
 * migrations.test.ts skips to; the semantics are pinned in
 * tests/unit/runCheckpoints.test.ts and the wiring here.
 */
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtTokenVerifier } from '@browser-bridge/gateway';
import { buildGatewayHarness, type GatewayHarness } from '../helpers/gatewayHarness.js';
import { ModernMcpClient } from '../helpers/mcpClient.js';

const ISSUER = 'https://idp.test.example/realms/fluxology';
const AUDIENCE = 'https://browser-mcp.test.example/mcp';

let privateKey: CryptoKey;
let harness: GatewayHarness;
/** Same deployment shape, minus the dashboard configuration. */
let noDashboards: GatewayHarness;

async function mintToken(scope: string, subject = 'user-1'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ scope, client_id: 'claude-ai' })
    .setProtectedHeader({ alg: 'ES256' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(subject)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);
}

const stubDashboardApi: typeof fetch = async () => Response.json({ ok: true });

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  privateKey = pair.privateKey as CryptoKey;
  const publicJwk = (await exportJWK(pair.publicKey)) as JWK;
  publicJwk.alg = 'ES256';
  const verifier = new JwtTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: 'https://idp.test.example/.well-known/jwks.json',
    jwks: createLocalJWKSet({ keys: [publicJwk] }) as never,
  });
  harness = buildGatewayHarness({
    verifier,
    env: {
      DASHBOARD_API_BASE_URL: 'http://dashboard-api:8082',
      DEALS_INGEST_TOKEN: 'secret-deals-token',
    },
    dashboardFetch: stubDashboardApi,
  });
  noDashboards = buildGatewayHarness({ verifier });
});
afterAll(async () => {
  await harness?.close();
  await noDashboards?.close();
});

function clientWith(token: string, on: GatewayHarness = harness): ModernMcpClient {
  return new ModernMcpClient('https://browser-mcp.test.example/mcp', on.fetch, token);
}

interface CheckpointResult {
  runId: string;
  status: string;
  checkpointCount: number;
  searchedCount: number;
  verifiedCount: number;
  pendingCount: number;
  storedBytes: number;
  expiresAt: string;
  warnings: string[];
}

interface ResumeResult {
  found: boolean;
  resumable: boolean;
  runId: string | null;
  status: string | null;
  searched: string[];
  verifiedIds: string[];
  pendingIds: string[];
  notes: string | null;
  checkpointCount: number;
  ageSeconds: number | null;
  warnings: string[];
}

function errorOf(response: { body: { result?: { content?: { text?: string }[] } } }): { code?: string; message?: string } {
  const parsed = JSON.parse(response.body.result?.content?.[0]?.text ?? '{}') as {
    error?: { code: string; message: string };
  };
  return parsed.error ?? {};
}

describe('deals run tools over the live MCP surface', () => {
  it('registers deals_run_checkpoint and deals_run_resume with the dashboard tools', async () => {
    const response = await clientWith(await mintToken('deals:write')).listTools();
    expect(response.status).toBe(200);
    const names = (response.body.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).toContain('deals_run_checkpoint');
    expect(names).toContain('deals_run_resume');
    // Backward compatibility: Phase 1–3 tools keep their names.
    expect(names).toContain('dashboard_upsert');
    expect(names).toContain('browser_extract_many');
  });

  it('is absent when the deployment configures no dashboards', async () => {
    // The run tools need only the Store, but they authorise with
    // deals:write, and that scope is advertised only when the dashboards
    // are configured — publishing a tool no token could satisfy would be
    // worse than not publishing it.
    const response = await clientWith(await mintToken('deals:write'), noDashboards).listTools();
    const names = (response.body.result?.tools as { name: string }[]).map((tool) => tool.name);
    expect(names).not.toContain('deals_run_checkpoint');
    expect(names).not.toContain('dashboard_upsert');
    expect(names).toContain('browser_extract_many');
  });

  it('a run that stops mid-traversal resumes from its checkpoint instead of re-searching', async () => {
    const client = clientWith(await mintToken('deals:write'));
    // Turn 1: the search ran, two items were verified, three are queued —
    // then the turn ends at the tool-call ceiling.
    const first = await client.callTool('deals_run_checkpoint', {
      runId: 'deals-2026-08-29',
      searched: ['ebay: lego bulk lot', 'kijiji: lego lot toronto'],
      verifiedIds: ['ebay-226123456789', 'kijiji-1740940278'],
      pendingIds: ['ebay-226999999991', 'ebay-226999999992', 'ebay-226999999993'],
      notes: 'Track A page 2 of 5',
    });
    expect(first.body.result?.isError).not.toBe(true);
    const written = first.body.result?.structuredContent as unknown as CheckpointResult;
    expect(written).toMatchObject({ status: 'running', checkpointCount: 1, verifiedCount: 2, pendingCount: 3 });
    expect(written.warnings).toEqual([]);
    expect(written.storedBytes).toBeGreaterThan(0);

    // Turn 2 opens with a resume and pays one call, not a whole re-search.
    const resumed = (
      await client.callTool('deals_run_resume', {})
    ).body.result?.structuredContent as unknown as ResumeResult;
    expect(resumed).toMatchObject({ found: true, resumable: true, runId: 'deals-2026-08-29', status: 'running' });
    expect(resumed.verifiedIds).toEqual(['ebay-226123456789', 'kijiji-1740940278']);
    expect(resumed.pendingIds).toHaveLength(3);
    expect(resumed.notes).toBe('Track A page 2 of 5');
    expect(resumed.ageSeconds).toBeGreaterThanOrEqual(0);

    // Turn 2 finishes the queue and closes the run out.
    const second = (
      await client.callTool('deals_run_checkpoint', {
        runId: 'deals-2026-08-29',
        verifiedIds: ['ebay-226999999991', 'ebay-226999999992', 'ebay-226999999993'],
        pendingIds: [],
        status: 'completed',
      })
    ).body.result?.structuredContent as unknown as CheckpointResult;
    expect(second).toMatchObject({ status: 'completed', checkpointCount: 2, verifiedCount: 5, pendingCount: 0 });

    // A completed run is readable by name but is not offered as the latest.
    const byName = (
      await client.callTool('deals_run_resume', { runId: 'deals-2026-08-29' })
    ).body.result?.structuredContent as unknown as ResumeResult;
    expect(byName).toMatchObject({ found: true, resumable: false, status: 'completed' });
    const latest = (
      await client.callTool('deals_run_resume', {})
    ).body.result?.structuredContent as unknown as ResumeResult;
    expect(latest.found).toBe(false);
    expect(latest.warnings[0]).toContain('No resumable deals run');
  });

  it('reads take dashboards:read; writes require deals:write', async () => {
    const reader = clientWith(await mintToken('dashboards:read'));
    const resume = await reader.callTool('deals_run_resume', {});
    expect(resume.body.result?.isError).not.toBe(true);

    const write = await reader.callTool('deals_run_checkpoint', { runId: 'r', verifiedIds: ['ebay-1'] });
    expect(write.body.result?.isError).toBe(true);
    expect(errorOf(write).code).toBe('ACTION_BLOCKED');
    expect(errorOf(write).message).toContain('deals:write');
  });

  it('any dashboard write scope satisfies a read; a browser-only token satisfies neither', async () => {
    // Mirrors dashboardScopeSatisfies: write implies read across dashboards.
    const vacation = await clientWith(await mintToken('vacation:write')).callTool('deals_run_resume', {});
    expect(vacation.body.result?.isError).not.toBe(true);

    const browserOnly = clientWith(await mintToken('browser:read browser:interact'));
    for (const [tool, args] of [
      ['deals_run_resume', {}],
      ['deals_run_checkpoint', { runId: 'r' }],
    ] as const) {
      const response = await browserOnly.callTool(tool, args);
      expect(response.body.result?.isError, tool).toBe(true);
      expect(errorOf(response).code, tool).toBe('ACTION_BLOCKED');
    }
  });

  it('one caller cannot resume another caller\'s run', async () => {
    const mine = clientWith(await mintToken('deals:write', 'user-a'));
    const theirs = clientWith(await mintToken('deals:write', 'user-b'));
    await mine.callTool('deals_run_checkpoint', { runId: 'owned-by-a', verifiedIds: ['ebay-1'] });

    const byName = (
      await theirs.callTool('deals_run_resume', { runId: 'owned-by-a' })
    ).body.result?.structuredContent as unknown as ResumeResult;
    expect(byName.found).toBe(false);

    const write = await theirs.callTool('deals_run_checkpoint', { runId: 'owned-by-a', verifiedIds: ['ebay-9'] });
    expect(write.body.result?.isError).toBe(true);
    expect(errorOf(write).code).toBe('ACTION_BLOCKED');

    const owner = (
      await mine.callTool('deals_run_resume', { runId: 'owned-by-a' })
    ).body.result?.structuredContent as unknown as ResumeResult;
    expect(owner.verifiedIds).toEqual(['ebay-1']);
  });

  it('refuses a checkpoint that tries to park page content in it', async () => {
    const client = clientWith(await mintToken('deals:write'));
    const oversized = await client.callTool('deals_run_checkpoint', {
      runId: 'blob-attempt',
      notes: 'x'.repeat(5000),
    });
    expect(oversized.body.result?.isError).toBe(true);

    const unknownField = await client.callTool('deals_run_checkpoint', {
      runId: 'blob-attempt',
      records: [{ id: 'ebay-1', title: 'LEGO lot', descriptionHtml: '<p>...</p>' }],
    });
    expect(unknownField.body.result?.isError).toBe(true);
  });
});
