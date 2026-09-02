/**
 * Agent console dashboard (windows-agent monitor.ts / tui.ts / logonTask.ts).
 *
 * The load-bearing tests: the §26 redaction proof for the teed log stream
 * (dashboard mode reroutes pino, so the censored line — not the raw values —
 * must be what reaches both the file sink and the on-screen tail), the
 * plain-mode fallback decision (a piped agent must keep emitting NDJSON for
 * the harness), and the renderer's geometry contract (exactly `rows` lines,
 * none wider than `columns`, whatever the terminal size).
 */
import { describe, expect, it } from 'vitest';
import { loadAgentConfig, DEFAULT_LOGON_TASK_NAME } from '@browser-bridge/config';
import {
  AgentStatusStore,
  AgentTui,
  BatchJobStore,
  buildConfigEntries,
  createLogger,
  detectCharset,
  detectColorMode,
  interpretKey,
  meter,
  parseLogLine,
  queryDefaultTerminal,
  queryLogonTask,
  renderDashboard,
  resolveUiMode,
  initialViewState,
  sparkline,
  type AgentStaticInfo,
  type ColorMode,
  type LogonTaskStatus,
  type ViewState,
} from '@browser-bridge/windows-agent';

// eslint-disable-next-line no-control-regex -- an ANSI stripper is exactly a control-character regex
const stripAnsi = (text: string): string => text.replace(/\u001b\][^\u0007]*\u0007/g, '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

function testInfo(overrides: Partial<AgentStaticInfo> = {}): AgentStaticInfo {
  return {
    version: '0.1.0',
    deviceId: 'dev_01TEST',
    fingerprint: 'fp:abcd',
    keyStoreKind: 'plainfile-dev',
    gatewayWsUrl: 'ws://127.0.0.1:3000/agent/ws',
    agentName: 'test-agent',
    siteProfiles: ['ebay.ca.v1'],
    launchedBy: 'interactive',
    taskName: DEFAULT_LOGON_TASK_NAME,
    logPath: '/tmp/agent-run.ndjson',
    pid: 4242,
    startedAt: 1_000_000,
    ...overrides,
  };
}

function testStore(now: () => number = () => 1_060_000): AgentStatusStore {
  return new AgentStatusStore({ info: testInfo(), now });
}

describe('AgentStatusStore', () => {
  it('tracks the connection lifecycle and counts reconnects only after readiness', () => {
    const store = testStore();
    store.connectionConnecting('ws://x');
    expect(store.snapshot().phase).toBe('connecting');
    store.connectionReady('conn_1');
    expect(store.snapshot()).toMatchObject({ phase: 'connected', connectionId: 'conn_1', reconnects: 0 });
    store.connectionLost('closed', 2000);
    expect(store.snapshot()).toMatchObject({ phase: 'waiting', retryDelayMs: 2000, reconnects: 1, connectionId: null });
    // A failed attempt that never became ready is not another "reconnect".
    store.connectionConnecting('ws://x');
    store.connectionLost('closed', 4000);
    expect(store.snapshot().reconnects).toBe(1);
    store.connectionStopped();
    expect(store.snapshot().phase).toBe('stopped');
  });

  it('tracks command rows, totals, in-flight, and per-minute rate', () => {
    let at = 1_000_000;
    const store = testStore(() => at);
    store.commandStarted('req_1', 'browser_navigate');
    store.commandStarted('req_2', 'browser_snapshot');
    expect(store.snapshot().inFlight).toBe(2);
    store.commandFinished('req_1', 'ok', 812, null);
    store.commandFinished('req_2', 'error', 102, 'POLICY_BLOCKED_URL');
    const snapshot = store.snapshot();
    expect(snapshot.inFlight).toBe(0);
    expect(snapshot.totals).toEqual({ ok: 1, error: 1 });
    expect(snapshot.commandsPerMinute).toBe(2);
    // Newest first; the error row carries its code.
    expect(snapshot.commands[0]).toMatchObject({ requestId: 'req_2', status: 'error', errorCode: 'POLICY_BLOCKED_URL' });
    expect(snapshot.commands[1]).toMatchObject({ requestId: 'req_1', status: 'ok', durationMs: 812 });
    // Finishes older than a minute stop counting toward the rate, but stay
    // visible in the 10-minute sparkline history.
    at += 61_000;
    const later = store.snapshot();
    expect(later.commandsPerMinute).toBe(0);
    expect(later.activityBuckets).toHaveLength(40);
    expect(later.activityBuckets.reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(later.activityBuckets.slice(-4).reduce((sum, n) => sum + n, 0)).toBe(0);
  });

  it('caps history rings and clearHistory resets history but not identity or phase', () => {
    const store = testStore();
    store.connectionReady('conn_1');
    for (let i = 0; i < 150; i++) store.commandStarted(`req_${i}`, 'browser_extract');
    for (let i = 0; i < 500; i++) store.recordLogLine(`{"level":30,"time":1,"msg":"m${i}"}`);
    let snapshot = store.snapshot();
    expect(snapshot.commands.length).toBe(120);
    expect(snapshot.logs.length).toBe(400);
    store.policyBlocked('popup_denied');
    store.clearHistory();
    snapshot = store.snapshot();
    expect(snapshot.commands).toEqual([]);
    expect(snapshot.logs).toEqual([]);
    expect(snapshot.totals).toEqual({ ok: 0, error: 0 });
    expect(snapshot.policy.popup_denied).toBe(0);
    expect(snapshot.phase).toBe('connected');
    expect(snapshot.info.deviceId).toBe('dev_01TEST');
  });

  it('keeps the session snapshot in step with open/degraded/close', () => {
    const store = testStore();
    store.sessionOpened('bs_1', 'ebay-research');
    store.updateTabs([{ tabId: 't1', url: 'https://www.ebay.ca/', title: 'eBay', active: true }]);
    expect(store.snapshot().session).toMatchObject({ handle: 'bs_1', degraded: false });
    expect(store.snapshot().session?.tabs).toHaveLength(1);
    store.sessionDegraded();
    expect(store.snapshot().session?.degraded).toBe(true);
    store.sessionClosed();
    expect(store.snapshot().session).toBeNull();
    // Degradation is sticky across the next open (§13: user intervention).
    store.sessionOpened('bs_2', 'ebay-research');
    expect(store.snapshot().session?.degraded).toBe(true);
  });
});

describe('log stream tee (§26 redaction holds in dashboard mode)', () => {
  it('never lets a secret value reach the file sink or the on-screen tail', () => {
    const fileLines: string[] = [];
    const store = testStore();
    const logger = createLogger('info', 'test-agent', {
      write: (line: string) => {
        fileLines.push(line);
        store.recordLogLine(line);
      },
    });
    logger.info({ token: 'super-secret-pairing-token', url: 'https://ok.example' }, 'pairing');
    expect(fileLines).toHaveLength(1);
    expect(fileLines[0]).not.toContain('super-secret-pairing-token');
    expect(fileLines[0]).toContain('[REDACTED]');
    const row = store.snapshot().logs[0]!;
    expect(row.msg).toBe('pairing');
    expect(row.fields).toContain('token=[REDACTED]');
    expect(row.fields).toContain('url=https://ok.example');
  });

  it('keeps non-JSON lines verbatim instead of dropping operator-visible output', () => {
    const row = parseLogLine('something printed raw', 123)!;
    expect(row).toMatchObject({ at: 123, level: 30, msg: 'something printed raw', fields: '' });
    expect(parseLogLine('   ', 123)).toBeNull();
  });
});

describe('buildConfigEntries', () => {
  it('reports every agent env var with effective value and provenance', () => {
    const env = {
      AGENT_GATEWAY_URL: 'ws://127.0.0.1:3000/agent/ws',
      AGENT_NAME: 'laptop',
      HOME: '/home/u',
    };
    const entries = buildConfigEntries(loadAgentConfig(env, 'linux'), env);
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get('AGENT_GATEWAY_URL')).toMatchObject({ value: 'ws://127.0.0.1:3000/agent/ws', source: 'env' });
    expect(byKey.get('AGENT_NAME')).toMatchObject({ value: 'laptop', source: 'env' });
    expect(byKey.get('AGENT_SITE_PROFILES')).toMatchObject({
      value: 'ebay.ca.v1,kijiji.ca.v1,zazzle.com.v1,wardrobe-vendors.v1',
      source: 'default',
    });
    expect(byKey.get('AGENT_TASK_NAME')).toMatchObject({ value: DEFAULT_LOGON_TASK_NAME, source: 'default' });
    expect(byKey.get('AGENT_UI_GLYPHS')).toMatchObject({ value: 'auto', source: 'default' });
    expect(byKey.get('AGENT_PROFILE_DIR')?.source).toBe('default');
    expect(byKey.get('AGENT_PROFILE_DIR')?.value).toContain('ebay-research');
    // No secret-bearing keys exist in the agent schema; the screen shows
    // exactly the schema, nothing scraped from the wider environment.
    expect([...byKey.keys()].every((key) => key.startsWith('AGENT_') || key === 'LOG_LEVEL' || key === 'EBAY_DESTINATION_POSTAL_CODE')).toBe(true);
    expect(byKey.has('HOME')).toBe(false);
  });
});

describe('queryLogonTask', () => {
  it('is unsupported off Windows without spawning anything', async () => {
    let spawned = 0;
    const status = await queryLogonTask('X', {
      platform: 'linux',
      runner: () => {
        spawned += 1;
        return Promise.resolve('null');
      },
    });
    expect(status).toMatchObject({ supported: false, installed: false, error: null });
    expect(spawned).toBe(0);
  });

  it('parses installed state and escapes quotes in the task name', async () => {
    let script = '';
    const status = await queryLogonTask("O'Brien Task", {
      platform: 'win32',
      runner: (s) => {
        script = s;
        return Promise.resolve('{"state":"Ready","lastTaskResult":267009}');
      },
    });
    expect(script).toContain("'O''Brien Task'");
    expect(status).toMatchObject({ supported: true, installed: true, state: 'Ready', lastTaskResult: 267009 });
  });

  it('maps "null" to not-installed and a probe failure to an error, never a throw', async () => {
    const missing = await queryLogonTask('X', { platform: 'win32', runner: () => Promise.resolve('null') });
    expect(missing).toMatchObject({ supported: true, installed: false, error: null });
    const failed = await queryLogonTask('X', {
      platform: 'win32',
      runner: () => Promise.reject(new Error('powershell not found')),
    });
    expect(failed).toMatchObject({ supported: true, installed: false, error: 'powershell not found' });
  });
});

describe('resolveUiMode / detectCharset / detectColorMode', () => {
  it('dashboards only on a real console and honors --no-ui and TERM=dumb', () => {
    const none = new Map<string, string>();
    expect(resolveUiMode(none, true, {})).toBe('dashboard');
    expect(resolveUiMode(none, false, {})).toBe('plain');
    expect(resolveUiMode(new Map([['no-ui', 'true']]), true, {})).toBe('plain');
    expect(resolveUiMode(none, true, { TERM: 'dumb' })).toBe('plain');
  });

  it('uses ASCII on bare win32 conhost, unicode when the terminal declares itself', () => {
    expect(detectCharset({}, 'win32').dotOk).toBe('*');
    expect(detectCharset({ WT_SESSION: '1' }, 'win32').dotOk).toBe('●');
    expect(detectCharset({}, 'linux').dotOk).toBe('●');
    // A PowerShell 6+ host switches the console to UTF-8 and marks its
    // children, so pwsh-in-conhost still gets the full glyph set.
    expect(detectCharset({ POWERSHELL_DISTRIBUTION_CHANNEL: 'MSI:Windows' }, 'win32').dotOk).toBe('●');
  });

  it('marker-less windows (the logon task) go by the default-terminal setting; AGENT_UI_GLYPHS wins', () => {
    // Start-ScheduledTask launches node.exe with no terminal env markers.
    expect(detectCharset({}, 'win32', { defaultTerminal: 'modern' }).dotOk).toBe('●');
    expect(detectCharset({}, 'win32', { defaultTerminal: 'legacy' }).dotOk).toBe('*');
    expect(detectCharset({}, 'win32', { preference: 'unicode', defaultTerminal: 'legacy' }).dotOk).toBe('●');
    expect(detectCharset({ WT_SESSION: '1' }, 'win32', { preference: 'ascii' }).dotOk).toBe('*');
  });

  it('classifies the DelegationTerminal registry value like the OS does', () => {
    const WT = 'HKEY_CURRENT_USER\\Console\\%%Startup\n    DelegationTerminal    REG_SZ    {E12CFF52-A866-4C77-9A90-F570A7AA2C6B}\n';
    const CONHOST = 'DelegationTerminal    REG_SZ    {B23D10C0-E52E-411E-9D5B-C09FDF709C7D}';
    const DECIDE = 'DelegationTerminal    REG_SZ    {00000000-0000-0000-0000-000000000000}';
    const probe = (readRegistry: () => string | null, osBuild: number) =>
      queryDefaultTerminal({ platform: 'win32', readRegistry, osBuild });
    expect(probe(() => WT, 19_045)).toBe('modern');
    expect(probe(() => CONHOST, 26_100)).toBe('legacy');
    // "Let Windows decide" (or no value at all) means Terminal only from
    // Windows 11 22H2 on.
    expect(probe(() => DECIDE, 26_100)).toBe('modern');
    expect(probe(() => DECIDE, 19_045)).toBe('legacy');
    expect(probe(() => null, 22_621)).toBe('modern');
    expect(probe(() => null, 19_045)).toBe('legacy');
    expect(queryDefaultTerminal({ platform: 'linux' })).toBe('unknown');
  });

  it('picks truecolor where assured, 16-color otherwise, none under NO_COLOR', () => {
    expect(detectColorMode({}, 'win32')).toBe('truecolor');
    expect(detectColorMode({ WT_SESSION: '1' }, 'win32')).toBe('truecolor');
    expect(detectColorMode({ COLORTERM: 'truecolor' }, 'linux')).toBe('truecolor');
    expect(detectColorMode({ TERM: 'xterm-256color' }, 'linux')).toBe('basic');
    expect(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }, 'linux')).toBe('none');
  });
});

describe('meter / sparkline', () => {
  it('renders sub-cell resolution with a stable plain-text width', () => {
    const half = meter(10, 0.55, CHARSET, 'none');
    expect(half.text).toHaveLength(10);
    expect(half.text).toContain('█');
    const empty = meter(10, 0, CHARSET, 'none');
    expect(empty.text).toBe('·'.repeat(10));
    const fullBar = meter(10, 1, CHARSET, 'none');
    expect(fullBar.text).toBe('█'.repeat(10));
    // Painted form must cover exactly the same columns as the plain text.
    const painted = meter(10, 0.4, CHARSET, 'truecolor');
    expect(stripAnsi(painted.painted!)).toBe(painted.text);
  });

  it('scales sparkline levels to the peak bucket and pads short history', () => {
    const spark = sparkline([0, 1, 2, 8], 6, CHARSET, 'none');
    expect(spark.text).toHaveLength(6);
    expect(spark.text.endsWith('█')).toBe(true);
    const paintedSpark = sparkline([0, 3, 9], 5, CHARSET, 'truecolor');
    expect(stripAnsi(paintedSpark.painted!)).toBe(paintedSpark.text);
  });
});

describe('interpretKey', () => {
  it('maps htop-style keys, VT arrow sequences, and raw-mode Ctrl+C', () => {
    expect(interpretKey('q')).toBe('quit');
    expect(interpretKey('\u0003')).toBe('quit');
    expect(interpretKey('p')).toBe('pause');
    expect(interpretKey('\u001b[A')).toBe('scroll-up');
    expect(interpretKey('\u001b[B')).toBe('scroll-down');
    expect(interpretKey('\u001b[5~')).toBe('page-up');
    expect(interpretKey('l')).toBe('cycle-level');
    expect(interpretKey('e')).toBe('toggle-config');
    expect(interpretKey('t')).toBe('refresh-task');
    expect(interpretKey('?')).toBe('toggle-help');
    expect(interpretKey('z')).toBeNull();
  });
});

const CHARSET = detectCharset({}, 'linux');

function render(
  store: AgentStatusStore,
  view: ViewState = initialViewState(),
  columns = 100,
  rows = 30,
  colorMode: ColorMode = 'none',
) {
  return renderDashboard(store.snapshot(), view, {
    columns,
    rows,
    colorMode,
    charset: CHARSET,
    now: 1_060_000,
  });
}

function populatedStore(): AgentStatusStore {
  const env = { AGENT_GATEWAY_URL: 'ws://127.0.0.1:3000/agent/ws' };
  const store = new AgentStatusStore({
    info: testInfo(),
    config: buildConfigEntries(loadAgentConfig(env, 'linux'), env),
    now: () => 1_060_000,
  });
  store.connectionReady('conn_abc');
  store.gatewayActivity();
  store.sessionOpened('bs_9', 'ebay-research');
  store.updateTabs([{ tabId: 't1', url: 'https://www.ebay.ca/sch/i.html?_nkw=lego', title: 'lego | eBay', active: true }]);
  store.commandStarted('req_run', 'browser_extract_many');
  store.commandStarted('req_ok', 'browser_navigate');
  store.commandFinished('req_ok', 'ok', 812, null);
  store.updateJobs([{ jobId: 'job_1', status: 'running', requested: 25, completed: 12, failed: 1, startedAt: 1_050_000 }]);
  store.recordLogLine('{"level":40,"time":1059000,"msg":"Popup denied by URL policy","url":"https://evil.example"}');
  store.updateTaskStatus({
    supported: true,
    installed: true,
    state: 'Ready',
    lastTaskResult: 0,
    checkedAt: 1_059_000,
    error: null,
  } satisfies LogonTaskStatus);
  return store;
}

describe('renderDashboard', () => {
  it('always emits exactly `rows` lines and never exceeds `columns`', () => {
    const store = populatedStore();
    for (const [columns, rows] of [[100, 30], [80, 24], [45, 12], [200, 60]] as const) {
      const result = render(store, initialViewState(), columns, rows);
      expect(result.lines).toHaveLength(rows);
      for (const line of result.lines) expect(line.length).toBeLessThanOrEqual(columns);
    }
  });

  it('keeps the same geometry in truecolor and basic modes (ANSI stripped)', () => {
    const store = populatedStore();
    for (const mode of ['truecolor', 'basic'] as const) {
      const result = render(store, initialViewState(), 100, 30, mode);
      expect(result.lines).toHaveLength(30);
      for (const line of result.lines) {
        const visible = stripAnsi(line);
        expect(visible.length).toBeLessThanOrEqual(100);
      }
      // Framed rows stay perfectly rectangular once codes are stripped.
      const framed = result.lines.filter((line) => stripAnsi(line).startsWith('│'));
      expect(framed.length).toBeGreaterThan(5);
      for (const line of framed) expect(stripAnsi(line)).toHaveLength(100);
    }
  });

  it('shows connection, session, task, activity, commands, and log content', () => {
    const text = render(populatedStore()).lines.join('\n');
    expect(text).toContain('CONNECTED');
    expect(text).toContain('conn_abc');
    expect(text).toContain('READY');
    expect(text).toContain('ebay-research');
    expect(text).toContain('_nkw=lego');
    expect(text).toContain('installed');
    expect(text).toContain('this run: interactive window');
    expect(text).toContain('browser_navigate');
    expect(text).toContain('812ms');
    expect(text).toContain('running');
    expect(text).toContain('job_1');
    expect(text).toContain('12/25');
    expect(text).toContain('WRN');
    expect(text).toContain('Popup denied by URL policy');
    expect(text).toContain('q quit');
  });

  it('labels a logon-task instance and a missing task distinctly', () => {
    const background = new AgentStatusStore({ info: testInfo({ launchedBy: 'logon-task' }), now: () => 1_060_000 });
    background.updateTaskStatus({ supported: true, installed: false, state: null, lastTaskResult: null, checkedAt: 1, error: null });
    const text = render(background).lines.join('\n');
    expect(text).toContain('background (logon task)');
    expect(text).toContain('not installed');
    const nonWindows = testStore();
    nonWindows.updateTaskStatus({ supported: false, installed: false, state: null, lastTaskResult: null, checkedAt: 1, error: null });
    expect(render(nonWindows).lines.join('\n')).toContain('n/a on this OS');
  });

  it('config screen lists env entries with provenance; help screen lists keys', () => {
    const env = { AGENT_GATEWAY_URL: 'ws://127.0.0.1:3000/agent/ws' };
    const store = new AgentStatusStore({
      info: testInfo(),
      config: buildConfigEntries(loadAgentConfig(env, 'linux'), env),
      now: () => 1_060_000,
    });
    const config = render(store, { ...initialViewState(), screen: 'config' }).lines.join('\n');
    expect(config).toContain('CONFIG');
    expect(config).toContain('AGENT_GATEWAY_URL');
    expect(config).toMatch(/AGENT_GATEWAY_URL\s+env/);
    expect(config).toMatch(/AGENT_SITE_PROFILES\s+def/);
    // The rotating JSON log's location is a config-screen fact, not an env var.
    expect(config).toMatch(/log file\s+run\s+\/tmp\/agent-run\.ndjson/);
    const help = render(store, { ...initialViewState(), screen: 'help' }).lines.join('\n');
    expect(help).toContain('KEYS');
    expect(help).toContain('graceful shutdown');
  });

  it('filters the log tail by level and reports scrollback headroom', () => {
    const store = testStore();
    for (let i = 0; i < 50; i++) store.recordLogLine(`{"level":30,"time":1,"msg":"info ${i}"}`);
    store.recordLogLine('{"level":50,"time":1,"msg":"the failure"}');
    const errorsOnly = render(store, { ...initialViewState(), minLevel: 50 });
    const text = errorsOnly.lines.join('\n');
    expect(text).toContain('the failure');
    expect(text).not.toContain('info 49');
    expect(errorsOnly.maxLogScroll).toBe(0);
    const all = render(store, initialViewState());
    expect(all.maxLogScroll).toBeGreaterThan(0);
  });

  it('degrades to a notice when the terminal is too small', () => {
    const result = render(populatedStore(), initialViewState(), 30, 8);
    expect(result.lines).toHaveLength(8);
    expect(result.lines[0]).toContain('terminal too small');
  });
});

describe('BatchJobStore.snapshotJobs', () => {
  it('summarizes counts without payloads, running jobs first', () => {
    let at = 1000;
    const store = new BatchJobStore({ retentionMs: 60_000, now: () => at });
    const done = store.create('bs_1', 2, true);
    store.append(done.jobId, {
      url: 'https://a',
      finalUrl: 'https://a',
      ok: true,
      siteProfile: 'ebay.ca.v1',
      pageRevision: 1,
      record: { big: 'payload' },
      warnings: [],
      error: null,
    });
    store.append(done.jobId, {
      url: 'https://b',
      finalUrl: null,
      ok: false,
      siteProfile: null,
      pageRevision: null,
      record: null,
      warnings: [],
      error: { code: 'NAV_TIMEOUT', message: 'x', retryable: true },
    });
    store.finish(done.jobId, 'partial');
    at = 2000;
    const running = store.create('bs_1', 10, true);
    const rows = store.snapshotJobs();
    expect(rows.map((row) => row.jobId)).toEqual([running.jobId, done.jobId]);
    expect(rows[1]).toMatchObject({ status: 'partial', requested: 2, completed: 2, failed: 1 });
    expect(JSON.stringify(rows)).not.toContain('payload');
  });
});

interface FakeOutput {
  written: string[];
  columns: number;
  rows: number;
  write(chunk: string): void;
  on(): void;
  off(): void;
}

function fakeOutput(): FakeOutput {
  return {
    written: [],
    columns: 100,
    rows: 30,
    write(chunk: string) {
      this.written.push(chunk);
    },
    on() {},
    off() {},
  };
}

function fakeInput() {
  const listeners = new Set<(data: string) => void>();
  return {
    isTTY: true,
    raw: null as boolean | null,
    setRawMode(mode: boolean) {
      this.raw = mode;
    },
    setEncoding() {},
    on(_event: 'data', listener: (data: string) => void) {
      listeners.add(listener);
    },
    off(_event: 'data', listener: (data: string) => void) {
      listeners.delete(listener);
    },
    resume() {},
    pause() {},
    press(data: string) {
      for (const listener of listeners) listener(data);
    },
  };
}

describe('AgentTui', () => {
  it('enters the alternate screen, renders, dispatches keys, and restores on stop', () => {
    const store = populatedStore();
    const output = fakeOutput();
    const input = fakeInput();
    let quits = 0;
    let refreshes = 0;
    const tui = new AgentTui({
      store,
      onQuit: () => {
        quits += 1;
      },
      onRefreshTask: () => {
        refreshes += 1;
      },
      output,
      input,
      colorMode: 'none',
      charset: CHARSET,
    });
    tui.start();
    expect(input.raw).toBe(true);
    const first = output.written.join('');
    expect(first).toContain('\u001b[?1049h');
    expect(first).toContain('CONNECTED');

    input.press('e');
    expect(output.written.join('')).toContain('AGENT_GATEWAY_URL');
    input.press('e');
    input.press('t');
    expect(refreshes).toBe(1);
    input.press('p');
    expect(output.written.join('')).toContain('p resume');

    // Quit is dispatched once even if mashed; shutdown owns the exit.
    input.press('q');
    input.press('q');
    input.press('\u0003');
    expect(quits).toBe(1);

    tui.stop();
    expect(input.raw).toBe(false);
    expect(output.written.join('')).toContain('\u001b[?1049l');
    // Store events after stop must not paint over the restored terminal.
    const writesAfterStop = output.written.length;
    store.commandStarted('req_late', 'browser_click');
    expect(output.written.length).toBe(writesAfterStop);
  });
});
