# ADR 0002 — Agent console dashboard (run TUI)

Status: Accepted
Date: 2026-08-31

The Windows agent's `run` window used to print the raw pino NDJSON stream —
correct, but unreadable on the desktop where the operator actually looks at
it. `run` now renders an htop-style live dashboard on a real console. Three
choices in it are architecture-relevant enough to record.

## 1. Where the §26 JSON stream goes in dashboard mode

SDD §26 requires structured JSON logging with the redaction list; the
dashboard cannot share stdout with it. In dashboard mode the pino stream —
built with the **same** `createLogger` options, so redaction runs before
serialization — is teed to a size-rotated NDJSON file under the state dir
(`state\logs\agent-run.ndjson`, reusing `@browser-bridge/telemetry`'s
`RotatingNdjsonLog`, 5 MiB × 5) and to the on-screen tail, which only ever
sees the already-censored line. Nothing about §26's *content* rules changes;
only the destination does, and only when a human console is attached. When
stdout is not a TTY (pipes, CI, the test harness) or `--no-ui` is passed,
behavior is byte-identical to before: pino JSON on stdout. The unit suite
proves the redaction property against the teed destination.

## 2. Hand-rolled VT100, zero new dependencies

The agent is the security-sensitive half of the bridge (it holds the device
key and drives the browser), and the obvious TUI frameworks are either
unmaintained (blessed) or bring a large transitive tree (ink/React). The
dashboard is ~one screen of layout, so it is written directly against VT
escape sequences: Node enables Windows' virtual-terminal mode on TTY stdout,
which covers Windows Terminal, modern conhost, and POSIX terminals alike.
The renderer is a pure function of a status snapshot, which is what keeps
it testable without a terminal.

Capability tiers, detected once at startup, keep one renderer honest across
consoles:

- **Glyphs.** Rounded panels, partial-block meters, sparklines, and braille
  spinners wherever the hosting terminal's font covers them (Node writes
  TTY output via WriteConsoleW, so the console codepage is not the
  constraint — font coverage is): any non-Windows terminal, a declared one
  (`WT_SESSION`/`TERM_PROGRAM`/ConEmu), or a PowerShell 6+ host — pwsh
  switches the console to UTF-8 at startup and its
  `POWERSHELL_DISTRIBUTION_CHANNEL` variable marks the children it spawns,
  so pwsh-in-conhost qualifies. The window the logon task opens
  (`Start-ScheduledTask`, or at logon) has none of those markers because
  Task Scheduler starts node.exe directly, so a marker-less win32 console
  additionally consults the user's "default terminal application" choice —
  one `reg.exe query` of `HKCU\Console\%%Startup` DelegationTerminal at
  startup, classified the way the OS does (conhost GUID → classic; any
  other registered GUID → modern; all-zeros/absent "let Windows decide" →
  Terminal from Windows 11 22H2 on). Classic conhost degrades to ASCII;
  `AGENT_UI_GLYPHS` (auto/unicode/ascii, in the typed config and on the
  dashboard's config screen) overrides the heuristic entirely. The
  installer also registers the task with an explicit Interactive principal
  so the visible console window is guaranteed by registration rather than
  cmdlet defaults.
- **Color.** 24-bit truecolor (a dark-console palette with gradient meters)
  on every Windows console — conhost has done RGB since well before the
  Win10 1809 floor Node 22 already requires — and wherever
  COLORTERM/Windows Terminal/ConEmu/VS Code declare it; a 16-color mapping
  of the same semantic styles elsewhere (TERM=xterm-256color alone is no
  truecolor guarantee); none under NO_COLOR. Layout is computed on plain
  strings and escape codes wrap whole cells afterwards, so the geometry
  contract (exactly `rows` lines, none wider than `columns`) holds
  identically in every tier — the unit suite asserts it with ANSI stripped.

## 3. Task Scheduler probe and the `--launched-by` marker

The dashboard answers "is the logon task installed / what state is it in /
is this window the background task or a hand-started one". Install state
comes from PowerShell `Get-ScheduledTask … | ConvertTo-Json` (same
PowerShell-as-syscall pattern as the DPAPI keystore; `schtasks` output is
localized and unparseable portably), invoked async so a slow probe can never
stall the WSS loop, and failing closed into a "status unavailable" pane
state. Provenance of the current process cannot be probed reliably, so
`install-logon-task.ps1` now registers the action as
`run --launched-by logon-task`; absence of the flag means "interactive".
`AGENT_TASK_NAME` (default `FluxologyBrowserBridgeAgent`, owned by
`@browser-bridge/config` so the installer and the probe cannot drift apart
silently) covers non-default `-TaskName` installs.

Non-goals, recorded to bound the surface: the dashboard displays only the
`AgentEnvSchema` variables (the agent env holds no secrets by design —
tokens and OAuth live gateway-side), never a dump of the wider process
environment; and the gateway keeps its plain JSON stdout — it runs headless
in Compose where NDJSON is the right interface.
