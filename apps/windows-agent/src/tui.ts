/**
 * Console dashboard for `cli.js run` — the htop-style face of the agent's
 * node.exe window on the Windows desktop.
 *
 * Rendering is deliberately hand-rolled VT100 with zero dependencies: the
 * agent is the security-sensitive half of the bridge, and a TUI framework
 * (with its transitive tree) is a poor trade for ~one screen of layout
 * code. Node enables Windows' virtual-terminal mode on TTY stdout, so the
 * same escape sequences work in Windows Terminal, conhost, and any POSIX
 * terminal; on a bare legacy conhost (no WT_SESSION) box-drawing falls back
 * to ASCII because the console's non-UTF-8 codepage would garble it.
 *
 * The split that keeps this testable: renderDashboard() is a pure function
 * of (snapshot, view, size) returning exactly `rows` strings, and AgentTui
 * owns only terminal plumbing — raw mode, the alternate screen buffer,
 * repaint scheduling, and key dispatch. Tests drive both with fakes.
 */
import type {
  AgentStatusSnapshot,
  AgentStatusStore,
  CommandRow,
  LogRow,
} from './monitor.js';

// ---------------------------------------------------------------------------
// Mode + capability detection

export type UiMode = 'dashboard' | 'plain';

/**
 * Dashboard on a real console; today's plain pino JSON everywhere else.
 * Piped/headless output (CI, redirects, the harness) must stay
 * line-oriented JSON, and --no-ui forces that even on a console.
 */
export function resolveUiMode(
  flags: ReadonlyMap<string, string>,
  stdoutIsTty: boolean,
  env: Record<string, string | undefined> = process.env,
): UiMode {
  if (flags.has('no-ui')) return 'plain';
  if (!stdoutIsTty) return 'plain';
  if (env.TERM === 'dumb') return 'plain';
  return 'dashboard';
}

export interface Charset {
  hline: string;
  bar: string;
  dotOk: string;
  dotBad: string;
  dotWait: string;
  arrow: string;
  ellipsis: string;
  fill: string;
  empty: string;
}

const UNICODE_CHARSET: Charset = {
  hline: '─',
  bar: '│',
  dotOk: '●',
  dotBad: '●',
  dotWait: '◌',
  arrow: '▸',
  ellipsis: '…',
  fill: '■',
  empty: '·',
};

const ASCII_CHARSET: Charset = {
  hline: '-',
  bar: '|',
  dotOk: '*',
  dotBad: 'x',
  dotWait: 'o',
  arrow: '>',
  ellipsis: '~',
  fill: '#',
  empty: '.',
};

/**
 * Legacy conhost renders UTF-8 through whatever OEM codepage is active, so
 * only terminals that declare themselves (Windows Terminal, VS Code,
 * ConEmu) get the unicode glyphs on win32. Everything non-Windows does.
 */
export function detectCharset(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Charset {
  if (platform !== 'win32') return UNICODE_CHARSET;
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined || env.ConEmuANSI === 'ON') {
    return UNICODE_CHARSET;
  }
  return ASCII_CHARSET;
}

// ---------------------------------------------------------------------------
// Styling: layout is computed on plain strings; SGR codes wrap whole cells
// afterwards so column math never has to skip escape sequences.

export type Style =
  | 'title'
  | 'good'
  | 'bad'
  | 'warnc'
  | 'dim'
  | 'accent'
  | 'bold'
  | 'invert';

const SGR: Record<Style, string> = {
  title: '1;36',
  good: '32',
  bad: '31',
  warnc: '33',
  dim: '2',
  accent: '36',
  bold: '1',
  invert: '7',
};

export interface Segment {
  text: string;
  style?: Style;
}

function paint(segment: Segment, colors: boolean): string {
  if (!colors || segment.style === undefined || segment.text.length === 0) return segment.text;
  return `\u001b[${SGR[segment.style]}m${segment.text}\u001b[0m`;
}

function clip(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return ellipsis;
  return text.slice(0, width - 1) + ellipsis;
}

/** Compose one screen line from cells, hard-capped at `width` columns. */
function line(width: number, colors: boolean, charset: Charset, ...segments: Segment[]): string {
  let used = 0;
  let out = '';
  for (const segment of segments) {
    if (used >= width) break;
    const text = clip(segment.text, width - used, charset.ellipsis);
    used += text.length;
    out += paint({ text, ...(segment.style === undefined ? {} : { style: segment.style }) }, colors);
  }
  return out;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

// ---------------------------------------------------------------------------
// Small formatters

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatClock(atMs: number): string {
  const d = new Date(atMs);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${two(h)}:${two(m)}:${two(s)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${two(Math.round((ms % 60_000) / 1000))}s`;
}

export function formatAge(ms: number): string {
  if (ms < 1000) return 'now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/** htop-style meter: label [#####....] caption */
function meter(width: number, ratio: number, charset: Charset): string {
  const inner = Math.max(1, width - 2);
  const filled = Math.max(0, Math.min(inner, Math.round(ratio * inner)));
  return `[${charset.fill.repeat(filled)}${charset.empty.repeat(inner - filled)}]`;
}

const LEVELS: Array<{ min: number; label: string; style: Style }> = [
  { min: 60, label: 'FTL', style: 'bad' },
  { min: 50, label: 'ERR', style: 'bad' },
  { min: 40, label: 'WRN', style: 'warnc' },
  { min: 30, label: 'INF', style: 'good' },
  { min: 20, label: 'DBG', style: 'accent' },
  { min: 0, label: 'TRC', style: 'dim' },
];

function levelBadge(level: number): { label: string; style: Style } {
  for (const entry of LEVELS) {
    if (level >= entry.min) return { label: entry.label, style: entry.style };
  }
  return { label: 'TRC', style: 'dim' };
}

/** Cycle order for the [l] key; labels match pino's level names. */
export const LEVEL_FILTER_CYCLE: Array<{ value: number; label: string }> = [
  { value: 10, label: 'trace' },
  { value: 20, label: 'debug' },
  { value: 30, label: 'info' },
  { value: 40, label: 'warn' },
  { value: 50, label: 'error' },
];

// ---------------------------------------------------------------------------
// View state + key handling

export type Screen = 'main' | 'config' | 'help';

export interface ViewState {
  screen: Screen;
  paused: boolean;
  /** Log lines scrolled back from the live tail; 0 follows. */
  logScroll: number;
  /** Minimum pino level shown in the log pane. */
  minLevel: number;
}

export function initialViewState(): ViewState {
  return { screen: 'main', paused: false, logScroll: 0, minLevel: 30 };
}

export type UiAction =
  | 'quit'
  | 'pause'
  | 'scroll-up'
  | 'scroll-down'
  | 'page-up'
  | 'page-down'
  | 'follow'
  | 'cycle-level'
  | 'clear'
  | 'toggle-config'
  | 'toggle-help'
  | 'refresh-task'
  | 'repaint';

/**
 * Raw-mode bytes → action. Arrow/page keys arrive as VT sequences on every
 * platform (libuv translates Windows console input records). Ctrl+C is a
 * literal 0x03 in raw mode, so quit handles it here rather than via SIGINT.
 */
export function interpretKey(data: string): UiAction | null {
  switch (data) {
    case 'q':
    case 'Q':
    case '\u0003':
      return 'quit';
    case 'p':
    case 'P':
      return 'pause';
    case 'k':
    case '\u001b[A':
      return 'scroll-up';
    case 'j':
    case '\u001b[B':
      return 'scroll-down';
    case '\u001b[5~':
      return 'page-up';
    case '\u001b[6~':
      return 'page-down';
    case 'f':
    case 'F':
    case '\u001b[F':
    case '\u001b[4~':
      return 'follow';
    case 'l':
    case 'L':
      return 'cycle-level';
    case 'c':
    case 'C':
      return 'clear';
    case 'e':
    case 'E':
      return 'toggle-config';
    case '?':
    case 'h':
      return 'toggle-help';
    case 't':
    case 'T':
      return 'refresh-task';
    case 'r':
    case 'R':
      return 'repaint';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Pure renderer

export interface RenderOptions {
  columns: number;
  rows: number;
  colors: boolean;
  charset: Charset;
  now: number;
}

export interface RenderResult {
  lines: string[];
  /** Largest useful logScroll for the current pane height; clamps the view. */
  maxLogScroll: number;
}

const MIN_COLUMNS = 40;
const MIN_ROWS = 10;

function phaseSegment(snapshot: AgentStatusSnapshot, charset: Charset): Segment[] {
  switch (snapshot.phase) {
    case 'connected':
      return [
        { text: `${charset.dotOk} CONNECTED`, style: 'good' },
        { text: `  ${snapshot.connectionId ?? ''}`, style: 'dim' },
      ];
    case 'connecting':
      return [{ text: `${charset.dotWait} CONNECTING`, style: 'warnc' }];
    case 'waiting':
      return [
        {
          text: `${charset.dotWait} RETRYING${snapshot.retryDelayMs === null ? '' : ` in ${formatDuration(snapshot.retryDelayMs)}`}`,
          style: 'warnc',
        },
      ];
    case 'stopped':
      return [{ text: `${charset.dotBad} STOPPED`, style: 'bad' }];
    case 'idle':
      return [{ text: `${charset.dotWait} STARTING`, style: 'dim' }];
  }
}

function taskLineSegments(snapshot: AgentStatusSnapshot): Segment[] {
  const runAs: Segment =
    snapshot.info.launchedBy === 'logon-task'
      ? { text: 'this run: background (logon task)', style: 'accent' }
      : { text: 'this run: interactive window', style: 'dim' };
  const task = snapshot.task;
  if (task === null) {
    return [{ text: 'checking Task Scheduler', style: 'dim' }, { text: '   ' }, runAs];
  }
  if (!task.supported) {
    return [{ text: 'n/a on this OS (Windows-only)', style: 'dim' }, { text: '   ' }, runAs];
  }
  if (task.error !== null) {
    return [{ text: 'status unavailable', style: 'warnc' }, { text: `  ${task.error}`, style: 'dim' }];
  }
  if (!task.installed) {
    return [
      { text: 'not installed', style: 'warnc' },
      { text: '   ' },
      runAs,
      { text: '   (scripts\\windows\\install-logon-task.ps1)', style: 'dim' },
    ];
  }
  const state = task.state ?? 'unknown';
  const stateStyle: Style = state === 'Running' ? 'good' : state === 'Disabled' ? 'bad' : 'accent';
  const segments: Segment[] = [
    { text: 'installed', style: 'good' },
    { text: ' ' },
    { text: state, style: stateStyle },
  ];
  if (task.lastTaskResult !== null && task.lastTaskResult !== 0 && task.lastTaskResult !== 267009) {
    // 267009 (0x41301) just means "currently running"; anything else nonzero
    // is a real last-run failure worth surfacing.
    segments.push({ text: `  last result 0x${task.lastTaskResult.toString(16)}`, style: 'bad' });
  }
  segments.push({ text: '   ' }, runAs);
  return segments;
}

function commandRowSegments(row: CommandRow, charset: Charset): Segment[] {
  const at = formatClock(row.startedAt);
  const name = pad(row.command, 26);
  if (row.status === 'running') {
    return [
      { text: ` ${at}  ` },
      { text: name },
      { text: `${charset.dotWait} running`, style: 'warnc' },
      { text: `  ${row.requestId}`, style: 'dim' },
    ];
  }
  const dur = pad(row.durationMs === null ? '' : formatDuration(row.durationMs), 8);
  if (row.status === 'ok') {
    return [
      { text: ` ${at}  ` },
      { text: name },
      { text: `${charset.dotOk} ok     `, style: 'good' },
      { text: ` ${dur}` },
      { text: ` ${row.requestId}`, style: 'dim' },
    ];
  }
  return [
    { text: ` ${at}  ` },
    { text: name },
    { text: `${charset.dotBad} ${row.errorCode ?? 'error'}`, style: 'bad' },
    { text: `  ${dur}` },
    { text: ` ${row.requestId}`, style: 'dim' },
  ];
}

function logRowSegments(row: LogRow): Segment[] {
  const badge = levelBadge(row.level);
  return [
    { text: ` ${formatClock(row.at)} `, style: 'dim' },
    { text: badge.label, style: badge.style },
    { text: `  ${row.msg}` },
    { text: row.fields.length > 0 ? `  ${row.fields}` : '', style: 'dim' },
  ];
}

const HELP_ROWS: Array<[string, string]> = [
  ['q  Ctrl+C', 'quit the agent (graceful shutdown)'],
  ['p', 'pause/resume the live log tail'],
  ['Up/Down  j/k', 'scroll the log tail (PgUp/PgDn for pages)'],
  ['f  End', 'jump back to the live tail'],
  ['l', 'cycle the minimum log level shown'],
  ['c', 'clear command history and counters'],
  ['e', 'toggle the config/environment screen'],
  ['t', 're-check the Windows logon task now'],
  ['r', 'force a full repaint'],
  ['?  h', 'toggle this help'],
];

export function renderDashboard(
  snapshot: AgentStatusSnapshot,
  view: ViewState,
  options: RenderOptions,
): RenderResult {
  const { columns, rows, colors, charset, now } = options;
  const L = (...segments: Segment[]): string => line(columns, colors, charset, ...segments);

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const lines = [L({ text: `terminal too small (${columns}x${rows}, need ${MIN_COLUMNS}x${MIN_ROWS})`, style: 'warnc' })];
    while (lines.length < rows) lines.push('');
    return { lines: lines.slice(0, rows), maxLogScroll: 0 };
  }

  const sep = L({ text: charset.hline.repeat(columns), style: 'dim' });
  const out: string[] = [];

  // Title bar
  const mem = process.memoryUsage.rss();
  const memText = `${Math.round(mem / (1024 * 1024))}M`;
  const left = ` BROWSER BRIDGE AGENT v${snapshot.info.version}`;
  const right = `up ${formatUptime(now - snapshot.info.startedAt)}  mem ${meter(12, Math.min(1, mem / (512 * 1024 * 1024)), charset)} ${memText}  pid ${snapshot.info.pid} `;
  const gapWidth = Math.max(1, columns - left.length - right.length);
  out.push(L({ text: left, style: 'title' }, { text: ' '.repeat(gapWidth) }, { text: right, style: 'dim' }));
  out.push(sep);

  // Status block
  const hbAge =
    snapshot.lastGatewayActivityAt === null ? null : Math.max(0, now - snapshot.lastGatewayActivityAt);
  out.push(
    L(
      { text: ' Gateway  ', style: 'bold' },
      ...phaseSegment(snapshot, charset),
      { text: `  ${snapshot.info.gatewayWsUrl}`, style: 'dim' },
      { text: hbAge === null ? '' : `  rx ${formatAge(hbAge)} ago` },
      { text: snapshot.reconnects > 0 ? `  reconnects ${snapshot.reconnects}` : '', style: 'dim' },
    ),
  );
  out.push(
    L(
      { text: ' Device   ', style: 'bold' },
      { text: `${snapshot.info.agentName}  ` },
      { text: `${snapshot.info.deviceId}  `, style: 'dim' },
      { text: `key ${snapshot.info.keyStoreKind}  `, style: 'dim' },
      { text: `profiles ${snapshot.info.siteProfiles.join(',')}`, style: 'dim' },
    ),
  );
  out.push(L({ text: ' Task     ', style: 'bold' }, ...taskLineSegments(snapshot)));

  const session = snapshot.session;
  if (session === null) {
    out.push(
      L(
        { text: ' Browser  ', style: 'bold' },
        { text: 'no session', style: 'dim' },
        { text: '  (opens on the first browser.session_open)', style: 'dim' },
      ),
    );
  } else {
    out.push(
      L(
        { text: ' Browser  ', style: 'bold' },
        session.degraded
          ? { text: `${charset.dotBad} DEGRADED`, style: 'bad' }
          : { text: `${charset.dotOk} READY`, style: 'good' },
        { text: `  profile ${session.profileName}` },
        { text: `  ${session.handle}`, style: 'dim' },
        { text: `  tabs ${session.tabs.length}` },
      ),
    );
    for (const tab of session.tabs.slice(0, 3)) {
      out.push(
        L(
          { text: `   ${charset.arrow} `, style: tab.active ? 'accent' : 'dim' },
          { text: tab.url, style: tab.active ? undefined : 'dim' },
          { text: tab.title.length > 0 ? `  ${charset.hline} ${tab.title}` : '', style: 'dim' },
        ),
      );
    }
  }

  for (const job of snapshot.jobs.slice(0, 2)) {
    const ratio = job.requested === 0 ? 1 : job.completed / job.requested;
    out.push(
      L(
        { text: `   ${job.jobId} `, style: 'dim' },
        { text: meter(22, ratio, charset), style: job.status === 'running' ? 'warnc' : 'good' },
        { text: ` ${job.completed}/${job.requested} ${job.status}` },
        { text: job.failed > 0 ? `  failed ${job.failed}` : '', style: 'bad' },
      ),
    );
  }

  const policyTotal =
    snapshot.policy.request_aborted + snapshot.policy.popup_denied + snapshot.policy.download_blocked;
  out.push(
    L(
      { text: ' Activity ', style: 'bold' },
      { text: `${meter(22, Math.min(1, snapshot.commandsPerMinute / 30), charset)} ${snapshot.commandsPerMinute}/min`, style: 'accent' },
      { text: `   ok ${snapshot.totals.ok}`, style: 'good' },
      { text: `  err ${snapshot.totals.error}`, style: snapshot.totals.error > 0 ? 'bad' : 'dim' },
      { text: `  policy ${policyTotal}`, style: policyTotal > 0 ? 'warnc' : 'dim' },
      { text: `  in-flight ${snapshot.inFlight}` },
    ),
  );
  out.push(sep);

  // Footer assembled first so the flexible region knows its budget.
  const levelLabel = LEVEL_FILTER_CYCLE.find((e) => e.value === view.minLevel)?.label ?? 'info';
  const following = !view.paused && view.logScroll === 0;
  const footer = L({
    text: ` q quit  p ${view.paused ? 'resume' : 'pause'}  j/k scroll  f follow  l level:${levelLabel}  c clear  e config  t task  ? help  ${following ? '' : '[log tail frozen]'}`,
    style: 'invert',
  });

  const bodyRows = rows - out.length - 1;
  let maxLogScroll = 0;

  if (view.screen === 'help') {
    out.push(L({ text: ' KEYS', style: 'title' }));
    for (const [key, desc] of HELP_ROWS.slice(0, Math.max(0, bodyRows - 1))) {
      out.push(L({ text: `   ${pad(key, 14)}`, style: 'accent' }, { text: desc }));
    }
  } else if (view.screen === 'config') {
    out.push(L({ text: ' CONFIG', style: 'title' }, { text: '  effective agent environment (no secrets are read here)', style: 'dim' }));
    const keyWidth = Math.min(34, Math.max(12, ...snapshot.config.map((e) => e.key.length)) + 2);
    for (const entry of snapshot.config.slice(0, Math.max(0, bodyRows - 1))) {
      out.push(
        L(
          { text: `   ${pad(entry.key, keyWidth)}`, style: 'accent' },
          { text: pad(entry.source === 'env' ? 'env' : 'def', 5), style: entry.source === 'env' ? 'good' : 'dim' },
          { text: entry.value },
        ),
      );
    }
  } else {
    // Main screen: commands on top, logs below, logs get the larger share.
    const commandsRows = Math.max(3, Math.min(snapshot.commands.length + 1, Math.floor(bodyRows * 0.35)));
    const logsRows = bodyRows - commandsRows - 2;

    out.push(
      L(
        { text: ' COMMANDS', style: 'title' },
        { text: `  ${snapshot.commands.length} recent, newest first`, style: 'dim' },
      ),
    );
    const commandRows = snapshot.commands.slice(0, commandsRows - 1);
    for (const row of commandRows) out.push(L(...commandRowSegments(row, charset)));
    for (let i = commandRows.length; i < commandsRows - 1; i++) out.push('');
    out.push(sep);

    const filtered = snapshot.logs.filter((row) => row.level >= view.minLevel);
    maxLogScroll = Math.max(0, filtered.length - Math.max(1, logsRows - 1));
    const scroll = Math.min(view.logScroll, maxLogScroll);
    out.push(
      L(
        { text: ' LOGS', style: 'title' },
        { text: `  level>=${levelLabel}`, style: 'dim' },
        {
          text: following ? '  following' : scroll > 0 ? `  scrolled +${scroll}` : '  paused',
          style: following ? 'dim' : 'warnc',
        },
        { text: snapshot.info.logPath === null ? '' : `  file ${snapshot.info.logPath}`, style: 'dim' },
      ),
    );
    const visible = Math.max(1, logsRows - 1);
    const end = filtered.length - scroll;
    for (const row of filtered.slice(Math.max(0, end - visible), end)) {
      out.push(L(...logRowSegments(row)));
    }
  }

  while (out.length < rows - 1) out.push('');
  const lines = out.slice(0, rows - 1);
  lines.push(footer);
  return { lines, maxLogScroll };
}

// ---------------------------------------------------------------------------
// Terminal lifecycle

interface OutputLike {
  write(chunk: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

interface InputLike {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (data: string) => void): unknown;
  off?(event: 'data', listener: (data: string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
}

export interface AgentTuiOptions {
  store: AgentStatusStore;
  /** Invoked once when the operator quits; owns the actual shutdown. */
  onQuit: () => void;
  /** [t] key: kick an immediate Task Scheduler re-probe. */
  onRefreshTask?: () => void;
  output?: OutputLike;
  input?: InputLike;
  colors?: boolean;
  charset?: Charset;
  now?: () => number;
  /** Steady repaint cadence; keeps ages/uptime moving between events. */
  refreshMs?: number;
}

const ENTER_ALT = '\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H';
const LEAVE_ALT = '\u001b[0m\u001b[?25h\u001b[?1049l';

export class AgentTui {
  private readonly options: AgentTuiOptions;
  private readonly output: OutputLike;
  private readonly input: InputLike;
  private readonly colors: boolean;
  private readonly charset: Charset;
  private readonly now: () => number;
  private view: ViewState = initialViewState();
  private running = false;
  private quitRequested = false;
  private renderTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastMaxLogScroll = 0;
  private readonly onData = (data: string): void => this.handleInput(data);
  private readonly onResize = (): void => this.scheduleRender();
  private readonly onExit = (): void => this.restoreTerminal();

  constructor(options: AgentTuiOptions) {
    this.options = options;
    this.output = options.output ?? process.stdout;
    this.input = options.input ?? process.stdin;
    this.colors = options.colors ?? (process.env.NO_COLOR === undefined);
    this.charset = options.charset ?? detectCharset();
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.output.write(ENTER_ALT);
    if (this.input.isTTY === true) this.input.setRawMode?.(true);
    this.input.setEncoding?.('utf8');
    this.input.on('data', this.onData);
    this.input.resume?.();
    this.output.on?.('resize', this.onResize);
    // Belt and braces: whatever path the process exits by, the terminal is
    // handed back usable (cursor visible, main screen buffer).
    process.on('exit', this.onExit);
    this.unsubscribe = this.options.store.subscribe(() => this.scheduleRender());
    this.intervalTimer = setInterval(() => this.render(), this.options.refreshMs ?? 1000);
    this.intervalTimer.unref?.();
    this.render();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.renderTimer !== null) clearTimeout(this.renderTimer);
    this.renderTimer = null;
    if (this.intervalTimer !== null) clearInterval(this.intervalTimer);
    this.intervalTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.input.isTTY === true) this.input.setRawMode?.(false);
    this.input.off?.('data', this.onData);
    this.input.pause?.();
    this.output.off?.('resize', this.onResize);
    process.off('exit', this.onExit);
    this.restoreTerminal();
  }

  private restoreTerminal(): void {
    this.output.write(LEAVE_ALT);
  }

  /** Coalesce event bursts into one frame; 40 ms is imperceptible. */
  private scheduleRender(): void {
    if (!this.running || this.renderTimer !== null) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.render();
    }, 40);
    this.renderTimer.unref?.();
  }

  private render(): void {
    if (!this.running) return;
    // || not ??: a pty can momentarily report 0x0 (or leave the fields
    // unset), and a zero-height frame would render as a blank screen.
    const columns = this.output.columns || 80;
    const rows = this.output.rows || 24;
    const result = renderDashboard(this.options.store.snapshot(), this.view, {
      columns,
      rows,
      colors: this.colors,
      charset: this.charset,
      now: this.now(),
    });
    this.lastMaxLogScroll = result.maxLogScroll;
    if (this.view.logScroll > result.maxLogScroll) this.view.logScroll = result.maxLogScroll;
    // Home + line-by-line erase repaints without a full clear (no flicker),
    // and the trailing ED wipes anything a resize left below the frame.
    this.output.write(`\u001b[H${result.lines.join('\u001b[K\r\n')}\u001b[K\u001b[J`);
  }

  private handleInput(data: string): void {
    const action = interpretKey(data);
    if (action === null) return;
    switch (action) {
      case 'quit':
        if (!this.quitRequested) {
          this.quitRequested = true;
          this.options.onQuit();
        }
        return;
      case 'pause':
        this.view.paused = !this.view.paused;
        if (!this.view.paused) this.view.logScroll = 0;
        break;
      case 'scroll-up':
        this.view.logScroll = Math.min(this.view.logScroll + 1, this.lastMaxLogScroll);
        break;
      case 'scroll-down':
        this.view.logScroll = Math.max(0, this.view.logScroll - 1);
        break;
      case 'page-up':
        this.view.logScroll = Math.min(this.view.logScroll + 10, this.lastMaxLogScroll);
        break;
      case 'page-down':
        this.view.logScroll = Math.max(0, this.view.logScroll - 10);
        break;
      case 'follow':
        this.view.paused = false;
        this.view.logScroll = 0;
        break;
      case 'cycle-level': {
        const index = LEVEL_FILTER_CYCLE.findIndex((e) => e.value === this.view.minLevel);
        this.view.minLevel = LEVEL_FILTER_CYCLE[(index + 1) % LEVEL_FILTER_CYCLE.length]!.value;
        break;
      }
      case 'clear':
        this.options.store.clearHistory();
        break;
      case 'toggle-config':
        this.view.screen = this.view.screen === 'config' ? 'main' : 'config';
        break;
      case 'toggle-help':
        this.view.screen = this.view.screen === 'help' ? 'main' : 'help';
        break;
      case 'refresh-task':
        this.options.onRefreshTask?.();
        break;
      case 'repaint':
        this.output.write('\u001b[2J');
        break;
    }
    this.render();
  }
}
