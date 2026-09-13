/**
 * The jobs-source roster — DATA, not policy logic. Each entry is one source
 * the Fluxology jobs routine (fluxlab-boards
 * .claude/skills/fluxology-jobs-run/, references/source-strategy.md
 * "Default source roster") searches for GTA entry-level trades work, and the
 * registrable domains its pages live on. profile.ts derives the allowlist
 * from this list (apex plus wildcard subdomains) through
 * createResearchProfile, so every host sits behind the same read-only walls
 * plus the job-board walls (no apply, no resume upload, no job alert, no
 * message to a recruiter).
 *
 * How a host gets here (docs/SITE-PROFILE-BACKLOG.md, "The rule a host gets
 * here by"): a routine files the ORIGIN_DENIED, the host belongs to a source
 * the operator controls in committed repo content, it is a public registrable
 * domain, and the addition ships as a PR with a test. Hosts named only inside
 * scraped posting text never qualify.
 *
 * This roster was ratified by the operator in the live session of
 * 2026-09-13 ("expand the sites that the jobs dashboard searches by default
 * and the connectors it uses"), the same precedent as the office roster of
 * 2026-09-05: the jobs-sources.v1 backlog row had waited since 2026-09-04
 * on an ORIGIN_DENIED for ca.indeed.com that no fire had yet spent, and the
 * operator's direction is the ratification. `source` on every row records
 * that, so each host is auditable back to its decision. Every host was
 * checked to resolve on 2026-09-13 (an HTTP status from the apex, recorded
 * per entry where it matters); none was read through the Bridge yet, so
 * every entry carries what the next live session must confirm.
 */
export interface JobsSource {
  /** Display name as the jobs routine's roster spells it. */
  name: string;
  /**
   * `board`: a job board with its own inventory and posting pages.
   * `aggregator`: a mirror / metasearch surface — discovery only; a posting
   * found here is verified on the employer's page or the board it mirrors.
   * `channel`: a union intake, apprenticeship or public-sector page the
   * routine reads for an intake state or an apprenticeship pathway, never
   * for a posting to score.
   * `ats`: an applicant-tracking host employers' own career pages run on —
   * the employer-direct verification tier lives here more often than on the
   * employer's marketing domain.
   */
  group: 'board' | 'aggregator' | 'channel' | 'ats';
  /**
   * Bare registrable domains, or — where the source lives on one subdomain
   * of a wider service — the narrowest host that covers it. The profile
   * allows each entry and every label depth beneath it.
   */
  hosts: readonly string[];
  /**
   * The value the routine writes in the jobs record's closed `source`
   * vocabulary (public/jobs/data/schema.json) when a posting is DISCOVERED
   * here; `employer-direct` for every ATS host, `union` for the channels.
   */
  sourceLabel: string;
  /** ISO date the source joined the roster. */
  addedOn: string;
  /** Queue fingerprint or operator instruction that justified the entry. */
  source: string;
  /** Anything the next live session must confirm. */
  needsLiveVerification?: string;
  /**
   * What a live session already confirmed about the hosts, dated and with
   * the queue fingerprint that carried the observation.
   */
  verifiedLive?: string;
}

const OPERATOR_RATIFIED_2026_09_13 =
  'operator+skill_gap+jobs-default-sources-and-connectors-expansion-2026-09-13 (operator direction in the live CI session of 2026-09-13: expand the sites the jobs dashboard searches by default and the connectors it uses; roster ratified in-session on the office-sources.v1 precedent)';
const BACKLOG_ROW =
  'docs/SITE-PROFILE-BACKLOG.md jobs-sources.v1 row (host named in the committed jobs SKILL.md / references/source-strategy.md since 2026-09-04)';

const entry = (
  group: JobsSource['group'],
  name: string,
  hosts: readonly string[],
  sourceLabel: string,
  source: string,
  needsLiveVerification?: string,
): JobsSource => ({
  name,
  group,
  hosts,
  sourceLabel,
  addedOn: '2026-09-13',
  source,
  ...(needsLiveVerification ? { needsLiveVerification } : {}),
});

export const JOBS_SOURCES: readonly JobsSource[] = [
  // --- job boards: their own inventory, their own posting pages ---
  entry(
    'board',
    'Job Bank (Government of Canada)',
    ['jobbank.gc.ca'],
    'Job Bank',
    `${OPERATOR_RATIFIED_2026_09_13}; ${BACKLOG_ROW}`,
    'WebFetch already reads it (search paging &page=N and the 50xxxxxx permalinks verified 2026-09-01..04); on the roster so the lane is one profile, not so the walk moves — confirm a posting URL carrying ?applyonline=false navigates (the query string is not an apply path)',
  ),
  entry(
    'board',
    'Indeed Canada (the connector is the first-party read; the Bridge is the page read)',
    ['indeed.com'],
    'Indeed',
    `${OPERATOR_RATIFIED_2026_09_13}; ${BACKLOG_ROW}`,
    'ca.indeed.com answers 401/403 to plain fetch (2026-09-07, indeed+coverage_gap+ca-indeed-viewjob-401-blocks-canonical-url-verification); whether a normal browser context renders /viewjob?jk= is the first thing the lane must establish. Covers ca.indeed.com and the to.indeed.com short links the connector mints.',
  ),
  entry(
    'board',
    'talent.com',
    ['talent.com'],
    'talent.com',
    `${OPERATOR_RATIFIED_2026_09_13}; ${BACKLOG_ROW}`,
    'ca.talent.com answered 200 to plain fetch 2026-09-13; the posting page shape and its apply control',
  ),
  entry(
    'board',
    'Eluta',
    ['eluta.ca'],
    'Eluta',
    `${OPERATOR_RATIFIED_2026_09_13}; ${BACKLOG_ROW}`,
    'intermittent HTTP 503 to cloud egress (source-strategy.md "Eluta is best-effort"); whether the Bridge sees the same wall',
  ),
  entry(
    'board',
    'Jobillico',
    ['jobillico.com'],
    'Jobillico',
    OPERATOR_RATIFIED_2026_09_13,
    'the apex redirects to /fr/ (2026-09-13); the English Ontario search lives under /en/ — confirm the search URL shape and that the region facet holds',
  ),
  entry(
    'board',
    'SimplyHired Canada',
    ['simplyhired.ca'],
    'SimplyHired',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); whether a normal browser context renders search and posting pages',
  ),
  entry(
    'board',
    'Glassdoor Canada',
    ['glassdoor.ca'],
    'Glassdoor',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); posting pages sit behind a sign-in overlay after a few reads — the auth wall must refuse the overlay, never satisfy it',
  ),
  entry(
    'board',
    'Workopolis (Indeed-operated)',
    ['workopolis.com'],
    'Workopolis',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); inventory is Indeed-fed, so a Workopolis row is deduped against the Indeed row before it counts',
  ),
  entry(
    'board',
    'LinkedIn Jobs',
    ['linkedin.com'],
    'LinkedIn',
    OPERATOR_RATIFIED_2026_09_13,
    'public /jobs/view/<id> pages render signed out; browse and search redirect to the authwall after a few navigations — the lane reads a known posting URL, never walks search. Easy Apply, Save, Follow and Message controls must be refused by accessible name.',
  ),
  entry(
    'board',
    'ZipRecruiter (Canada inventory under ?country=ca)',
    ['ziprecruiter.com'],
    'ZipRecruiter',
    OPERATOR_RATIFIED_2026_09_13,
    'ziprecruiter.ca redirects to ziprecruiter.com/?country=ca (2026-09-13); whether the country parameter holds on posting pages and search',
  ),
  // --- aggregators: discovery pools, never the authoritative posting ---
  entry(
    'aggregator',
    'Adzuna Canada',
    ['adzuna.ca'],
    'Adzuna',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); an Adzuna row names the board it mirrors — verify there or on the employer page',
  ),
  entry(
    'aggregator',
    'Jooble Canada',
    ['jooble.org'],
    'Jooble',
    OPERATOR_RATIFIED_2026_09_13,
    'ca.jooble.org answers HTTP 403 to plain fetch (2026-09-13); the same mirror rule as Adzuna',
  ),
  entry(
    'aggregator',
    'CareerBeacon',
    ['careerbeacon.com'],
    'CareerBeacon',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); Atlantic-weighted inventory, Ontario postings thin — best-effort, never a mandatory lane',
  ),
  // --- union intake, apprenticeship and public-sector channels ---
  entry(
    'channel',
    'UA Local 46 (plumbers and steamfitters)',
    ['ualocal46.org'],
    'union',
    `${OPERATOR_RATIFIED_2026_09_13}; source-strategy.md "Union apprenticeship intake channels" (readable over WebFetch since 2026-09-05)`,
  ),
  entry(
    'channel',
    'SMWIA Local 30 (sheet metal)',
    ['smwia-l30.com'],
    'union',
    `${OPERATOR_RATIFIED_2026_09_13}; source-strategy.md "Union apprenticeship intake channels"`,
  ),
  entry(
    'channel',
    'Iron Workers Local 721',
    ['iw721.org'],
    'union',
    `${OPERATOR_RATIFIED_2026_09_13}; source-strategy.md "Union apprenticeship intake channels" (HTTP 403 to WebFetch since 2026-09-05 — the Bridge is the only unattended pathway that can read it)`,
    'whether the training/apprenticeship page renders in a normal browser context; if it does, the intake state becomes readable for the first time',
  ),
  entry(
    'channel',
    'LiUNA Local 183 (construction labourers)',
    ['liunalocal183.ca'],
    'union',
    OPERATOR_RATIFIED_2026_09_13,
    'liuna183.ca 301s to liunalocal183.ca (2026-09-13); what the training / membership pages publish about intake — lane E has no channel yet',
  ),
  entry(
    'channel',
    'Skilled Trades Ontario',
    ['skilledtradesontario.ca'],
    'union',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 200 to plain fetch (2026-09-13); the apprenticeship-pathway pages per trade, never a posting',
  ),
  entry(
    'channel',
    'ApprenticeSearch.com (Ontario apprenticeship job board)',
    ['apprenticesearch.com'],
    'union',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 200 to plain fetch (2026-09-13); whether postings render signed out and what the search URL shape is',
  ),
  entry(
    'channel',
    'Ontario.ca (apprenticeship program pages)',
    ['ontario.ca'],
    'union',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 200 to plain fetch (2026-09-13); read for the apprenticeship-registration pathway only, never as a posting source',
  ),
  entry(
    'channel',
    'George Brown College (career and co-op pages)',
    ['georgebrown.ca'],
    'union',
    OPERATOR_RATIFIED_2026_09_13,
    'HTTP 403 to plain fetch (2026-09-13); whether the careers / co-op pages render signed out — the student job board itself may sit behind a login the walls must refuse',
  ),
  // --- employer ATS hosts: where employer-direct postings actually render ---
  entry(
    'ats',
    'Workday (employer career sites)',
    ['myworkdayjobs.com'],
    'employer-direct',
    OPERATOR_RATIFIED_2026_09_13,
    'the apex has no A record; employer sites live at <employer>.wd<n>.myworkdayjobs.com and render client-side — whether a posting renders headlessly',
  ),
  entry(
    'ats',
    'SmartRecruiters',
    ['smartrecruiters.com'],
    'employer-direct',
    `${OPERATOR_RATIFIED_2026_09_13}; source-strategy.md names a Canam posting read on jobs.smartrecruiters.com (2026-09-11)`,
  ),
  entry('ats', 'Greenhouse', ['greenhouse.io'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'boards.greenhouse.io posting pages'),
  entry('ats', 'Lever', ['lever.co'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'jobs.lever.co posting pages'),
  entry('ats', 'BambooHR', ['bamboohr.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, '<employer>.bamboohr.com/careers pages'),
  entry('ats', 'iCIMS', ['icims.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'careers-<employer>.icims.com pages'),
  entry('ats', 'Jobvite', ['jobvite.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'jobs.jobvite.com posting pages'),
  entry('ats', 'JazzHR (applytojob.com)', ['applytojob.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, '<employer>.applytojob.com pages — the host name is not an apply path'),
  entry('ats', 'Njoyn (CGI)', ['njoyn.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'clients.njoyn.com posting pages, common on Ontario public-sector and utility employers'),
  // Narrow on purpose: the recruiting host only, never the payroll apexes.
  entry('ats', 'UKG Pro Recruiting (ultipro)', ['recruiting.ultipro.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'the JobBoardView pages render client-side'),
  entry('ats', 'ADP Workforce Now recruiting', ['workforcenow.adp.com'], 'employer-direct', OPERATOR_RATIFIED_2026_09_13, 'the apex redirected to the ADP sign-in landing (2026-09-13); only the /mascsr/ career-centre paths are readable and the landing is an auth wall'),
];
