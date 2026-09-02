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
    hosts: ['spreadshirt.ca', 'spreadshirt.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'asset CDN host(s); whether .ca serves CAD pricing',
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
    hosts: ['gs-jj.com'],
    addedOn: '2026-09-02',
    source: REPORT_2026_09_02,
    needsLiveVerification: 'asset CDN host(s)',
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
