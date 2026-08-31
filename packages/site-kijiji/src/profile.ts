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
  // A Kijiji VIP slug is seller-written ad-title text, so every plain-word
  // token below is segment-anchored: `(?:.*/)?token` requires the token to
  // START a path segment, and a trailing boundary closes it. The old
  // free-substring forms aborted real ads — "antique-cash-register",
  // "lamp-post", "gaming-chat", "fire-alerts" all matched a deny keyword.
  // Kijiji's own t-/p-/r- route prefixes keep prefix matching (no ad slug
  // realistically starts with "t-login"); over-blocking on those is fine.
  //
  // Reply / messaging flows (never contact posters in the read-only MVP).
  // m-msg is Kijiji's real inbox route prefix.
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:r-reply|m-msg|contact-poster|send-message)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:reply|messages?|conversations?|chat)(?:\\.html)?(?:/|\\?|#|$)',
  // Ad posting / ad management
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:p-post-ad|p-select-category|p-edit-ad|p-delete-ad|p-promote|p-activate)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?post(?:/|\\?|#|$)',
  // Payments / promotion checkout / billing
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:payment|checkout|billing|purchase)(?:\\.html)?(?:/|\\?|#|$)',
  // Account security / credentials
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:t-login|t-register)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:login|log-in|register|signin|sign-in|password)(?:\\.html)?(?:/|\\?|#|$)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?account/security',
  // Favourite / watchlist / saved-search / alert state mutation
  // (low-consequence state, still blocked in MVP). The m- forms are
  // Kijiji's real account routes (/m-my-favourites/, /m-saved-searches/).
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:m-my-favou?rites?|m-saved-search(?:es)?)',
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:.*/)?(?:favou?rites?|watchlist|saved-search|save-search|alerts?)(?:\\.html)?(?:/|\\?|#|$)',
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

/**
 * Auth-surface deny rules (blocked by default; see SitePolicyProfile).
 * Kijiji's login was already caught by the transaction-endpoint patterns
 * above; it is restated here so the auth posture is uniform across profiles
 * and enforced per redirect hop, and the central id host is named for the
 * post-redirect case. Over-blocking is acceptable, under-blocking is not.
 */
export const KIJIJI_AUTH_PATH_PATTERNS: readonly string[] = [
  // Auth tokens as COMPLETE path segments only: /t-login.html is blocked,
  // while a cash-register VIP slug ("antique-cash-register") never matches,
  // because "register" there is not a whole segment. (The broader
  // transaction-endpoint patterns above predate this rule and match
  // substrings; they abort requests, so their over-match is a known cost —
  // this list must not add to it.)
  'https?://(?:[a-z0-9-]+\\.)*kijiji\\.ca/(?:[a-zA-Z0-9_.~%-]+/)*(?:t-login|t-register|login|log-in|register|signin|sign-in|signup|sign-up)(?:\\.html)?(?:/|\\?|#|$)',
  // Central identity host, in case a login link hops off www.kijiji.ca.
  'https?://id\\.kijiji\\.ca/',
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
  authPathPatterns: KIJIJI_AUTH_PATH_PATTERNS,
};
