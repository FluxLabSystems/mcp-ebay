/**
 * Real-Chromium verification of the revision-pin and auth-hop behavior the
 * stub-driven conformance cases assert (Prompt 0 Phases 2-3). The stub
 * models framenavigated/goto by hand; this file proves the model against an
 * actual browser: a live page that rewrites its own extractable fields, and
 * a real 302 into an auth path.
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { navigate, type BrowserSessionRuntime } from '@browser-bridge/browser-core';
import {
  executeCommand,
  type ExecutorHost,
  type SessionHost,
} from '@browser-bridge/windows-agent';
import { WIRE_PROTOCOL_VERSION, type CommandEnvelope } from '@browser-bridge/protocol';
import { launchTestSession, resolveTestExecutablePath, type BrowserHarness } from '../helpers/browserHarness.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixtureServer.js';
import { makeFixtureProfile } from '../helpers/testProfile.js';

const hasBrowser = resolveTestExecutablePath() !== undefined;

let fixtures: FixtureServer;
let harness: BrowserHarness;
let host: ExecutorHost;
let tabId: string;

function envelope(command: string, args: Record<string, unknown>): CommandEnvelope {
  return {
    protocolVersion: WIRE_PROTOCOL_VERSION,
    type: 'command',
    requestId: `req-pin-${Math.random().toString(36).slice(2)}`,
    deviceId: 'dev-pin-1',
    browserSessionHandle: harness.session.handle,
    tabId,
    command,
    arguments: args,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotencyKey: `idem-pin-${Math.random().toString(36).slice(2)}`,
    policyClass: 'read',
    traceparent: null,
  } as CommandEnvelope;
}

function hostFor(session: BrowserSessionRuntime): ExecutorHost {
  const sessions: SessionHost = {
    open: () => Promise.reject(new Error('session_open not exercised here')),
    resolve: () => session,
    listActive: () => [session],
    isDegraded: false,
  };
  return { sessions, logger: pino({ level: 'silent' }), expectedPostalCode: 'M6H 2W9' };
}

describe.runIf(hasBrowser)('revision pin against a real mutating page', () => {
  beforeAll(async () => {
    fixtures = await startFixtureServer();
    harness = await launchTestSession(
      makeFixtureProfile({
        // Auth deny rules for the redirect-hop case below.
        authPathPatterns: ['https?://127\\.0\\.0\\.1:\\d+/account/(?:signin|login)'],
      }),
    );
    host = hostFor(harness.session);
    const tabs = await harness.session.listTabs();
    tabId = tabs[0]!.tabId;
  }, 60_000);

  afterAll(async () => {
    await harness?.close();
    await fixtures?.close();
  });

  it('extracts are byte-identical at one revision while the page rewrites itself; wait bumps honestly', async () => {
    await navigate(
      harness.session,
      tabId,
      `${fixtures.baseUrl}/pages/mutating-listing.html`,
      'load',
      15_000,
    );
    // Let the first mutation ticks land so the page is actively churning.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const first = await executeCommand(host, envelope('extract', { siteProfile: 'ebay.ca.v1' }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = await executeCommand(host, envelope('extract', { siteProfile: 'ebay.ca.v1' }));

    // B1: the page mutated between the calls; the payloads must not.
    expect(second.pageRevision).toBe(first.pageRevision);
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));

    // B2: browser.wait is the refresh point — the drifted content must
    // surface as a revision bump, and determinism must hold at the new one.
    const waited = await executeCommand(
      host,
      envelope('wait', { condition: { networkIdleMs: 150 }, timeoutMs: 10_000 }),
    );
    expect(waited.result.pageRevision as number).toBeGreaterThan(first.pageRevision ?? 0);

    const third = await executeCommand(host, envelope('extract', { siteProfile: 'ebay.ca.v1' }));
    expect(third.pageRevision).toBe(waited.result.pageRevision);
    expect(JSON.stringify(third.result)).not.toBe(JSON.stringify(first.result));

    const fourth = await executeCommand(host, envelope('extract', { siteProfile: 'ebay.ca.v1' }));
    expect(JSON.stringify(fourth.result)).toBe(JSON.stringify(third.result));
  }, 60_000);

  it('a 302 into an auth path is blocked at the hop (post-redirect enforcement)', async () => {
    const target = `${fixtures.baseUrl}/redirect/hop?to=${encodeURIComponent('/account/signin')}`;
    await expect(
      navigate(harness.session, tabId, target, 'domcontentloaded', 15_000),
    ).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  }, 30_000);

  it('direct navigation to an auth path is blocked before the request leaves', async () => {
    await expect(
      navigate(
        harness.session,
        tabId,
        `${fixtures.baseUrl}/account/login`,
        'domcontentloaded',
        15_000,
      ),
    ).rejects.toMatchObject({ code: 'ACTION_BLOCKED' });
  }, 30_000);
});
