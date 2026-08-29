/**
 * The individual measurements the ledger is assembled from.
 *
 * Each probe answers one question and says how it knows. `measured` means
 * the number came out of running real code on real input on this box;
 * `modelled` means the code was real but the input was constructed here,
 * with the construction parameters reported; `unmeasurable` means the
 * question needs something this box does not have — live ebay.ca, a paired
 * Windows agent with Chrome, or the chat client's own inline-response
 * limit — and the reason is carried in place of a number.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildSearchResultsPage, MODELLED_ITMPRP_LENGTH, MODELLED_ROWS_PER_PAGE, MODELLED_TITLE_LENGTH } from './srpModel.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');

export type Basis = 'measured' | 'modelled' | 'derived' | 'reported' | 'unmeasurable';

export interface Probe {
  id: string;
  question: string;
  basis: Basis;
  bytes: number | null;
  ms: number | null;
  detail: Record<string, unknown>;
  /** Why there is no number, when there is no number. */
  reason?: string;
}

/**
 * tools/ sits outside the pnpm workspace on purpose — a measurement
 * harness should not add a package to the build graph — so it declares no
 * dependencies and borrows the one parser the repo already uses, through
 * the tests package that does declare it. Built package output is loaded by
 * path for the same reason: the harness measures what the gateway ships,
 * not a second copy of it.
 */
const requireFromTests = createRequire(pathToFileURL(join(REPO_ROOT, 'tests', 'package.json')));

interface ParsedDom {
  document: Document;
}
type ParseHtml = (html: string) => ParsedDom;

export async function loadParseHtml(): Promise<ParseHtml> {
  const entry = pathToFileURL(requireFromTests.resolve('linkedom')).href;
  const mod = (await import(entry)) as { parseHTML?: ParseHtml; default?: { parseHTML?: ParseHtml } };
  const parseHTML = mod.parseHTML ?? mod.default?.parseHTML;
  if (parseHTML === undefined) throw new Error('linkedom did not export parseHTML');
  return parseHTML;
}

export async function loadBuilt<T>(relativeDistPath: string): Promise<T> {
  return (await import(pathToFileURL(join(REPO_ROOT, relativeDistPath)).href)) as T;
}

export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export async function timed<T>(fn: () => T | Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Number((performance.now() - started).toFixed(3)) };
}

export function fixture(...parts: string[]): Promise<string> {
  return readFile(join(FIXTURES, ...parts), 'utf8');
}

/* -------------------------------------------------------------------------
 * browser.extract response envelopes
 *
 * The envelope is the one apps/windows-agent/src/executors.ts builds for a
 * search/store page and for an item page; the record inside it comes from
 * the real extractor in the built site package. Reproducing the envelope
 * rather than calling the executor is forced: the executor needs a live
 * Playwright page, and there is no Chrome on this box.
 * ---------------------------------------------------------------------- */

/**
 * The candidate record executeExtract() assembles for a search/store page,
 * before any compaction runs over it. Split out of the envelope below
 * because the Phase 2 surface needs exactly this object to hand to
 * compactSearchPage(): the compactor takes the record, not the envelope,
 * and building a second copy of it here would let the two drift.
 */
export function searchExtractRecord(
  siteProfile: string,
  pageUrl: string,
  candidates: unknown[],
): Record<string, unknown> {
  return {
    siteProfile,
    pageKind: 'search',
    pageUrl,
    candidateCount: candidates.length,
    candidates,
    note: 'Candidate snippets are traversal hints; open each /itm/ URL and extract it for canonical evidence.',
  };
}

export function searchExtractEnvelope(
  siteProfile: string,
  pageUrl: string,
  candidates: unknown[],
): Record<string, unknown> {
  return {
    siteProfile,
    pageRevision: 1,
    record: searchExtractRecord(siteProfile, pageUrl, candidates),
    warnings: [],
  };
}

export function itemExtractEnvelope(
  siteProfile: string,
  record: unknown,
  warnings: string[],
): Record<string, unknown> {
  return { siteProfile, pageRevision: 1, record, warnings };
}

/* -------------------------------------------------------------------------
 * Live reachability
 * ---------------------------------------------------------------------- */

export async function probeReachability(host: string): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(`https://${host}/`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    return { host, status: response.status, reachable: response.status < 400 };
  } catch (err) {
    return { host, status: null, reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* -------------------------------------------------------------------------
 * dashboard.feed shaping
 *
 * There is no dashboard API to call and no ingest token here, so the feed
 * is modelled: 38 records, the count the run reported, each padded to the
 * mean implied by the reported ~40 KB response. What is measured is what
 * DashboardClient.feed does to that input in each mode — the 'ids'
 * reduction is a property of the code (apps/gateway/src/dashboards/
 * client.ts), not of the numbers fed to it.
 * ---------------------------------------------------------------------- */

export const REPORTED_FEED_RECORD_COUNT = 38;
export const REPORTED_FEED_BYTES = 40 * 1024;

export function modelDealsFeed(records: number, targetBytesPerRecord: number): Record<string, unknown> {
  const listings: Record<string, unknown>[] = [];
  for (let index = 0; index < records; index += 1) {
    const listing: Record<string, unknown> = {
      id: `ebay-2${String(index).padStart(11, '0')}`,
      status: index % 7 === 0 ? 'ended' : 'active',
      firstSeen: '2026-08-01T12:00:00.000Z',
      lastSeen: '2026-08-29T12:00:00.000Z',
      lastChanged: '2026-08-27T12:00:00.000Z',
      lastVerified: '2026-08-29T12:00:00.000Z',
      source: 'ebay.ca',
      url: `https://www.ebay.ca/itm/2${String(index).padStart(11, '0')}`,
      title: 'LEGO Bulk Lot Mixed Bricks Parts Pieces Minifigures Assorted Clean Sorted',
      seller: `seller_${index}`,
      priceCad: 120 + index,
      shippingCad: 24.5,
      landedCad: 144.5 + index,
      pricePerKgCad: 18.4,
      weightKg: 7.8,
      condition: 'used',
      sellingFormat: 'fixed_price',
      verdict: index % 3 === 0 ? 'watch' : 'pass',
    };
    // Pad to the reported mean with a rationale field rather than filler:
    // a real deals record carries free text of roughly this size.
    const overhead = jsonBytes(listing);
    const padding = Math.max(0, targetBytesPerRecord - overhead - 16);
    listing.rationale = 'x'.repeat(padding);
    listings.push(listing);
  }
  return {
    schemaVersion: 3,
    scope: 'deals',
    generatedAt: '2026-08-29T12:00:00.000Z',
    listings,
  };
}

export { MODELLED_ITMPRP_LENGTH, MODELLED_ROWS_PER_PAGE, MODELLED_TITLE_LENGTH, buildSearchResultsPage };

/* -------------------------------------------------------------------------
 * Capture provenance and table rendering
 *
 * Shared by both entry points rather than copied into each: a before and an
 * after capture that describe their tree by different rules, or round their
 * numbers differently, are not diffable, and two copies of this is how that
 * happens.
 * ---------------------------------------------------------------------- */

export interface SourceState {
  repoHead: string | null;
  dirtyPaths: string[];
}

/**
 * A ledger is only diffable against a later one if both say what tree they
 * measured. A dirty tree is not an error here — the harness measures the
 * built packages, whatever is in them — but a capture taken mid-change is
 * not a capture of HEAD, and the file has to admit which it is.
 */
export function sourceState(): SourceState {
  const git = (args: string[]): string | null => {
    try {
      // trimEnd, not trim: a porcelain status line begins with two status
      // columns, and the first of them is a space for an unstaged change.
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trimEnd();
    } catch {
      return null;
    }
  };
  // --no-optional-locks: a measurement harness has no business writing to
  // the repository it is measuring, not even an index stat refresh.
  const status = git(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']);
  return {
    repoHead: git(['--no-optional-locks', 'rev-parse', 'HEAD'])?.trim() ?? null,
    dirtyPaths:
      status === null || status.length === 0 ? [] : status.split('\n').map((line) => line.slice(3).trim()),
  };
}

export function kib(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join('  ').trimEnd();
  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}
