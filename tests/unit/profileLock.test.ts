/**
 * Profile lock liveness (2026-09-15). Three routine fires on one day hit
 * the same fault: after the Windows agent died at 10:07:22Z, every
 * browser_session_open for `ebay-research` (deals, five attempts across the
 * fire), `ebay-research.wardrobe-research` (wardrobe) and
 * `ebay-research.office-research` (office, four hours later) answered
 * PROFILE_IN_USE, retryable:false, details {lockFilePath} — while the same
 * device opened `ebay-research.w2` and `.w3` normally. Fingerprints:
 * windows-agent+coverage_gap+stale-profile-lock-blocks-the-signed-in-ebay-
 * research-profile-after-an-agent-reconnect and windows-agent+connector_
 * defect+agent-death-leaves-stale-profile-lock-so-browser-session-open-
 * fails-profile-in-use.
 *
 * The lock only ever reclaimed a pid that answered ESRCH. A lock whose pid
 * was alive as SOMETHING (a hung agent, or a recycled number) was refused
 * for ever, and the refusal carried nothing a routine or the operator could
 * act on. These tests pin the evidence shape first — a lock held by an
 * alive pid that is not this process and has not been refreshed — and the
 * fix: instance id + heartbeat in the payload, staleness by silence, owner
 * facts on the refusal, and a startup sweep across sibling profile dirs.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  acquireProfileLock,
  inspectProfileLock,
  PROFILE_LOCK_FILENAME,
  PROFILE_LOCK_INSTANCE_ID,
  PROFILE_LOCK_STALE_AFTER_MS,
  sweepStaleProfileLocks,
  type PidProbe,
} from '@browser-bridge/browser-core';
import type { BridgeError } from '@browser-bridge/protocol';
import { listProfileDirectories, sweepProfileLocksAtStartup } from '@browser-bridge/windows-agent';

const ALIVE: PidProbe = () => 'alive';
const DEAD: PidProbe = () => 'dead';
const EPERM: PidProbe = () => 'unknown';

/** A pid that is not ours; the probe decides its liveness, so the number itself does not matter. */
const OTHER_PID = process.pid + 100_000;

function tempProfile(): string {
  return mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'bridge-lock-'));
}

function writeLock(dir: string, payload: Record<string, unknown>): string {
  const path = join(dir, PROFILE_LOCK_FILENAME);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

function refuse(fn: () => unknown): BridgeError {
  try {
    fn();
  } catch (err) {
    return err as BridgeError;
  }
  throw new Error('expected PROFILE_IN_USE');
}

describe('PROFILE_IN_USE says who owns the lock (the 2026-09-15 evidence: details carried only lockFilePath)', () => {
  it('a live, heartbeating owner is refused, and the details carry the owner facts and a reason', () => {
    const dir = tempProfile();
    const now = Date.parse('2026-09-15T10:07:00.000Z');
    writeLock(dir, {
      pid: OTHER_PID,
      hostname: hostname(),
      acquiredAt: '2026-09-15T10:05:08.000Z',
      instanceId: 'other-agent-instance',
      heartbeatAt: '2026-09-15T10:06:40.000Z',
    });
    const err = refuse(() => acquireProfileLock(dir, { probe: ALIVE, now: () => now, heartbeatMs: 0 }));
    expect(err.code).toBe('PROFILE_IN_USE');
    expect(err.retryable).toBe(false);
    expect(err.details.lockFilePath).toBe(join(dir, PROFILE_LOCK_FILENAME));
    expect(err.details.lockOwnerPid).toBe(OTHER_PID);
    expect(err.details.lockOwnerHostname).toBe(hostname());
    expect(err.details.lockAcquiredAt).toBe('2026-09-15T10:05:08.000Z');
    expect(err.details.lockHeartbeatAt).toBe('2026-09-15T10:06:40.000Z');
    expect(err.details.lockHeartbeatAgeMs).toBe(20_000);
    expect(err.details.lockOwnerAlive).toBe('alive');
    expect(err.details.ownerIsThisProcess).toBe(false);
    expect(err.details.reason).toBe('owner_live');
    expect(err.details.staleAfterMs).toBe(PROFILE_LOCK_STALE_AFTER_MS);
    expect(String(err.details.hint)).toMatch(/another agent process is serving this profile right now/);
    // The lock is untouched.
    expect(JSON.parse(readFileSync(join(dir, PROFILE_LOCK_FILENAME), 'utf8')).pid).toBe(OTHER_PID);
  });

  it('a foreign-host lock is still refused (the local process table proves nothing), and says so', () => {
    const dir = tempProfile();
    writeLock(dir, { pid: 1, hostname: 'other-host', acquiredAt: new Date().toISOString() });
    const err = refuse(() => acquireProfileLock(dir, { probe: DEAD, heartbeatMs: 0 }));
    expect(err.code).toBe('PROFILE_IN_USE');
    expect(err.details.reason).toBe('foreign_host');
    expect(err.details.lockOwnerAlive).toBe('unknown');
    expect(String(err.details.hint)).toMatch(/other-host/);
  });
});

describe('a lock that outlived its owner is reclaimed on open (the fault the three fires hit)', () => {
  it('REPRODUCTION: the evidence shape — an alive pid that is not this process, a lock not refreshed for hours — is reclaimed, not refused', () => {
    // The deals fire's timeline: session opened 10:05:08Z, agent last frame
    // 10:06:02Z, PROFILE_IN_USE at 10:07, 10:08, 10:10, 10:19 and 10:27Z; the
    // office fire found the sibling profile still locked at 12:04Z. Before
    // this change every one of those opens was refused because the pid was
    // alive as something.
    const dir = tempProfile();
    writeLock(dir, { pid: OTHER_PID, hostname: hostname(), acquiredAt: '2026-09-15T10:05:08.000Z' });
    const reclaimed: string[] = [];
    const attempt = (at: string) =>
      acquireProfileLock(dir, {
        probe: ALIVE,
        now: () => Date.parse(at),
        heartbeatMs: 0,
        onReclaim: (inspection) => reclaimed.push(inspection.verdict),
      });
    // 10:07Z: two minutes after the lock was written, an alive owner is still within the silence threshold.
    expect(refuse(() => attempt('2026-09-15T10:07:00.000Z')).details.reason).toBe('owner_live');
    // 12:04Z: four hours of silence — reclaimed, with the reason logged.
    const lock = attempt('2026-09-15T12:04:00.000Z');
    expect(reclaimed).toEqual(['owner_silent']);
    const written = JSON.parse(readFileSync(lock.lockFilePath, 'utf8'));
    expect(written.pid).toBe(process.pid);
    expect(written.instanceId).toBe(PROFILE_LOCK_INSTANCE_ID);
    expect(written.heartbeatAt).toBe('2026-09-15T12:04:00.000Z');
    lock.release();
    expect(existsSync(lock.lockFilePath)).toBe(false);
  });

  it('a lock whose owner pid is dead is reclaimed immediately (the pre-existing rule, kept)', () => {
    const dir = tempProfile();
    writeLock(dir, {
      pid: OTHER_PID,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      instanceId: 'x',
      heartbeatAt: new Date().toISOString(),
    });
    const lock = acquireProfileLock(dir, { probe: DEAD, heartbeatMs: 0 });
    expect(JSON.parse(readFileSync(lock.lockFilePath, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('a lock on OUR pid written by another instance is a recycled pid, reclaimed at once', () => {
    const dir = tempProfile();
    writeLock(dir, {
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      instanceId: 'the-agent-that-died',
      heartbeatAt: new Date().toISOString(),
    });
    expect(inspectProfileLock(dir).verdict).toBe('pid_reused');
    const lock = acquireProfileLock(dir, { heartbeatMs: 0 });
    expect(JSON.parse(readFileSync(lock.lockFilePath, 'utf8')).instanceId).toBe(PROFILE_LOCK_INSTANCE_ID);
    lock.release();
  });

  it('a pid the agent may not probe (EPERM) is refused while fresh and reclaimed once silent', () => {
    const dir = tempProfile();
    const acquiredAt = Date.parse('2026-09-15T10:05:08.000Z');
    writeLock(dir, { pid: OTHER_PID, hostname: hostname(), acquiredAt: new Date(acquiredAt).toISOString() });
    const fresh = inspectProfileLock(dir, { probe: EPERM, now: () => acquiredAt + 60_000 });
    expect(fresh).toMatchObject({ verdict: 'owner_live', stale: false, lockOwnerAlive: 'unknown' });
    const silent = inspectProfileLock(dir, { probe: EPERM, now: () => acquiredAt + PROFILE_LOCK_STALE_AFTER_MS + 1 });
    expect(silent).toMatchObject({ verdict: 'owner_silent', stale: true, lockOwnerAlive: 'unknown' });
  });

  it('our own earlier acquisition is re-entrant, and an unreadable lock is reclaimed', () => {
    const dir = tempProfile();
    const first = acquireProfileLock(dir, { heartbeatMs: 0 });
    expect(inspectProfileLock(dir).verdict).toBe('self');
    const second = acquireProfileLock(dir, { heartbeatMs: 0 });
    second.release();
    first.release();
    writeLock(dir, {}); // no pid, no hostname
    expect(inspectProfileLock(dir).verdict).toBe('unreadable');
    const third = acquireProfileLock(dir, { heartbeatMs: 0 });
    third.release();
  });
});

describe('the held lock keeps its heartbeat fresh', () => {
  it('rewrites heartbeatAt on the timer and stops at release', async () => {
    const dir = tempProfile();
    let clock = Date.parse('2026-09-15T10:05:08.000Z');
    const lock = acquireProfileLock(dir, { heartbeatMs: 20, now: () => clock });
    const initial = JSON.parse(readFileSync(lock.lockFilePath, 'utf8'));
    expect(initial.heartbeatAt).toBe('2026-09-15T10:05:08.000Z');
    clock += 60_000;
    await new Promise((resolve) => setTimeout(resolve, 120));
    const refreshed = JSON.parse(readFileSync(lock.lockFilePath, 'utf8'));
    expect(refreshed.heartbeatAt).toBe('2026-09-15T10:06:08.000Z');
    expect(refreshed.acquiredAt).toBe('2026-09-15T10:05:08.000Z');
    expect(refreshed.instanceId).toBe(PROFILE_LOCK_INSTANCE_ID);
    lock.release();
    expect(existsSync(lock.lockFilePath)).toBe(false);
    // No temp files left behind by the atomic rewrite.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(existsSync(lock.lockFilePath)).toBe(false);
  });

  it('release never deletes a lock that now belongs to another instance', () => {
    const dir = tempProfile();
    const lock = acquireProfileLock(dir, { heartbeatMs: 0 });
    // Another process reclaimed it (simulated) while we still held our handle.
    writeLock(dir, { pid: OTHER_PID, hostname: hostname(), acquiredAt: new Date().toISOString(), instanceId: 'other' });
    lock.release();
    expect(JSON.parse(readFileSync(join(dir, PROFILE_LOCK_FILENAME), 'utf8')).instanceId).toBe('other');
  });
});

describe('agent startup sweeps every sibling profile directory (one death locked three profiles)', () => {
  it('lists the default profile and its dotted siblings, and nothing else', () => {
    const root = tempProfile();
    const base = join(root, 'ebay-research');
    mkdirSync(base);
    mkdirSync(join(root, 'ebay-research.wardrobe-research'));
    mkdirSync(join(root, 'ebay-research.office-research'));
    mkdirSync(join(root, 'ebay-research.w2'));
    mkdirSync(join(root, 'ebay-research.not a profile!'));
    mkdirSync(join(root, 'unrelated'));
    writeFileSync(join(root, 'ebay-research.file'), '');
    expect(listProfileDirectories(base)).toEqual([
      base,
      join(root, 'ebay-research.office-research'),
      join(root, 'ebay-research.w2'),
      join(root, 'ebay-research.wardrobe-research'),
    ]);
  });

  it('removes the dead agent\'s locks across profiles, keeps a live owner\'s, and logs each', () => {
    const root = tempProfile();
    const base = join(root, 'ebay-research');
    const wardrobe = join(root, 'ebay-research.wardrobe-research');
    const office = join(root, 'ebay-research.office-research');
    const w2 = join(root, 'ebay-research.w2');
    for (const dir of [base, wardrobe, office, w2]) mkdirSync(dir);
    const deadAgent = { pid: OTHER_PID, hostname: hostname(), acquiredAt: '2026-09-15T10:05:08.000Z' };
    writeLock(base, deadAgent);
    writeLock(wardrobe, { ...deadAgent, acquiredAt: '2026-09-15T10:04:00.000Z' });
    writeLock(office, { ...deadAgent, acquiredAt: '2026-09-15T08:10:00.000Z' });
    const liveOther = {
      pid: OTHER_PID + 1,
      hostname: hostname(),
      acquiredAt: '2026-09-15T12:03:00.000Z',
      instanceId: 'live-second-agent',
      heartbeatAt: '2026-09-15T12:03:50.000Z',
    };
    writeLock(w2, liveOther);

    const lines: Array<{ level: string; msg: string; obj: Record<string, unknown> }> = [];
    const logger = pino(
      { level: 'debug' },
      {
        write(line: string) {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          lines.push({ level: String(parsed.level), msg: String(parsed.msg), obj: parsed });
        },
      },
    );
    const entries = sweepProfileLocksAtStartup(base, logger, {
      probe: ALIVE, // every pid "alive": the recycled-pid case, the worst one
      now: () => Date.parse('2026-09-15T12:04:00.000Z'),
    });
    expect(entries.map((entry) => [entry.profileDir, entry.action, entry.inspection.verdict])).toEqual([
      [base, 'removed', 'owner_silent'],
      [office, 'removed', 'owner_silent'],
      [w2, 'kept', 'owner_live'],
      [wardrobe, 'removed', 'owner_silent'],
    ]);
    expect(existsSync(join(base, PROFILE_LOCK_FILENAME))).toBe(false);
    expect(existsSync(join(wardrobe, PROFILE_LOCK_FILENAME))).toBe(false);
    expect(existsSync(join(office, PROFILE_LOCK_FILENAME))).toBe(false);
    expect(existsSync(join(w2, PROFILE_LOCK_FILENAME))).toBe(true);
    const removedLines = lines.filter((line) => line.msg === 'Removed a stale profile lock at startup');
    expect(removedLines).toHaveLength(3);
    expect(removedLines[0]!.obj.lockOwnerPid).toBe(OTHER_PID);
    expect(removedLines[0]!.obj.reason).toBe('owner_silent');
    expect(lines.filter((line) => line.msg.startsWith('Kept a profile lock'))).toHaveLength(1);
  });

  it('the plain sweep leaves our own lock alone', () => {
    const dir = tempProfile();
    const lock = acquireProfileLock(dir, { heartbeatMs: 0 });
    expect(sweepStaleProfileLocks([dir])[0]).toMatchObject({ action: 'kept', inspection: { verdict: 'self' } });
    expect(sweepStaleProfileLocks([join(dir, 'nothing-here')])[0]).toMatchObject({ action: 'none' });
    lock.release();
  });
});
