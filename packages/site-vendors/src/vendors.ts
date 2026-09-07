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
    hosts: ['rushordertees.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'asset CDN host(s)',
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
    // a Spreadshirt registrable domain and is the operator's call.
    hosts: ['spreadshirt.ca', 'spreadshirt.com', 'spreadshirt.net', 'spreadshirtmedia.com'],
    addedOn: '2026-09-02',
    source: `${REPORT_2026_09_02}; spreadshirt.net and spreadshirtmedia.com added 2026-09-07 on gateway+coverage_gap+spreadshirt-create-your-own-designer-never-renders (2026-09-07 wardrobe fire)`,
    needsLiveVerification:
      'whether the create-your-own designer paints and states a personalized MOQ-1 price with create-omat.spreadshirt.net allowed (.ca prices confirmed in CAD 2026-09-07: C$39.99 catalog, C$59.99 PDP, minimum order 30 CAD)',
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
