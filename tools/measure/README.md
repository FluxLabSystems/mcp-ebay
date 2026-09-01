# tools/measure — deals-routine call-budget ledger

```
node tools/measure/ledger.ts [--out <path>] [--offline]            # BEFORE
node tools/measure/after.ts  [--out <path>] [--offline] [--before <path>]   # AFTER + diff
node tools/measure/ledger.ts --after                               # same as after.ts
```

Requires a prior `pnpm build`: the harness loads the *built* site, gateway
and telemetry packages by path, so it measures what the gateway actually
ships rather than a second copy compiled for the occasion. It needs no
install of its own — `tools/` sits outside the pnpm workspace on purpose,
declares no dependencies, and borrows linkedom through the tests package
that already declares it. Node ≥ 22.12 runs the TypeScript directly.

Default output: `baseline-ledger.json` beside this file for the before mode,
`after-ledger.json` for the after mode. The baseline is the "before" capture
a later run is diffed against, so re-capture it deliberately (and say why in
the commit), not as a side effect — nothing in the after mode writes to it.

The checked-in capture is of `e5c57c9` — the one-page-per-call tool surface,
before any batching work — with only the broker's telemetry hook applied on
top, which is what its `source.dirtyPaths` says. Every capture records the
head it measured and which tracked files differed from it, because a ledger
that does not say what tree it came from cannot be diffed against another.

## What it does

Replays the shape of one deals run — feed, session open, one search page,
seventeen canonical item pages, one upsert — against `tests/fixtures/` via
the existing `tests/helpers/fixtureServer.ts`, and reports what each phase
costs in calls, bytes and seconds. Per-call numbers come back out of
`@browser-bridge/telemetry`: the harness records each simulated call the
way the broker would and reads its own NDJSON back, so the ledger is
produced by the instrumentation it exists to justify.

## How to read a number

Every row and probe carries a basis, and they are not interchangeable:

| basis | means |
| --- | --- |
| `measured` | real code, real checked-in input, on this box |
| `modelled` | real code, input constructed here; the construction parameters are reported alongside so the figure can be rescaled |
| `derived` | follows from the tool surface (`packages/protocol/src/catalog.ts`), not from a stopwatch |
| `reported` | the operator's 2026-08-29 run. Never measured here, never mixed into a measured row |
| `unmeasurable` | needs something this box does not have; carries a reason instead of a number |

The after capture carries every `unmeasurable` entry the before capture
does — verbatim, copied out of the before capture at run time rather than
retyped — plus its own: the real job-poll count, real batch wall time,
whether the compacted response clears the client's spill threshold, the
agent-side CPU compaction moves, and the recovery calls per-URL error slots
are meant to save.

`www.ebay.ca` answers this box with **HTTP 403** and `www.kijiji.ca` with
**200** — the harness probes both and records what it got. So the live
240-row search page cannot be captured here at all. Rather than scale the
1 KB fixture by 120 and call it 160 KB, the harness generates a 240-row
page with the live card and href shape (`_skw`, `itmmeta`, `hash`,
`itmprp`), runs the **real** extractor over it, and prints the naive
extrapolation next to the modelled one so the gap between them is visible.
The modelling constants live in `srpModel.ts`, one named export each.

`--offline` skips the two reachability fetches; everything else still runs.

## The after mode

`after.ts` replays **the same routine** — feed, session open, one 240-row
search page, seventeen canonical item pages, one upsert — costed against the
Phase 2 tool surface, and prints the before → after diff.

The before side of that diff is not retyped from `baseline-ledger.json`. It
is produced by running `ledger.ts` itself in a subprocess, against this tree
and this Node, into a scratch file — so the two sides differ by the tool
surface and by nothing else. The committed baseline is read as well, and any
drift between it and the replay is printed rather than smoothed over. Pass
`--before <path>` to diff against a capture you already have instead.

**Call counts are derived, never chosen.** They come out of `afterModel.ts`,
which is handed the constants from the *built* protocol package:

| constant | today | what it decides |
| --- | --- | --- |
| `EXTRACT_MANY_MAX_URLS` | 25 | URLs one `browser_extract_many` may carry |
| `MAX_INLINE_BATCH_ITEMS` | 2 | largest batch `mode:"auto"` answers inline |
| `DEFAULT_SEARCH_COMPACTION.limit` | 40 | rows one search call returns of the page |

Seventeen item pages is therefore one batch that **promotes to a job**, and
a promoted call returns a `jobId` and zero result slots — so the poll it
forces is counted. One poll is the structural floor (you cannot read a
promoted batch without polling once); how many polls a real run spends is
not derivable and is not guessed. The report prints a sensitivity table at
1/2/4/8 polls beside the floor, and `tests/unit/measureAfter.test.ts` pins
the three facts the derivation rests on.

The after report ends with a **"where the after story is weaker than it
looks"** section — the search window being a smaller answer as well as a
smaller payload, compaction *adding* bytes on a two-row page, the preamble
win being mostly the pre-Phase-2 `mode:"ids"`, and the reported run's five
shell calls not being counted as saved. It is part of the output, not a
footnote to it.

## Telemetry environment

The recorder the harness drives is off unless asked for:

| variable | default | meaning |
| --- | --- | --- |
| `BRIDGE_TELEMETRY` | unset (off) | `1`/`true`/`yes`/`on` enables; anything else is off |
| `BRIDGE_TELEMETRY_DIR` | `$TMPDIR/browser-bridge-telemetry` | log directory — outside the repo by default |
| `BRIDGE_TELEMETRY_MAX_BYTES` | `5242880` (5 MiB) | rotate when the live file would exceed this |
| `BRIDGE_TELEMETRY_MAX_FILES` | `5` | retained files including the live one; `1` truncates in place |
| `BRIDGE_TELEMETRY_RUN_ID` | generated | correlation id stamped on every line |

Lines carry sizes and identifiers only — never an argument value, a token,
or a postal code. See `packages/telemetry/src/index.ts` and the redaction
test in `tests/unit/telemetry.test.ts`.
