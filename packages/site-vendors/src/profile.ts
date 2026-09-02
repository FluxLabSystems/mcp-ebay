/**
 * wardrobe-vendors.v1 policy configuration — a POLICY-ONLY profile on the
 * §19/§20 conventions the ebay/kijiji/zazzle profiles established. It
 * exists so the wardrobe routine can drive the vendors' JS-rendered
 * pricing and configurator pages with browser_navigate / browser_snapshot
 * / browser_click / browser_screenshot; it ships no extractor, and
 * browser_extract on one of these hosts says so (NO_EXTRACTOR_FOR_HOST)
 * rather than returning an eBay-shaped null record.
 *
 * Read-only research posture, identical in kind to the marketplace
 * profiles: no cart, no checkout, no account or credential surface, no
 * wishlist state. The walls are generic path tokens because they must
 * hold for every vendor on the roster, present and future, without a
 * per-vendor live study; they are segment-anchored (2026-08-31 standard)
 * so a product slug carrying "checkout" never matches an endpoint rule.
 *
 * Before 2026-09-02 the composite allowlist named only the three
 * marketplaces, so browser_navigate to www.vistaprint.ca died with
 * ORIGIN_DENIED on a live session and every non-Zazzle vendor was
 * WebFetch-only by accident rather than by decision.
 */
import type { SitePolicyProfile } from '@browser-bridge/policy';
import { WARDROBE_VENDORS } from './vendors.js';

export const WARDROBE_VENDORS_SITE_PROFILE_ID = 'wardrobe-vendors.v1';

/** Spec P1: entripy.com is permanently excluded from the wardrobe lane; deny wins. */
export const WARDROBE_VENDORS_DENIED_HOSTS: readonly string[] = ['entripy.com', '*.entripy.com'];

/** Allowlist derived from the roster: every apex plus wildcard subdomains. */
export const WARDROBE_VENDOR_ALLOWED_HOSTS: readonly string[] = WARDROBE_VENDORS.flatMap((vendor) =>
  vendor.hosts.flatMap((host) => [host, `*.${host}`]),
);

/** Regex alternation of every roster host, dot-escaped, for the URL walls below. */
const HOST_ALTERNATION = WARDROBE_VENDORS.flatMap((vendor) => vendor.hosts)
  .map((host) => host.replace(/\./g, '\\.'))
  .join('|');
const ANY_VENDOR_ORIGIN = `https?://(?:[a-z0-9-]+\\.)*(?:${HOST_ALTERNATION})`;

/**
 * Transaction/account endpoints. Generic on purpose: cart, checkout,
 * order, payment and billing paths on any roster host, wherever they sit
 * in the path, segment-anchored.
 */
export const WARDROBE_VENDORS_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  `${ANY_VENDOR_ORIGIN}/(?:.*/)?(?:cart|basket|checkout|order|orders|payment|payments|billing|purchase|buy)(?:/|\\?|#|$)`,
  // Account / credential surfaces (defense-in-depth behind authPathPatterns).
  `${ANY_VENDOR_ORIGIN}/(?:.*/)?(?:login|log-in|signin|sign-in|register|signup|sign-up|password|auth)(?:/|\\?|#|$)`,
  // Wishlist / favourite state mutation (low-consequence, still read-only).
  `${ANY_VENDOR_ORIGIN}/(?:.*/)?(?:wishlist|favou?rites?|collections?/add)(?:/|\\?|#|$)`,
];

/** Auth surfaces, blocked by default and re-checked per redirect landing. */
export const WARDROBE_VENDORS_AUTH_PATH_PATTERNS: readonly string[] = [
  `${ANY_VENDOR_ORIGIN}/(?:[a-zA-Z0-9_.~%-]+/)*(?:login|log-in|signin|sign-in|register|signup|sign-up|auth)(?:/|\\?|#|$)`,
];

/** Accessible-name deny patterns (lowercase substrings). */
export const WARDROBE_VENDORS_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'add to cart',
  'add to basket',
  'add to bag',
  'checkout',
  'proceed to checkout',
  'place order',
  'pay now',
  'buy now',
  'buy it now',
  'complete purchase',
  'add to wishlist',
  'save to wishlist',
  'add to favourites',
  'add to favorites',
  'sign in',
  'log in',
  'sign up',
  'register',
  'create account',
  'subscribe',
  'change password',
];

/** Same credential/payment autocomplete set as the other profiles. */
export const WARDROBE_VENDORS_BLOCKED_FIELD_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-exp',
  'cc-csc',
];

export const wardrobeVendorsSiteProfile: SitePolicyProfile = {
  id: WARDROBE_VENDORS_SITE_PROFILE_ID,
  allowedHosts: WARDROBE_VENDOR_ALLOWED_HOSTS,
  deniedHosts: WARDROBE_VENDORS_DENIED_HOSTS,
  blockedActionPatterns: WARDROBE_VENDORS_BLOCKED_ACTION_PATTERNS,
  blockedFieldAutocomplete: WARDROBE_VENDORS_BLOCKED_FIELD_AUTOCOMPLETE,
  transactionEndpointPatterns: WARDROBE_VENDORS_TRANSACTION_ENDPOINT_PATTERNS,
  authPathPatterns: WARDROBE_VENDORS_AUTH_PATH_PATTERNS,
};

/**
 * Whether a hostname (or a URL) belongs to a roster vendor. The agent's
 * extract dispatch uses it to answer NO_EXTRACTOR_FOR_HOST instead of
 * running a marketplace extractor on a vendor page.
 */
export function isWardrobeVendorHost(hostOrUrl: string): boolean {
  let host = hostOrUrl.trim().toLowerCase();
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  host = host.replace(/\.$/, '');
  return WARDROBE_VENDORS.some((vendor) =>
    vendor.hosts.some((apex) => host === apex || host.endsWith(`.${apex}`)),
  );
}
