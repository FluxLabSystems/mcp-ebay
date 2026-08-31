/**
 * zazzle.com.v1 policy configuration — spec P1, on the §19/§20 conventions
 * the ebay/kijiji profiles established. Read-only research posture: no cart,
 * no checkout, no account actions, no "like"/collection state.
 */
import type { SitePolicyProfile } from '@browser-bridge/policy';

export const ZAZZLE_SITE_PROFILE_ID = 'zazzle.com.v1';

/**
 * Spec P1: entripy.com is permanently excluded from the wardrobe lane, and
 * the exclusion lives in POLICY so a mistyped URL cannot reach it — deny
 * wins over every present or future allowlist entry (see
 * SitePolicyProfile.deniedHosts).
 */
export const ZAZZLE_DENIED_HOSTS: readonly string[] = ['entripy.com', '*.entripy.com'];

/**
 * Transaction/account endpoints. Zazzle's cart lives under /co/ (observed
 * live: /co/cart). Plain-word tokens are segment-anchored per the 2026-08-31
 * standard so a product slug ("custom_checkout_counter_sign-…") never
 * matches an endpoint rule.
 */
export const ZAZZLE_TRANSACTION_ENDPOINT_PATTERNS: readonly string[] = [
  'https?://(?:[a-z0-9-]+\\.)*zazzle\\.com/co/(?:cart|checkout|order|payment)',
  'https?://(?:[a-z0-9-]+\\.)*zazzle\\.com/(?:.*/)?(?:checkout|payment|billing|purchase)(?:/|\\?|#|$)',
  // Account / credential surfaces (defense-in-depth behind authPathPatterns).
  'https?://(?:[a-z0-9-]+\\.)*zazzle\\.com/(?:.*/)?(?:lgn|login|log-in|signin|sign-in|register|signup|sign-up|password)(?:/|\\?|#|$)',
  // Wishlist/collection state mutation (low-consequence, still read-only MVP).
  'https?://(?:[a-z0-9-]+\\.)*zazzle\\.com/(?:.*/)?(?:wishlist|collections?/add|favou?rites?)(?:/|\\?|#|$)',
];

/** Auth surfaces, blocked by default and re-checked per redirect landing. */
export const ZAZZLE_AUTH_PATH_PATTERNS: readonly string[] = [
  'https?://(?:[a-z0-9-]+\\.)*zazzle\\.com/(?:[a-zA-Z0-9_.~%-]+/)*(?:lgn|login|log-in|signin|sign-in|register|signup|sign-up)(?:/|\\?|#|$)',
];

/** Accessible-name deny patterns (lowercase substrings). */
export const ZAZZLE_BLOCKED_ACTION_PATTERNS: readonly string[] = [
  'add to cart',
  'checkout',
  'proceed to checkout',
  'place order',
  'pay now',
  'buy now',
  'add to liked products',
  'add to collection',
  'save to wishlist',
  'sign in',
  'sign up',
  'register',
  'subscribe',
  'change password',
];

/** Same credential/payment autocomplete set as the other profiles. */
export const ZAZZLE_BLOCKED_FIELD_AUTOCOMPLETE: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-exp',
  'cc-csc',
];

export const zazzleSiteProfile: SitePolicyProfile = {
  id: ZAZZLE_SITE_PROFILE_ID,
  allowedHosts: [
    'zazzle.com',
    '*.zazzle.com',
    // Product/render image CDN (rlv.zcache.com observed live).
    'zcache.com',
    '*.zcache.com',
  ],
  deniedHosts: ZAZZLE_DENIED_HOSTS,
  blockedActionPatterns: ZAZZLE_BLOCKED_ACTION_PATTERNS,
  blockedFieldAutocomplete: ZAZZLE_BLOCKED_FIELD_AUTOCOMPLETE,
  transactionEndpointPatterns: ZAZZLE_TRANSACTION_ENDPOINT_PATTERNS,
  authPathPatterns: ZAZZLE_AUTH_PATH_PATTERNS,
};
