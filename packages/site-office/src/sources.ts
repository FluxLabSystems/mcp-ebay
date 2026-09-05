/**
 * The office-source roster — DATA, not policy logic. Each entry is one
 * source the Fluxology office routine researches for GTA private offices
 * and the registrable domains its pages live on. profile.ts derives the
 * allowlist from this list (apex plus wildcard subdomains) through
 * createResearchProfile, so every host sits behind the same read-only walls.
 *
 * How a host gets here (docs/SITE-PROFILE-BACKLOG.md, "The rule a host gets
 * here by"): a routine files the ORIGIN_DENIED, the host belongs to a source
 * the operator controls in committed repo content, it is a public registrable
 * domain, and the addition ships as a PR with a test. Hosts named only inside
 * scraped listing text never qualify.
 *
 * This roster was ratified by the operator in the live session of
 * 2026-09-05 (the "operator override" the office routine's 13:50Z report
 * relays, confirmed to the improvement routine by the operator in-session),
 * on the ORIGIN_DENIED the same fire filed for www.regus.com. `source` on
 * every row records that, so each host is auditable back to its evidence.
 */
export interface OfficeSource {
  /** Display name as the office routine's roster spells it. */
  name: string;
  /**
   * `provider`: a managed-office operator's own marketing / location pages.
   * `listing`: an aggregator or MLS surface where non-managed offices are
   * listed (square footage, TMI, lease structure live there).
   */
  group: 'provider' | 'listing';
  /**
   * Bare registrable domains, or — where a provider lives on one subdomain
   * of a large retailer — the narrowest host that covers it. The profile
   * allows each entry and every label depth beneath it.
   */
  hosts: readonly string[];
  /** ISO date the source joined the roster. */
  addedOn: string;
  /** Queue fingerprint or operator instruction that justified the entry. */
  source: string;
  /** Anything the next live session must confirm. */
  needsLiveVerification?: string;
}

const OPERATOR_RATIFIED_2026_09_05 =
  'mcp-ebay+site_profile_request+operator-ratified-managed-office-provider-roster (office fire 2026-09-05 13:50Z: ORIGIN_DENIED on www.regus.com; roster ratified by the operator in-session 2026-09-05)';
const BACKLOG_ROW =
  'docs/SITE-PROFILE-BACKLOG.md office-sources.v1 row (host named in the committed managed-providers.json roster)';

const provider = (name: string, hosts: readonly string[], needsLiveVerification?: string): OfficeSource => ({
  name,
  group: 'provider',
  hosts,
  addedOn: '2026-09-05',
  source: OPERATOR_RATIFIED_2026_09_05,
  ...(needsLiveVerification ? { needsLiveVerification } : {}),
});
const listing = (name: string, hosts: readonly string[], needsLiveVerification?: string): OfficeSource => ({
  name,
  group: 'listing',
  hosts,
  addedOn: '2026-09-05',
  source: OPERATOR_RATIFIED_2026_09_05,
  ...(needsLiveVerification ? { needsLiveVerification } : {}),
});

export const OFFICE_SOURCES: readonly OfficeSource[] = [
  // --- managed-office providers (Deliverable B) ---
  provider('IWG — Regus', ['regus.com'], 'JS-rendered location pages; "Get a quote" is the only route to an all-in figure and stays blocked'),
  provider('IWG — Spaces', ['spacesworks.com'], 'asset CDN host(s)'),
  provider('IWG — HQ', ['hq.com'], 'whether GTA pages price the enclosed office SKU'),
  provider('Industrious', ['industriousoffice.com']),
  provider('WeWork', ['wework.com'], 'bot-challenge behaviour headlessly'),
  provider('iQ Offices', ['iqoffices.com']),
  provider('Venture X', ['venturex.com']),
  provider('Intelligent Office', ['intelligentoffice.com']),
  provider('Telsec', ['telsec.net']),
  provider('Workhaus', ['workhaus.ca']),
  provider('Workplace One', ['workplaceone.com']),
  {
    name: 'Zemlar Offices',
    group: 'provider',
    hosts: ['zemlar.com', 'zemlar.ca'],
    addedOn: '2026-09-05',
    source: `${OPERATOR_RATIFIED_2026_09_05}; zemlar.ca from ${BACKLOG_ROW}`,
    needsLiveVerification: 'which of .com / .ca serves the GTA location pages',
  },
  provider('OnePlan', ['oneplan.ca']),
  provider('CollabHive', ['collabhive.ca']),
  provider('GT Executive Centre', ['gtexecutivecentre.com']),
  // Narrow on purpose: the provider lives on one subdomain of a large
  // retailer whose apex carries a checkout; the apex is NOT allowed.
  provider('Staples Studio', ['studio.staples.ca']),
  provider('Workplace K', ['workplacek.com']),
  provider('Office 146', ['office146.com']),
  provider('The Fueling Station', ['thefuelingstation.com']),
  // --- aggregator and MLS listing surfaces (Deliverable A) ---
  listing('REALTOR.ca (CREA MLS)', ['realtor.ca'], 'HTTP 403 to plain fetch; whether the listing detail renders headlessly'),
  listing('LiquidSpace', ['liquidspace.com'], 'booking flows are one click from every listing; the walls must hold by accessible name'),
  listing('Office Hub', ['office-hub.com']),
  listing('Spacelist', ['spacelist.ca'], 'HTTP 403 to plain fetch (2026-09-02); whether the Bridge renders listing 280814'),
  listing('CoworkingCafe', ['coworkingcafe.com']),
  listing('CommercialCafe', ['commercialcafe.com']),
  listing('LoopNet Canada', ['loopnet.ca']),
];
