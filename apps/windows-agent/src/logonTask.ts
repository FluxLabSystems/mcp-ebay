/**
 * Windows Task Scheduler probe for the dashboard's TASK readout.
 *
 * scripts/windows/install-logon-task.ps1 registers the agent as a per-user
 * logon task (SDD v0.5 §13); the dashboard answers the two questions an
 * operator staring at the console window actually has: is that task
 * installed on this PC, and is the thing I am looking at the task's
 * background instance or a window I started by hand.
 *
 * The probe shells out to PowerShell's Get-ScheduledTask (the same
 * PowerShell-as-syscall pattern keystore.ts uses for DPAPI) instead of
 * parsing `schtasks /query`: schtasks localizes its field names, so the
 * parse breaks on any non-English Windows, while ConvertTo-Json is stable.
 * Async on purpose — a Task Scheduler query must never stall the WSS event
 * loop, so the result arrives whenever it arrives and merely updates a pane.
 */
import { execFile } from 'node:child_process';
import type { LogonTaskStatus } from './monitor.js';

/**
 * Task names reaching the PowerShell command line are single-quoted; a
 * quote in the name would end the literal, so it is doubled per PowerShell
 * quoting rules. Names come from trusted config, but quoting correctly
 * costs one replace and removes the class of problem entirely.
 */
function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function probeScript(taskName: string): string {
  const quoted = psSingleQuoted(taskName);
  return [
    `$t = Get-ScheduledTask -TaskName ${quoted} -ErrorAction SilentlyContinue;`,
    'if ($null -eq $t) { "null" } else {',
    `  $i = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue;`,
    '  @{ state = [string]$t.State; lastTaskResult = if ($null -eq $i) { $null } else { [int64]$i.LastTaskResult } } | ConvertTo-Json -Compress',
    '}',
  ].join(' ');
}

export type PowershellRunner = (script: string) => Promise<string>;

const TASK_QUERY_TIMEOUT_MS = 10_000;

function defaultRunner(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: TASK_QUERY_TIMEOUT_MS },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });
}

export interface QueryLogonTaskOptions {
  platform?: NodeJS.Platform;
  runner?: PowershellRunner;
  now?: () => number;
}

/**
 * Probe the logon task once. Never throws: a probe failure is a pane state
 * ("task status unavailable"), not an agent fault, and it must not be able
 * to take the run loop down.
 */
export async function queryLogonTask(
  taskName: string,
  options: QueryLogonTaskOptions = {},
): Promise<LogonTaskStatus> {
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  if (platform !== 'win32') {
    return { supported: false, installed: false, state: null, lastTaskResult: null, checkedAt: now(), error: null };
  }
  const runner = options.runner ?? defaultRunner;
  try {
    const stdout = (await runner(probeScript(taskName))).trim();
    if (stdout === 'null' || stdout.length === 0) {
      return { supported: true, installed: false, state: null, lastTaskResult: null, checkedAt: now(), error: null };
    }
    const parsed = JSON.parse(stdout) as { state?: unknown; lastTaskResult?: unknown };
    return {
      supported: true,
      installed: true,
      state: typeof parsed.state === 'string' && parsed.state.length > 0 ? parsed.state : null,
      lastTaskResult: typeof parsed.lastTaskResult === 'number' ? parsed.lastTaskResult : null,
      checkedAt: now(),
      error: null,
    };
  } catch (err) {
    return {
      supported: true,
      installed: false,
      state: null,
      lastTaskResult: null,
      checkedAt: now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
