/**
 * Build a read-only, policy-only site profile from nothing but a host roster.
 *
 * Every profile in this repo that has no extractor — wardrobe-vendors.v1 today,
 * and the office / jobs / vacation research lanes on the backlog — needs the
 * same walls: no cart, no checkout, no order or payment path, no account or
 * credential surface, no wishlist or follow state, and the standard secret-field
 * autocomplete set. wardrobe-vendors.v1 wrote all of that out by hand, which is
 * ~150 lines per lane, and every hand-written copy is a chance to leave one wall
 * out of one lane.
 *
 * This builds the same walls from the roster. A lane profile becomes:
 *
 *     export const officeSiteProfile = createResearchProfile({
 *       id: 'office-sources.v1',
 *       hosts: OFFICE_SOURCES.flatMap((s) => s.hosts),
 *     });
 *
 * What it deliberately does NOT do is decide which hosts belong. A host reaches
 * a roster only the way packages/site-vendors/src/vendors.ts documents: a
 * routine files a coverage_gap carrying a real ORIGIN_DENIED for it, the host
 * belongs to a source named in that routine's committed SKILL.md, it is a public
 * registrable domain, and it ships as a PR with a test. Hosts named only inside
 * scraped page text never qualify — extraction output is untrusted.
 *
 * The patterns are segment-anchored (the 2026-08-31 standard): a token must
 * START a path segment and be closed by a boundary, so a product slug like
 * "antique-cash-register" or "lamp-post" never matches an endpoint rule. That
 * bug is why the kijiji profile's rules are anchored, and the same reasoning
 * applies to any site whose URLs carry seller-written text.
 */
import type { SitePolicyProfile } from './types.js';

/** Transaction path tokens: anything that moves money or an order. */
const TRANSACTION_TOKENS = [
  'cart', 'basket', 'bag', 'checkout', 'order', 'orders', 'payment', 'payments',
  'billing', 'invoice', 'purchase', 'buy', 'booking', 'bookings', 'reserve', 'reservation',
] as const;

/** Credential path tokens. Also covered by authPathPatterns; this is depth. */
const AUTH_TOKENS = [
  'login', 'log-in', 'signin', 'sign-in', 'signout', 'sign-out', 'logout',
  'register', 'signup', 'sign-up', 'password', 'auth', 'oauth', 'sso', 'account',
] as const;

/** State the bridge must not mutate even though it costs nothing. */
const STATE_TOKENS = [
  'wishlist', 'wishlists', 'favourite', 'favourites', 'favorite', 'favorites',
  'watchlist', 'saved-search', 'save-search', 'alerts', 'subscribe', 'follow',
  'apply', 'application', 'applications', 'enquire', 'enquiry', 'inquiry',
  'contact-agent', 'contact-seller', 'message', 'messages',
] as const;

/**
 * Accessible-name deny substrings. Matched case-insensitively against an
 * element's accessible name, so they catch the button whose href reveals
 * nothing — a JS-driven "Apply now" with href="#" is the common case on job
 * boards and office listing sites.
 */
const BLOCKED_ACTION_PATTERNS = [
  'add to cart', 'add to basket', 'add to bag', 'checkout', 'proceed to checkout',
  'place order', 'pay now', 'buy now', 'buy it now', 'complete purchase',
  'book now', 'reserve now', 'confirm booking', 'request a tour', 'book a tour',
  'add to wishlist', 'save to wishlist', 'add to favourites', 'add to favorites',
  'save search', 'create alert', 'set alert', 'follow',
  'apply now', 'easy apply', 'quick apply', 'submit application',
  'contact agent', 'contact seller', 'send message', 'request info', 'request information',
  'sign in', 'log in', 'sign up', 'register', 'create account', 'subscribe',
  'change password', 'delete account',
] as const;

/** The same credential/payment autocomplete set every profile in this repo uses. */
const BLOCKED_FIELD_AUTOCOMPLETE = [
  'current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-exp', 'cc-csc',
] as const;

function escapeHost(host: string): string {
  return host.replace(/^\*\./, '').replace(/\./g, '\\.');
}

/** `https?://(any labels).(a|b|c)` — the origin half of every wall below. */
function originAlternation(hosts: readonly string[]): string {
  const bare = [...new Set(hosts.map((h) => h.trim().toLowerCase()).filter(Boolean))].map(escapeHost);
  if (!bare.length) throw new Error('createResearchProfile requires at least one host');
  return `https?://(?:[a-z0-9-]+\\.)*(?:${bare.join('|')})`;
}

// Segment-anchored, boundary-closed: the token must start a path segment and
// be closed by a slash, query, fragment or end of string.
function pathAlternation(origin: string, tokens: readonly string[]): string {
  return `${origin}/(?:.*/)?(?:${tokens.join('|')})(?:/|\\?|#|$)`;
}

export interface ResearchProfileSpec {
  /** Versioned id, e.g. "office-sources.v1". */
  id: string;
  /**
   * Bare registrable domains. Each apex and every label depth beneath it is
   * allowed, so asset CDNs a site pulls from belong here too or the page
   * renders with its images blocked.
   */
  hosts: readonly string[];
  /**
   * Hosts ruled out permanently. Deny wins over the allowlist and over any
   * later widening of it, so a mistyped URL can never reach them.
   */
  deniedHosts?: readonly string[];
  /** Extra accessible-name deny substrings for this lane, lower-cased. */
  extraBlockedActionPatterns?: readonly string[];
  /** Extra full-URL deny regex sources for this lane. */
  extraTransactionEndpointPatterns?: readonly string[];
  /** Where destination-resolved figures (shipping, delivery) must resolve to. */
  destinationPostalCode?: string;
}

export function createResearchProfile(spec: ResearchProfileSpec): SitePolicyProfile {
  const origin = originAlternation(spec.hosts);
  const allowedHosts = [
    ...new Set(
      spec.hosts
        .map((h) => h.trim().toLowerCase().replace(/^\*\./, ''))
        .filter(Boolean)
        .flatMap((host) => [host, `*.${host}`]),
    ),
  ];
  return {
    id: spec.id,
    allowedHosts,
    ...(spec.deniedHosts?.length ? { deniedHosts: spec.deniedHosts } : {}),
    blockedActionPatterns: [...BLOCKED_ACTION_PATTERNS, ...(spec.extraBlockedActionPatterns ?? [])],
    blockedFieldAutocomplete: [...BLOCKED_FIELD_AUTOCOMPLETE],
    transactionEndpointPatterns: [
      pathAlternation(origin, TRANSACTION_TOKENS),
      pathAlternation(origin, AUTH_TOKENS),
      pathAlternation(origin, STATE_TOKENS),
      ...(spec.extraTransactionEndpointPatterns ?? []),
    ],
    authPathPatterns: [
      // Same token set, but matched through named path segments only, so it
      // holds on a redirect landing as well as on the requested URL.
      `${origin}/(?:[a-zA-Z0-9_.~%-]+/)*(?:${AUTH_TOKENS.join('|')})(?:/|\\?|#|$)`,
    ],
    ...(spec.destinationPostalCode ? { destinationPostalCode: spec.destinationPostalCode } : {}),
  };
}
