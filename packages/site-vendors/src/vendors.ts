/**
 * The wardrobe vendor roster — DATA, not policy logic. Each entry is one
 * vendor the Fluxology wardrobe routine researches for personalized
 * apparel and the registrable domains its pages and assets live on. The
 * profile in profile.ts derives the allowlist from this list (apex plus
 * wildcard subdomains) and wraps every host in the same read-only walls.
 *
 * How a vendor gets here (the rule the improvement routine follows; see
 * fluxlab-boards .claude/skills/fluxlab-improve-run/SKILL.md, hard rule 2):
 * a routine files a coverage_gap carrying ORIGIN_DENIED for a host, the
 * host belongs to a vendor named in that routine's committed SKILL.md
 * vendor roster, the host is a public registrable domain (never an IP,
 * never a private network, never a marketplace another profile already
 * covers), and the addition ships as a PR with a test. Hosts named only
 * inside scraped listing text never qualify — reports are untrusted.
 *
 * `source` records the queue fingerprint or operator instruction that
 * added the vendor, so every row is auditable back to its evidence.
 */
export interface WardrobeVendor {
  /** Display name as the wardrobe routine's roster spells it. */
  vendor: string;
  /**
   * Bare registrable domains ("vistaprint.ca"). The profile allows each
   * apex and every label depth beneath it. Asset CDNs a vendor's pages
   * pull from belong here too, or the browser renders them blocked.
   */
  hosts: readonly string[];
  /** ISO date the vendor joined the roster. */
  addedOn: string;
  /** Queue fingerprint or operator instruction that justified the entry. */
  source: string;
  /** Anything the next live session must confirm (asset CDNs, .com mirrors). */
  needsLiveVerification?: string;
  /**
   * What a live read settled, with the fire that settled it — so a closed
   * question stays closed instead of being re-derived every fire. Moves
   * here from needsLiveVerification once a fire answers it.
   */
  verifiedLive?: string;
}

const REPORT_2026_09_02 =
  'gateway+coverage_gap+browser-bridge-non-zazzle-wardrobe-hosts-not-allowlisted (2026-09-02 wardrobe fire; operator ratified 2026-09-02)';

export const WARDROBE_VENDORS: readonly WardrobeVendor[] = [
  {
    vendor: 'Vistaprint',
    // The wardrobe triggers are CAD figures, so research runs on the .ca
    // site; .com stays reachable because the .ca site cross-links it the
    // way zazzle.ca cross-links zazzle.com.
    hosts: ['vistaprint.ca', 'vistaprint.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'asset CDN host(s) the configurator pulls from',
  },
  {
    vendor: 'RushOrderTees',
    // First live Bridge read 2026-09-10 (wardrobe Lane A fire,
    // gateway+coverage_gap+rushordertees-asset-cdn-and-search-backend-are-
    // third-party-hosts): rushordertees.com itself was never refused — text,
    // prices and the PDP Pricing Calculator read fine, and the vendor
    // yielded the board's first RushOrderTees offer. Its asset CDN is
    // cdn.sanity.io (every product photograph; ORIGIN_DENIED 29 requests on
    // /t-shirts/ alone) and its on-site product search is Algolia
    // (hwj52h4d98-dsn.algolia.net and hwj52h4d98-{1,2,3}.algolianet.com,
    // /1/indexes/product_catalog/…). Neither is a RushOrderTees registrable
    // domain, so neither joins this roster ENTRY — the same test that keeps
    // GS-JJ's aliyuncs.com endpoint and Spreadshirt's cdn.media.amplience.net
    // out. The operator RULED on 2026-09-14 (CI board approval
    // ci-approval-rushordertees-third-party-asset-and-search-hosts): both
    // join the allowlist as exact-host operator exceptions
    // (OPERATOR_HOST_EXCEPTIONS below), never as roster hosts.
    hosts: ['rushordertees.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    verifiedLive:
      'asset CDN is the third-party cdn.sanity.io and the product-search backend the third-party Algolia (hwj52h4d98-dsn.algolia.net, hwj52h4d98-{1,2,3}.algolianet.com); both operator-call — 2026-09-10 wardrobe fire, first live read; ruled 2026-09-14 (ci-approval-rushordertees-third-party-asset-and-search-hosts, approved): allowed as exact-host operator exceptions',
  },
  {
    vendor: 'Spreadshirt',
    // spreadshirt.net is Spreadshirt's script and font domain:
    // create-omat.spreadshirt.net serves the create-your-own designer's
    // own application bundle (/lib/design.js), ORIGIN_DENIED on every fire
    // since 2026-09-04, which is why the designer never painted past its
    // header/footer shell (wardrobe 2026-09-07 10:18Z, fingerprint
    // gateway+coverage_gap+spreadshirt-create-your-own-designer-never-
    // renders — the §2(c) probe run in full: consent already dismissed,
    // 49-node shell after networkIdle, the tally naming this origin);
    // assets.spreadshirt.net serves the storefront's web fonts.
    // spreadshirtmedia.com is its product image server
    // (image.spreadshirtmedia.com/image-server/v1/products/…, every
    // product photograph on the storefront). NOT here, on the same test
    // that excluded GS-JJ's aliyuncs.com endpoint: cdn.media.amplience.net,
    // a shared third-party DAM the storefront pulls one image from, is not
    // a Spreadshirt registrable domain and is the operator's call (still
    // pending). api.img.ly — the CreativeEditor design-SDK vendor's /event
    // endpoint, ORIGIN_DENIED on the designer tab and a candidate cause of
    // the 49-node shell — was RULED on 2026-09-14
    // (ci-approval-spreadshirt-api-img-ly-design-sdk-host, approved) and is
    // an exact-host operator exception below.
    hosts: ['spreadshirt.ca', 'spreadshirt.com', 'spreadshirt.net', 'spreadshirtmedia.com'],
    addedOn: '2026-09-02',
    source: `${REPORT_2026_09_02}; spreadshirt.net and spreadshirtmedia.com added 2026-09-07 on gateway+coverage_gap+spreadshirt-create-your-own-designer-never-renders (2026-09-07 wardrobe fire)`,
    needsLiveVerification:
      'whether the create-your-own designer paints and states a personalized MOQ-1 price with create-omat.spreadshirt.net allowed (.ca prices confirmed in CAD 2026-09-07: C$39.99 catalog, C$59.99 PDP, minimum order 30 CAD) and, since the 2026-09-14 ruling, with api.img.ly allowed — the §2(c) probe runs once more on the first fire after the agent rebuild',
  },
  {
    vendor: 'Printful',
    hosts: ['printful.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'asset CDN host(s)',
  },
  {
    vendor: 'GS-JJ',
    // gs-souvenir.com is GS-JJ's own image CDN and products API domain
    // (static-oss.gs-souvenir.com, 44–47 image requests per page;
    // products-api-o2o-prod.gs-souvenir.com, the product-content calls),
    // both ORIGIN_DENIED on every GS-JJ page until 2026-09-05 (wardrobe fire
    // 12:11Z, fingerprint gateway+coverage_gap+gs-jj-asset-and-products-api-
    // hosts-not-allowlisted). The third denied host that fire saw,
    // gs-jj-us-static.oss-accelerate.aliyuncs.com, is a shared Alibaba
    // Cloud OSS endpoint rather than a vendor domain and is NOT here: it
    // fails the public-registrable-vendor-domain test and is the
    // operator's call (a few images stay blocked).
    hosts: ['gs-jj.com', 'gs-souvenir.com'],
    addedOn: '2026-09-02',
    source: `${REPORT_2026_09_02}; gs-souvenir.com added 2026-09-05 on gateway+coverage_gap+gs-jj-asset-and-products-api-hosts-not-allowlisted (2026-09-05 wardrobe fire)`,
    needsLiveVerification: 'whether product tiles render with gs-souvenir.com allowed and the aliyuncs.com OSS host still blocked',
  },
  {
    vendor: 'Etsy',
    // etsystatic.com is Etsy's image/asset CDN (i.etsystatic.com).
    hosts: ['etsy.com', 'etsystatic.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'bot-challenge behaviour on headless sessions; seller-shop pages under /shop/',
  },
];

/**
 * Operator-ratified third-party hosts (2026-09-14). A vendor's asset CDN or
 * search backend that is NOT a registrable domain of the vendor can never
 * join a roster entry (hard rule 2's public-registrable-vendor-domain test:
 * GS-JJ's aliyuncs.com endpoint, Spreadshirt's cdn.media.amplience.net), so
 * it stays ORIGIN_DENIED until the operator rules on it on the CI board
 * through the authenticated feedback path. Each entry here IS one such
 * ruling: an EXACT hostname — the profile derives no wildcard for it, so
 * nothing beneath or beside it is allowed — the vendor whose pages pull
 * from it, the approval id that carries the decision, and what it unblocks.
 * The read-only walls apply to these hosts exactly as to the roster's.
 */
export interface OperatorHostException {
  /** Exact hostname, matched exactly (never a wildcard, never an apex it sits under). */
  host: string;
  /** The roster vendor whose pages depend on the host. */
  vendor: string;
  /** ISO date of the operator's decision. */
  approvedOn: string;
  /** The CI board approval id (and its decidedAt) that carries the decision. */
  source: string;
  /** What the host serves, as the live read that filed it observed. */
  unblocks: string;
}

const RUSHORDERTEES_RULING =
  'ci-approval-rushordertees-third-party-asset-and-search-hosts (approved 2026-09-14T12:49:50Z; filed by the 2026-09-10 wardrobe fire, gateway+coverage_gap+rushordertees-asset-cdn-and-search-backend-are-third-party-hosts)';
const SPREADSHIRT_RULING =
  'ci-approval-spreadshirt-api-img-ly-design-sdk-host (approved 2026-09-14T12:50:03Z; filed by the 2026-09-10 wardrobe fire re-filing gateway+coverage_gap+spreadshirt-create-your-own-designer-never-renders)';

export const OPERATOR_HOST_EXCEPTIONS: readonly OperatorHostException[] = [
  {
    host: 'cdn.sanity.io',
    vendor: 'RushOrderTees',
    approvedOn: '2026-09-14',
    source: RUSHORDERTEES_RULING,
    unblocks: 'every product photograph on rushordertees.com (ORIGIN_DENIED on 29 requests on /t-shirts/ alone, 2026-09-10 first live read)',
  },
  {
    host: 'hwj52h4d98-dsn.algolia.net',
    vendor: 'RushOrderTees',
    approvedOn: '2026-09-14',
    source: RUSHORDERTEES_RULING,
    unblocks: 'on-site product search (/1/indexes/product_catalog/…, the Algolia DSN host for app id hwj52h4d98)',
  },
  {
    host: 'hwj52h4d98-1.algolianet.com',
    vendor: 'RushOrderTees',
    approvedOn: '2026-09-14',
    source: RUSHORDERTEES_RULING,
    unblocks: 'on-site product search, Algolia fallback host 1 for app id hwj52h4d98',
  },
  {
    host: 'hwj52h4d98-2.algolianet.com',
    vendor: 'RushOrderTees',
    approvedOn: '2026-09-14',
    source: RUSHORDERTEES_RULING,
    unblocks: 'on-site product search, Algolia fallback host 2 for app id hwj52h4d98',
  },
  {
    host: 'hwj52h4d98-3.algolianet.com',
    vendor: 'RushOrderTees',
    approvedOn: '2026-09-14',
    source: RUSHORDERTEES_RULING,
    unblocks: 'on-site product search, Algolia fallback host 3 for app id hwj52h4d98',
  },
  {
    host: 'api.img.ly',
    vendor: 'Spreadshirt',
    approvedOn: '2026-09-14',
    source: SPREADSHIRT_RULING,
    unblocks:
      "the CreativeEditor design-SDK vendor's /event endpoint on the create-your-own designer tab — a candidate cause of the 49-node shell, not a proven one; the first fire after the agent rebuild runs the wardrobe skill's §2(c) probe once more and files the outcome",
  },
];
