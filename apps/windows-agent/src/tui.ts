/**
 * Console dashboard for `cli.js run` — the htop-style face of the agent's
 * node.exe window on the Windows desktop.
 *
 * Rendering is deliberately hand-rolled VT100 with zero dependencies: the
 * agent is the security-sensitive half of the bridge, and a TUI framework
 * (with its transitive tree) is a poor trade for ~one screen of layout
 * code. Node enables Windows' virtual-terminal mode on TTY stdout, so the
 * same escape sequences work in Windows Terminal, conhost, and any POSIX
 * terminal.
 *
 * Output adapts to what the terminal can actually show, detected once:
 * - glyphs: rounded panels, partial-block meters, sparklines, and braille
 *   spinners wherever the hosting terminal's font covers them — any
 *   non-Windows terminal, a declared one (Windows Terminal/VS Code/ConEmu,
 *   PowerShell 6+ marking its children), or a window with no env markers
 *   at all whose machine's default terminal is a modern host, which is
 *   what a Task-Scheduler-launched node.exe window is (detectCharset +
 *   queryDefaultTerminal). Classic conhost keeps the ASCII set.
 * - color: 24-bit truecolor on Windows consoles (conhost has supported RGB
 *   since well before the Win10 1809 floor Node 22 already requires) and
 *   wherever COLORTERM/WT_SESSION/ConEmu/VS Code says so; a 16-color
 *   fallback elsewhere; none under NO_COLOR.
 *
 * The split that keeps this testable: renderDashboard() is a pure function
 * of (snapshot, view, size) returning exactly `rows` strings, and AgentTui
 * owns only terminal plumbing — raw mode, the alternate screen buffer,
 * repaint scheduling, and key dispatch. Tests drive both with fakes.
 */
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';
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
  /** Box drawing: horizontal, vertical, and the four (rounded) corners. */
  h: string;
  v: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  dotOk: string;
  dotBad: string;
  arrow: string;
  ellipsis: string;
  sep: string;
  /** Meter fill by eighths, coarsest→full; a single entry means no partials. */
  blocks: string[];
  /** Sparkline levels, low→high; always 8 entries. */
  spark: string[];
  /** In-flight spinner frames, advanced once per repaint. */
  spinner: string[];
  /** Meter/sparkline background track. */
  track: string;
}

const UNICODE_CHARSET: Charset = {
  h: '─',
  v: '│',
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  dotOk: '●',
  dotBad: '●',
  arrow: '▸',
  ellipsis: '…',
  sep: '·',
  blocks: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'],
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  track: '·',
};

const ASCII_CHARSET: Charset = {
  h: '-',
  v: '|',
  tl: '+',
  tr: '+',
  bl: '+',
  br: '+',
  dotOk: '*',
  dotBad: 'x',
  arrow: '>',
  ellipsis: '~',
  sep: '.',
  blocks: ['#'],
  spark: ['.', '.', ':', '-', '=', '+', '#', '#'],
  spinner: ['|', '/', '-', '\\'],
  track: '.',
};

export type GlyphPreference = 'auto' | 'unicode' | 'ascii';

/** What the OS will host a fresh console window with. */
export type DefaultTerminal = 'modern' | 'legacy' | 'unknown';

/** HKCU\Console\%%Startup DelegationTerminal value for classic conhost. */
const CONHOST_DELEGATION_GUID = 'B23D10C0-E52E-411E-9D5B-C09FDF709C7D';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
/** First Windows 11 build (22H2) where "let Windows decide" means Terminal. */
const WIN11_TERMINAL_DEFAULT_BUILD = 22_621;

export interface QueryDefaultTerminalOptions {
  platform?: NodeJS.Platform;
  /** Injectable for tests: raw `reg.exe query` output, or null on failure. */
  readRegistry?: () => string | null;
  /** Injectable for tests: the Windows build number. */
  osBuild?: number;
}

function readDelegationRegistry(): string | null {
  try {
    return execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Console\\%%Startup', '/v', 'DelegationTerminal'],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
    );
  } catch {
    return null;
  }
}

function windowsBuild(): number {
  const build = Number.parseInt(release().split('.')[2] ?? '0', 10);
  return Number.isFinite(build) ? build : 0;
}

/**
 * Which host renders a *new* console window on this machine — the case the
 * logon task is in: Task Scheduler starts node.exe directly, so none of
 * the terminal env markers exist even when Windows Terminal ends up
 * drawing the window. The user's "default terminal application" choice
 * lives in HKCU\Console\%%Startup (DelegationTerminal): the conhost GUID
 * means classic conhost, all-zeros means "let Windows decide" (Terminal
 * from Windows 11 22H2 on, conhost before), and any other GUID is a
 * modern ConPTY terminal that registered itself. A missing value reads as
 * "let Windows decide" too. One reg.exe query, once at startup.
 */
export function queryDefaultTerminal(options: QueryDefaultTerminalOptions = {}): DefaultTerminal {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return 'unknown';
  const read = options.readRegistry ?? readDelegationRegistry;
  const build = options.osBuild ?? windowsBuild();
  const output = read();
  const guid = output === null ? null : /\{([0-9A-Fa-f-]{36})\}/.exec(output)?.[1]?.toUpperCase() ?? null;
  if (guid === CONHOST_DELEGATION_GUID) return 'legacy';
  if (guid !== null && guid !== ZERO_GUID) return 'modern';
  return build >= WIN11_TERMINAL_DEFAULT_BUILD ? 'modern' : 'legacy';
}

export interface DetectCharsetOptions {
  /** AGENT_UI_GLYPHS: an explicit choice beats every heuristic. */
  preference?: GlyphPreference;
  /** queryDefaultTerminal() result; 'unknown' adds no information. */
  defaultTerminal?: DefaultTerminal;
}

/**
 * Node writes TTY output through WriteConsoleW, so the console codepage
 * never garbles these glyphs; what decides the set is whether the hosting
 * terminal's font actually covers rounded corners, braille, and partial
 * blocks. Windows Terminal, VS Code, ConEmu, and any PowerShell 6+ console
 * (POWERSHELL_DISTRIBUTION_CHANNEL marks its children) do; a machine whose
 * default terminal is a modern host does too, env markers or not — which
 * is how a Task-Scheduler-launched window still gets the full set. Classic
 * conhost with console fonts keeps ASCII. Everything non-Windows is
 * unicode.
 */
export function detectCharset(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  options: DetectCharsetOptions = {},
): Charset {
  if (options.preference === 'unicode') return UNICODE_CHARSET;
  if (options.preference === 'ascii') return ASCII_CHARSET;
  if (platform !== 'win32') return UNICODE_CHARSET;
  if (
    env.WT_SESSION !== undefined ||
    env.TERM_PROGRAM !== undefined ||
    env.ConEmuANSI === 'ON' ||
    env.POWERSHELL_DISTRIBUTION_CHANNEL !== undefined
  ) {
    return UNICODE_CHARSET;
  }
  if (options.defaultTerminal === 'modern') return UNICODE_CHARSET;
  return ASCII_CHARSET;
}

export type ColorMode = 'none' | 'basic' | 'truecolor';

/**
 * Truecolor wherever it is a sure thing: every Windows console Node can
 * enable VT on already does 24-bit RGB, and COLORTERM / Windows Terminal /
 * ConEmu / VS Code declare it elsewhere. Anything else gets the 16-color
 * set — TERM=xterm-256color alone is no truecolor guarantee (macOS
 * Terminal.app, plain tmux). NO_COLOR wins over everything.
 */
export function detectColorMode(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): ColorMode {
  if (env.NO_COLOR !== undefined) return 'none';
  const colorterm = (env.COLORTERM ?? '').toLowerCase();
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';
  if (env.WT_SESSION !== undefined || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM === 'vscode') {
    return 'truecolor';
  }
  if (platform === 'win32') return 'truecolor';
  return 'basic';
}

// ---------------------------------------------------------------------------
// Styling. Layout is computed on plain strings; escape codes wrap whole
// cells afterwards, so column math never has to skip escape sequences. A
// segment may carry a pre-painted form (gradients, bars) whose visible
// width is, by construction, its plain text's length.

export type Style =
  | 'title'
  | 'label'
  | 'accent'
  | 'good'
  | 'warn'
  | 'bad'
  | 'muted'
  | 'value'
  | 'border'
  | 'header'
  | 'headerDim'
  | 'chip'
  | 'badgeGood'
  | 'badgeWarn'
  | 'badgeBad';

/**
 * Truecolor palette (Tokyo Night-ish, tuned for the dark consoles
 * PowerShell and Windows Terminal default to) with a 16-color SGR twin for
 * terminals that only do basic color.
 */
const FG = {
  blue: '122;162;247',
  cyan: '125;207;255',
  green: '158;206;106',
  yellow: '224;175;104',
  red: '247;118;142',
  gray: '86;95;137',
  bright: '192;202;245',
  border: '59;66;97',
  ink: '26;27;38',
};

const STYLE_SGR: Record<Style, { tc: string; basic: string }> = {
  title: { tc: `1;38;2;${FG.cyan}`, basic: '1;36' },
  label: { tc: `38;2;${FG.blue}`, basic: '36' },
  accent: { tc: `38;2;${FG.cyan}`, basic: '96' },
  good: { tc: `38;2;${FG.green}`, basic: '32' },
  warn: { tc: `38;2;${FG.yellow}`, basic: '33' },
  bad: { tc: `38;2;${FG.red}`, basic: '31' },
  muted: { tc: `38;2;${FG.gray}`, basic: '2' },
  value: { tc: `38;2;${FG.bright}`, basic: '' },
  border: { tc: `38;2;${FG.border}`, basic: '2' },
  header: { tc: `1;48;2;36;40;59;38;2;${FG.cyan}`, basic: '1;7' },
  headerDim: { tc: `48;2;36;40;59;38;2;${FG.gray}`, basic: '7;2' },
  chip: { tc: `1;48;2;${FG.blue};38;2;${FG.ink}`, basic: '7;1' },
  badgeGood: { tc: `1;48;2;${FG.green};38;2;${FG.ink}`, basic: '7;32' },
  badgeWarn: { tc: `1;48;2;${FG.yellow};38;2;${FG.ink}`, basic: '7;33' },
  badgeBad: { tc: `1;48;2;${FG.red};38;2;${FG.ink}`, basic: '7;31' },
};

export interface Segment {
  text: string;
  style?: Style;
  /** Pre-styled rendering of exactly `text`; used only when it fits whole. */
  painted?: string;
}

const RESET = '\u001b[0m';

function paint(text: string, style: Style | undefined, mode: ColorMode): string {
  if (mode === 'none' || style === undefined || text.length === 0) return text;
  const sgr = mode === 'truecolor' ? STYLE_SGR[style].tc : STYLE_SGR[style].basic;
  if (sgr.length === 0) return text;
  return `\u001b[${sgr}m${text}${RESET}`;
}

function clip(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return ellipsis;
  return text.slice(0, width - 1) + ellipsis;
}

interface Composed {
  out: string;
  used: number;
}

/** Compose cells into at most `width` columns, tracking the visible width. */
function compose(width: number, mode: ColorMode, charset: Charset, segments: Segment[]): Composed {
  let used = 0;
  let out = '';
  for (const segment of segments) {
    if (used >= width) break;
    if (segment.text.length === 0) continue;
    const room = width - used;
    if (segment.painted !== undefined && mode !== 'none' && segment.text.length <= room) {
      out += segment.painted;
      used += segment.text.length;
      continue;
    }
    const text = clip(segment.text, room, charset.ellipsis);
    out += paint(text, segment.style, mode);
    used += text.length;
  }
  return { out, used };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

// ---------------------------------------------------------------------------
// Gradient meters, sparklines, spinners

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function parseRgb(triplet: string): [number, number, number] {
  const [r, g, b] = triplet.split(';').map(Number);
  return [r ?? 0, g ?? 0, b ?? 0];
}

const GRAD_GREEN = parseRgb(FG.green);
const GRAD_YELLOW = parseRgb(FG.yellow);
const GRAD_RED = parseRgb(FG.red);

/** green → yellow → red across t ∈ [0,1]; the classic load gradient. */
function gradientSgr(t: number): string {
  const [from, to, local] =
    t < 0.6
      ? [GRAD_GREEN, GRAD_YELLOW, t / 0.6]
      : [GRAD_YELLOW, GRAD_RED, (t - 0.6) / 0.4];
  const r = lerpChannel(from[0], to[0], local);
  const g = lerpChannel(from[1], to[1], local);
  const b = lerpChannel(from[2], to[2], local);
  return `38;2;${r};${g};${b}`;
}

type MeterHue = 'gradient' | 'good' | 'accent';

function meterCellSgr(hue: MeterHue, t: number, mode: ColorMode): string {
  if (mode !== 'truecolor') {
    if (hue === 'gradient') return STYLE_SGR[t < 0.55 ? 'good' : t < 0.85 ? 'warn' : 'bad'].basic;
    return STYLE_SGR[hue].basic;
  }
  if (hue === 'gradient') return gradientSgr(t);
  return STYLE_SGR[hue].tc;
}

/**
 * htop/btop-style meter with sub-cell resolution: full cells from the
 * blocks table plus one fractional cell, on a muted track. The returned
 * segment's plain `text` carries the geometry; `painted` the colors.
 */
export function meter(
  width: number,
  ratio: number,
  charset: Charset,
  mode: ColorMode,
  hue: MeterHue = 'gradient',
): Segment {
  const clamped = Math.max(0, Math.min(1, ratio));
  const full = charset.blocks[charset.blocks.length - 1]!;
  let text: string;
  if (charset.blocks.length === 1) {
    const filled = Math.round(clamped * width);
    text = full.repeat(filled) + charset.track.repeat(width - filled);
  } else {
    const exact = clamped * width;
    const whole = Math.floor(exact);
    const fracIndex = Math.floor((exact - whole) * charset.blocks.length);
    const partial = whole < width && fracIndex > 0 ? charset.blocks[fracIndex - 1]! : '';
    text = full.repeat(whole) + partial;
    text += charset.track.repeat(width - text.length);
  }
  if (mode === 'none') return { text };
  let painted = '';
  for (let i = 0; i < text.length; i++) {
    const cell = text[i]!;
    const sgr = cell === charset.track ? (mode === 'truecolor' ? STYLE_SGR.border.tc : STYLE_SGR.border.basic) : meterCellSgr(hue, width <= 1 ? 0 : i / (width - 1), mode);
    painted += sgr.length === 0 ? cell : `\u001b[${sgr}m${cell}${RESET}`;
  }
  return { text, painted };
}

/** Per-bucket activity sparkline; height and color both track the load. */
export function sparkline(buckets: number[], width: number, charset: Charset, mode: ColorMode): Segment {
  const shown = buckets.slice(-width);
  while (shown.length < width) shown.unshift(0);
  const peak = Math.max(1, ...shown);
  let text = '';
  let painted = '';
  for (const count of shown) {
    const t = count / peak;
    const level = count === 0 ? 0 : Math.max(1, Math.min(7, Math.ceil(t * 7)));
    const cell = charset.spark[level]!;
    text += cell;
    if (mode === 'none') continue;
    const sgr = count === 0 ? (mode === 'truecolor' ? STYLE_SGR.border.tc : STYLE_SGR.border.basic) : meterCellSgr('gradient', t, mode);
    painted += sgr.length === 0 ? cell : `\u001b[${sgr}m${cell}${RESET}`;
  }
  return mode === 'none' ? { text } : { text, painted };
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

const LEVELS: Array<{ min: number; label: string; style: Style }> = [
  { min: 60, label: 'FTL', style: 'bad' },
  { min: 50, label: 'ERR', style: 'bad' },
  { min: 40, label: 'WRN', style: 'warn' },
  { min: 30, label: 'INF', style: 'good' },
  { min: 20, label: 'DBG', style: 'accent' },
  { min: 0, label: 'TRC', style: 'muted' },
];

function levelBadge(level: number): { label: string; style: Style } {
  for (const entry of LEVELS) {
    if (level >= entry.min) return { label: entry.label, style: entry.style };
  }
  return { label: 'TRC', style: 'muted' };
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
  colorMode: ColorMode;
  charset: Charset;
  now: number;
  /** Repaint counter; advances spinners. Defaults to 0 for stable tests. */
  tick?: number;
}

export interface RenderResult {
  lines: string[];
  /** Largest useful logScroll for the current pane height; clamps the view. */
  maxLogScroll: number;
}

const MIN_COLUMNS = 40;
const MIN_ROWS = 10;

interface Ctx {
  columns: number;
  mode: ColorMode;
  charset: Charset;
  now: number;
  spin: string;
}

function line(ctx: Ctx, ...segments: Segment[]): string {
  return compose(ctx.columns, ctx.mode, ctx.charset, segments).out;
}

function badge(text: string, style: Style): Segment {
  return { text: ` ${text} `, style };
}

/** ╭─ TITLE ───── extra ─╮ — a panel's top border with an embedded title. */
function panelTop(ctx: Ctx, title: string, extra = ''): string {
  const c = ctx.charset;
  const titleText = ` ${title} `;
  // Pre-clip the extra text so the closing corner always survives, however
  // long the annotation is.
  const room = ctx.columns - 2 - 1 - titleText.length - 2;
  const extraText = extra.length > 0 && room > 3 ? clip(` ${extra} ${c.h}`, room, c.ellipsis) : '';
  const fill = Math.max(0, room - extraText.length + 1);
  return line(
    ctx,
    { text: c.tl + c.h, style: 'border' },
    { text: titleText, style: 'title' },
    { text: c.h.repeat(fill), style: 'border' },
    { text: extraText, style: 'muted' },
    { text: c.h + c.tr, style: 'border' },
  );
}

function panelBottom(ctx: Ctx): string {
  const c = ctx.charset;
  return line(ctx, { text: c.bl + c.h.repeat(Math.max(0, ctx.columns - 2)) + c.br, style: 'border' });
}

/** │ content… │ — one framed row; inner content is clipped and padded. */
function panelRow(ctx: Ctx, ...segments: Segment[]): string {
  const inner = compose(ctx.columns - 4, ctx.mode, ctx.charset, segments);
  const edge = paint(ctx.charset.v, 'border', ctx.mode);
  return `${edge} ${inner.out}${' '.repeat(Math.max(0, ctx.columns - 4 - inner.used))} ${edge}`;
}

function headerLine(ctx: Ctx, snapshot: AgentStatusSnapshot): string {
  const mem = Math.round(process.memoryUsage.rss() / (1024 * 1024));
  const s = ctx.charset.sep;
  const left = ` BROWSER BRIDGE AGENT v${snapshot.info.version} `;
  const right = ` up ${formatUptime(ctx.now - snapshot.info.startedAt)} ${s} mem ${mem}M ${s} pid ${snapshot.info.pid} ${s} ${formatClock(ctx.now)} `;
  const gap = Math.max(1, ctx.columns - left.length - right.length);
  return line(
    ctx,
    { text: left, style: 'header' },
    { text: ' '.repeat(gap), style: 'headerDim' },
    { text: right, style: 'headerDim' },
  );
}

function gatewaySegments(ctx: Ctx, snapshot: AgentStatusSnapshot): Segment[] {
  switch (snapshot.phase) {
    case 'connected':
      return [badge('CONNECTED', 'badgeGood'), { text: `  ${snapshot.connectionId ?? ''}`, style: 'muted' }];
    case 'connecting':
      return [{ text: `${ctx.spin} CONNECTING`, style: 'warn' }];
    case 'waiting':
      return [
        {
          text: `${ctx.spin} RETRYING${snapshot.retryDelayMs === null ? '' : ` in ${formatDuration(snapshot.retryDelayMs)}`}`,
          style: 'warn',
        },
      ];
    case 'stopped':
      return [badge('STOPPED', 'badgeBad')];
    case 'idle':
      return [{ text: `${ctx.spin} STARTING`, style: 'muted' }];
  }
}

function taskSegments(snapshot: AgentStatusSnapshot): Segment[] {
  const runAs: Segment =
    snapshot.info.launchedBy === 'logon-task'
      ? { text: 'this run: background (logon task)', style: 'accent' }
      : { text: 'this run: interactive window', style: 'muted' };
  const task = snapshot.task;
  if (task === null) {
    return [{ text: 'checking Task Scheduler', style: 'muted' }, { text: '   ' }, runAs];
  }
  if (!task.supported) {
    return [{ text: 'n/a on this OS (Windows-only)', style: 'muted' }, { text: '   ' }, runAs];
  }
  if (task.error !== null) {
    return [{ text: 'status unavailable', style: 'warn' }, { text: `  ${task.error}`, style: 'muted' }];
  }
  if (!task.installed) {
    return [
      { text: 'not installed', style: 'warn' },
      { text: '   ' },
      runAs,
      { text: '   (scripts\\windows\\install-logon-task.ps1)', style: 'muted' },
    ];
  }
  const state = task.state ?? 'unknown';
  const segments: Segment[] = [
    { text: 'installed', style: 'good' },
    { text: ' ' },
    { text: state, style: state === 'Running' ? 'good' : state === 'Disabled' ? 'bad' : 'accent' },
  ];
  if (task.lastTaskResult !== null && task.lastTaskResult !== 0 && task.lastTaskResult !== 267009) {
    // 267009 (0x41301) just means "currently running"; anything else nonzero
    // is a real last-run failure worth surfacing.
    segments.push({ text: `  last result 0x${task.lastTaskResult.toString(16)}`, style: 'bad' });
  }
  segments.push({ text: '   ' }, runAs);
  return segments;
}

function statusRows(ctx: Ctx, snapshot: AgentStatusSnapshot): string[] {
  const s = ctx.charset.sep;
  const rows: string[] = [];
  const rxAge =
    snapshot.lastGatewayActivityAt === null ? null : Math.max(0, ctx.now - snapshot.lastGatewayActivityAt);
  rows.push(
    panelRow(
      ctx,
      { text: 'Gateway  ', style: 'label' },
      ...gatewaySegments(ctx, snapshot),
      { text: `  ${snapshot.info.gatewayWsUrl}`, style: 'muted' },
      rxAge === null
        ? { text: '' }
        : {
            text: rxAge < 1000 ? '  rx now' : `  rx ${formatAge(rxAge)} ago`,
            style: rxAge < 10_000 ? 'good' : rxAge < 45_000 ? 'warn' : 'bad',
          },
      { text: snapshot.reconnects > 0 ? `  ${s} reconnects ${snapshot.reconnects}` : '', style: 'muted' },
    ),
  );
  rows.push(
    panelRow(
      ctx,
      { text: 'Device   ', style: 'label' },
      { text: snapshot.info.agentName, style: 'value' },
      { text: `  ${snapshot.info.deviceId}  key ${snapshot.info.keyStoreKind}  profiles ${snapshot.info.siteProfiles.join(',')}`, style: 'muted' },
    ),
  );
  rows.push(panelRow(ctx, { text: 'Task     ', style: 'label' }, ...taskSegments(snapshot)));

  const session = snapshot.session;
  if (session === null) {
    rows.push(
      panelRow(
        ctx,
        { text: 'Browser  ', style: 'label' },
        { text: 'no session', style: 'muted' },
        { text: '  (opens on the first browser.session_open)', style: 'muted' },
      ),
    );
  } else {
    rows.push(
      panelRow(
        ctx,
        { text: 'Browser  ', style: 'label' },
        session.degraded ? badge('DEGRADED', 'badgeBad') : badge('READY', 'badgeGood'),
        { text: `  profile ${session.profileName}`, style: 'value' },
        { text: `  ${session.handle}`, style: 'muted' },
        { text: `  tabs ${session.tabs.length}`, style: 'value' },
      ),
    );
    for (const tab of session.tabs.slice(0, 3)) {
      rows.push(
        panelRow(
          ctx,
          { text: `  ${ctx.charset.arrow} `, style: tab.active ? 'accent' : 'muted' },
          { text: tab.url, style: tab.active ? 'value' : 'muted' },
          { text: tab.title.length > 0 ? `  ${s} ${tab.title}` : '', style: 'muted' },
        ),
      );
    }
  }

  for (const job of snapshot.jobs.slice(0, 2)) {
    const ratio = job.requested === 0 ? 1 : job.completed / job.requested;
    rows.push(
      panelRow(
        ctx,
        { text: `  ${job.jobId}  `, style: 'muted' },
        meter(20, ratio, ctx.charset, ctx.mode, job.status === 'running' ? 'accent' : 'good'),
        { text: ` ${job.completed}/${job.requested} ${job.status}`, style: 'value' },
        { text: job.failed > 0 ? `  failed ${job.failed}` : '', style: 'bad' },
      ),
    );
  }

  const policyTotal =
    snapshot.policy.request_aborted + snapshot.policy.popup_denied + snapshot.policy.download_blocked;
  rows.push(
    panelRow(
      ctx,
      { text: 'Activity ', style: 'label' },
      sparkline(snapshot.activityBuckets, Math.min(24, Math.max(8, ctx.columns - 76)), ctx.charset, ctx.mode),
      { text: ` ${snapshot.commandsPerMinute}/min`, style: 'accent' },
      { text: `  ${s} ok `, style: 'muted' },
      { text: String(snapshot.totals.ok), style: 'good' },
      { text: `  ${s} err `, style: 'muted' },
      { text: String(snapshot.totals.error), style: snapshot.totals.error > 0 ? 'bad' : 'muted' },
      { text: `  ${s} policy `, style: 'muted' },
      { text: String(policyTotal), style: policyTotal > 0 ? 'warn' : 'muted' },
      { text: `  ${s} in-flight `, style: 'muted' },
      { text: String(snapshot.inFlight), style: snapshot.inFlight > 0 ? 'accent' : 'muted' },
    ),
  );
  return rows;
}

function commandRowSegments(ctx: Ctx, row: CommandRow): Segment[] {
  const at = formatClock(row.startedAt);
  const name = pad(row.command, 26);
  if (row.status === 'running') {
    return [
      { text: `${at}  `, style: 'muted' },
      { text: name, style: 'value' },
      { text: `${ctx.spin} running`, style: 'warn' },
      { text: `   ${row.requestId}`, style: 'muted' },
    ];
  }
  const dur = pad(row.durationMs === null ? '' : formatDuration(row.durationMs), 8);
  if (row.status === 'ok') {
    return [
      { text: `${at}  `, style: 'muted' },
      { text: name, style: 'value' },
      { text: `${ctx.charset.dotOk} ok      `, style: 'good' },
      { text: dur, style: 'value' },
      { text: ` ${row.requestId}`, style: 'muted' },
    ];
  }
  return [
    { text: `${at}  `, style: 'muted' },
    { text: name, style: 'value' },
    { text: `${ctx.charset.dotBad} ${row.errorCode ?? 'error'}`, style: 'bad' },
    { text: `  ${dur}`, style: 'value' },
    { text: ` ${row.requestId}`, style: 'muted' },
  ];
}

function logRowSegments(row: LogRow): Segment[] {
  const badgeInfo = levelBadge(row.level);
  return [
    { text: `${formatClock(row.at)} `, style: 'muted' },
    { text: badgeInfo.label, style: badgeInfo.style },
    { text: `  ${row.msg}`, style: 'value' },
    { text: row.fields.length > 0 ? `  ${row.fields}` : '', style: 'muted' },
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

function footerLine(ctx: Ctx, view: ViewState): string {
  const levelLabel = LEVEL_FILTER_CYCLE.find((e) => e.value === view.minLevel)?.label ?? 'info';
  const following = !view.paused && view.logScroll === 0;
  const chips: Array<[string, string]> = [
    ['q', 'quit'],
    ['p', view.paused ? 'resume' : 'pause'],
    ['j/k', 'scroll'],
    ['f', 'follow'],
    ['l', `level:${levelLabel}`],
    ['c', 'clear'],
    ['e', 'config'],
    ['t', 'task'],
    ['?', 'help'],
  ];
  const segments: Segment[] = [{ text: ' ' }];
  for (const [key, label] of chips) {
    segments.push({ text: ` ${key} `, style: 'chip' }, { text: `${label}  `, style: 'muted' });
  }
  if (!following) segments.push({ text: ' log tail frozen ', style: 'badgeWarn' });
  return line(ctx, ...segments);
}

export function renderDashboard(
  snapshot: AgentStatusSnapshot,
  view: ViewState,
  options: RenderOptions,
): RenderResult {
  const { columns, rows, colorMode, charset, now } = options;
  const tick = options.tick ?? 0;
  const ctx: Ctx = {
    columns,
    mode: colorMode,
    charset,
    now,
    spin: charset.spinner[tick % charset.spinner.length]!,
  };

  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    const lines = [
      line(ctx, { text: `terminal too small (${columns}x${rows}, need ${MIN_COLUMNS}x${MIN_ROWS})`, style: 'warn' }),
    ];
    while (lines.length < rows) lines.push('');
    return { lines: lines.slice(0, Math.max(1, rows)), maxLogScroll: 0 };
  }

  const out: string[] = [];
  out.push(headerLine(ctx, snapshot));

  const status = statusRows(ctx, snapshot);
  out.push(panelTop(ctx, 'STATUS'));
  out.push(...status);
  out.push(panelBottom(ctx));

  const levelLabel = LEVEL_FILTER_CYCLE.find((e) => e.value === view.minLevel)?.label ?? 'info';
  const following = !view.paused && view.logScroll === 0;
  // Rows left for the two flexible panels (each costs 2 rows of frame),
  // after the header and footer.
  const bodyRows = rows - out.length - 1;
  let maxLogScroll = 0;

  if (view.screen === 'help') {
    out.push(panelTop(ctx, 'KEYS'));
    const inner = Math.max(0, bodyRows - 2);
    for (const [key, desc] of HELP_ROWS.slice(0, inner)) {
      out.push(panelRow(ctx, { text: pad(key, 14), style: 'accent' }, { text: desc, style: 'value' }));
    }
    for (let i = HELP_ROWS.length; i < inner; i++) out.push(panelRow(ctx));
    out.push(panelBottom(ctx));
  } else if (view.screen === 'config') {
    out.push(panelTop(ctx, 'CONFIG', 'effective agent environment; the agent env holds no secrets'));
    const inner = Math.max(0, bodyRows - 2);
    const keyWidth = Math.min(34, Math.max(12, ...snapshot.config.map((e) => e.key.length)) + 2);
    const rowsBudget = snapshot.info.logPath === null ? inner : Math.max(0, inner - 1);
    let contentCount = 0;
    for (const entry of snapshot.config.slice(0, rowsBudget)) {
      out.push(
        panelRow(
          ctx,
          { text: pad(entry.key, keyWidth), style: 'accent' },
          { text: pad(entry.source === 'env' ? 'env' : 'def', 5), style: entry.source === 'env' ? 'good' : 'muted' },
          { text: entry.value, style: 'value' },
        ),
      );
      contentCount += 1;
    }
    if (snapshot.info.logPath !== null && contentCount < inner) {
      // Derived, not an env var: where this run's JSON log stream lands.
      out.push(
        panelRow(
          ctx,
          { text: pad('log file', keyWidth), style: 'accent' },
          { text: pad('run', 5), style: 'muted' },
          { text: snapshot.info.logPath, style: 'value' },
        ),
      );
      contentCount += 1;
    }
    for (; contentCount < inner; contentCount += 1) out.push(panelRow(ctx));
    out.push(panelBottom(ctx));
  } else {
    // Main screen: commands on top, logs below; logs get the larger share.
    const commandsInner = Math.max(1, Math.min(snapshot.commands.length || 1, Math.floor((bodyRows - 4) * 0.35)));
    const logsInner = Math.max(1, bodyRows - 4 - commandsInner);

    out.push(panelTop(ctx, 'COMMANDS', `${snapshot.commands.length} recent ${charset.sep} newest first`));
    const commandRows = snapshot.commands.slice(0, commandsInner);
    for (const row of commandRows) out.push(panelRow(ctx, ...commandRowSegments(ctx, row)));
    for (let i = commandRows.length; i < commandsInner; i++) out.push(panelRow(ctx));
    out.push(panelBottom(ctx));

    const filtered = snapshot.logs.filter((row) => row.level >= view.minLevel);
    maxLogScroll = Math.max(0, filtered.length - logsInner);
    const scroll = Math.min(view.logScroll, maxLogScroll);
    const state = following ? 'following' : scroll > 0 ? `scrolled +${scroll}` : 'paused';
    // The log file's full path lives on the config screen ([e]); putting it
    // here would eat the whole border on a Windows %LOCALAPPDATA% path.
    out.push(panelTop(ctx, 'LOGS', `level>=${levelLabel} ${charset.sep} ${state}`));
    const end = filtered.length - scroll;
    const visible = filtered.slice(Math.max(0, end - logsInner), end);
    for (const row of visible) out.push(panelRow(ctx, ...logRowSegments(row)));
    for (let i = visible.length; i < logsInner; i++) out.push(panelRow(ctx));
    out.push(panelBottom(ctx));
  }

  while (out.length < rows - 1) out.push('');
  const lines = out.slice(0, rows - 1);
  lines.push(footerLine(ctx, view));
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
  colorMode?: ColorMode;
  charset?: Charset;
  now?: () => number;
  /** Steady repaint cadence; keeps ages, uptime, and spinners moving. */
  refreshMs?: number;
}

const ENTER_ALT = '\u001b[?1049h\u001b[?25l\u001b[2J\u001b[H\u001b]0;Browser Bridge Agent\u0007';
const LEAVE_ALT = '\u001b[0m\u001b[?25h\u001b[?1049l';

export class AgentTui {
  private readonly options: AgentTuiOptions;
  private readonly output: OutputLike;
  private readonly input: InputLike;
  private readonly colorMode: ColorMode;
  private readonly charset: Charset;
  private readonly now: () => number;
  private view: ViewState = initialViewState();
  private running = false;
  private quitRequested = false;
  private tick = 0;
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
    this.colorMode = options.colorMode ?? detectColorMode();
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
    this.tick += 1;
    const result = renderDashboard(this.options.store.snapshot(), this.view, {
      columns,
      rows,
      colorMode: this.colorMode,
      charset: this.charset,
      now: this.now(),
      tick: this.tick,
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
