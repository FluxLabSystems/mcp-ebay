/**
 * DEGRADED error details (2026-09-05, gateway+defect+
 * bridge-agent-degraded-blocks-new-session-creation, read as the
 * windows-agent connector_defect it is): once the agent has counted more than
 * three launches in five minutes, browser_session_open for a NEW profile
 * failed with BROWSER_UNAVAILABLE "Agent is DEGRADED after repeated browser
 * crashes; user intervention required." and details {} — so a routine could
 * not tell a crash loop from a box that needs a human, did not know which
 * profiles had crashed, and did not know that its already-open sessions
 * keep working. The message is unchanged; the details now say all of that.
 *
 * The crash-loop threshold (>3 launches in 5 minutes, SDD §13) and the
 * no-auto-reap rule are deliberately untouched here.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { buildTestLaunchPlan, type PersistentContextLauncher } from '@browser-bridge/browser-core';
import { BridgeError } from '@browser-bridge/protocol';
import { createPagePolicy, SessionManager } from '@browser-bridge/windows-agent';
import { makeFixtureProfile } from '../helpers/testProfile.js';

const CRASHING_LAUNCHER: PersistentContextLauncher = async () => {
  throw new Error('boom');
};

function makeManager(): SessionManager {
  return new SessionManager({
    profileDir: mkdtempSync(join(tmpdir(), 'bridge-degraded-profile-')),
    policy: createPagePolicy(makeFixtureProfile()),
    logger: pino({ level: 'silent' }),
    launcher: CRASHING_LAUNCHER,
    planOverride: buildTestLaunchPlan(mkdtempSync(join(tmpdir(), 'bridge-degraded-userdata-'))),
  });
}

async function rejection(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error('expected the open to reject');
}

describe('SessionManager DEGRADED: the BROWSER_UNAVAILABLE details say what a routine needs (2026-09-05 fire)', () => {
  it('four crashing launches of one profile degrade the agent; the fifth open, of a new profile, carries the diagnosis', async () => {
    const sessions = makeManager();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const err = await rejection(sessions.open('p1'));
      expect(err.code).toBe('BROWSER_UNAVAILABLE');
      expect(err.message).toMatch(/boom/);
    }
    expect(sessions.isDegraded).toBe(true);

    const degraded = await rejection(sessions.open('p2'));
    expect(degraded.code).toBe('BROWSER_UNAVAILABLE');
    expect(degraded.retryable).toBe(true);
    // The message the fire quoted, verbatim, is kept.
    expect(degraded.message).toBe('Agent is DEGRADED after repeated browser crashes; user intervention required.');

    const details = degraded.details;
    expect(details.degraded).toBe(true);
    expect(details.launchesInWindow).toBe(4);
    expect(details.windowMs).toBe(300_000);
    expect(details.crashedProfiles).toEqual(['p1']);
    expect(details.openSessions).toEqual([]);
    expect(details.recovery).toBe('manual');
    expect(typeof details.hint).toBe('string');
    expect(details.hint as string).toMatch(/existing sessions keep working/i);
    expect(details.hint as string).toMatch(/restart the agent/i);
    expect(details.hint as string).toMatch(/operator/i);

    await sessions.close();
  });

  it('the profile that was not part of the loop is not listed as crashed, and the crashed one is listed once', async () => {
    const sessions = makeManager();
    await rejection(sessions.open('p1'));
    await rejection(sessions.open('p1'));
    await rejection(sessions.open('p3'));
    await rejection(sessions.open('p1'));
    const degraded = await rejection(sessions.open('p2'));
    expect(degraded.details.crashedProfiles).toEqual(['p1', 'p3']);
    expect(degraded.details.launchesInWindow).toBe(4);
    await sessions.close();
  });

  it('a manager that is not degraded never attaches the diagnosis to an ordinary launch failure', async () => {
    const sessions = makeManager();
    const err = await rejection(sessions.open('p1'));
    expect(err.details.degraded).toBeUndefined();
    expect(sessions.isDegraded).toBe(false);
    await sessions.close();
  });
});
