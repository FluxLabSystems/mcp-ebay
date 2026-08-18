/**
 * kijiji.ca.v1 policy configuration — modeled on ebay.ca.v1 (SDD v0.5 §19,
 * §20, Appendix C conventions). Version changes are explicit; the id
 * participates in extraction records.
 *
 * MVP posture is strictly read-only research: no replying, posting,
 * favouriting, paying, or account mutation of any kind.
 */
import type { SitePolicyProfile } from '@browser-bridge/policy';

export const KIJIJI_SITE_PROFILE_ID = 'kijiji.ca.v1';

/**
 * Transaction/account endpoint deny rules matched by the browser network
 * layer (§19.2). Sources are case-insensitive regexes over full URLs.
 * These are defense-in-depth behind the accessible-name deny patterns;
 * they intentionally use broad path-keyword matching under the kijiji.ca
 * host group, in the style of EBAY_TRANSACTION_ENDPOINT_PATTERNS.
 *
 * NEEDS-LIVE-VERIFICATION: the concrete Kijiji path keywords below
 * (r-reply, p-post-ad, anvil messaging APIs, favourites/saved-search API
 * shapes) are best-effort from historical URL shapes and must be checked
 * against live network traces; over-blocking is acceptable, under-blocking
 * is not.
 */
export const KIJIJI_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  // Reply / messaging flows (never contact posters in the read-only MVP)
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:r-reply|reply|contact-poster|send-message)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:messages?|conversations?|chat)(?:/|\\?|$)',
  // Ad posting / ad management
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:p-post-ad|p-select-category|p-edit-ad|p-delete-ad|p-promote|p-activate)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?/post(?:/|\\?|$)',
  // Payments / promotion checkout / billing
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:payment|checkout|billing|purchase)',
  // Account security / credentials
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:t-login|t-register|login|register|signin|sign-in|password|account/security)',
  // Favourite / watchlist / saved-search / alert state mutation
  // (low-consequence state, still blocked in MVP)
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*)?(?:favou?rites?|watchlist|saved-search|save-search|alerts?)(?:/|\\?|$)',
];

/**
 * Accessible-name deny patterns (lowercase substrings): everything
 * transactional or state-mutating is blocked for the read-only MVP.
 */
export const KIJIJI_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'reply',
  'send message',
  'contact poster',
  'make an offer',
  'make offer',
  'buy now',
  'pay',
  'checkout',
  'post ad',
  'post your ad',
  'promote',
  'edit ad',
  'delete ad',
  'activate',
  'add to favourites',
  'add to favorites',
  'save ad',
  'save search',
  'set alert',
  'change password',
  'security settings',
  'sign in',
  'register',
];

/** Same credential/payment autocomplete set as ebay.ca.v1. */
export const KIJIJI_BLOCKED_FIELD_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-exp',
  'cc-csc',
];

/**
 * kijiji.ca.v1 site profile.
 *
 * No destinationPostalCode: Kijiji is a pickup-radius marketplace, not a
 * shipping-destination one. The mandatory Fluxology 45 km and 65 km radius
 * passes are traversal inputs (see traversal.ts), not policy data.
 */
export const kijijiSiteProfile: SitePolicyProfile = {
  id: KIJIJI_SITE_PROFILE_ID,
  allowedHosts: [
    'kijiji.ca',
    '*.kijiji.ca',
    // Kijiji image/asset CDN (equivalent of ebaystatic/ebayimg).
    'classistatic.com',
    '*.classistatic.com',
    // NEEDS-LIVE-VERIFICATION: confirm no additional first-party asset hosts
    // are required on live VIP/search pages (e.g. ca-kijiji-production
    // buckets or Akamai aliases). Add here only after observing real traffic;
    // do not preemptively widen the allowlist.
  ],
  blockedActionPatterns: KIJIJI_BLOCKED_ACTION_PATTERNS,
  blockedFieldAutocomplete: KIJIJI_BLOCKED_FIELD_AUTOCOMPLETE,
  transactionEndpointPatterns: KIJIJI_TRANSACTION_ENDPOINT_PATTERNS,
};
