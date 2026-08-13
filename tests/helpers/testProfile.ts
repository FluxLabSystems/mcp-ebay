/**
 * Test-only site profile serving local fixtures over 127.0.0.1. Production
 * profiles never set testOnly flags; security tests assert ebay.ca.v1
 * keeps them unset.
 */
import type { SitePolicyProfile } from '@browser-bridge/policy';
import {
  EBAY_BLOCKED_ACTION_PATTERNS,
  EBAY_BLOCKED_FIELD_AUTOCOMPLETE,
} from '@browser-bridge/site-ebay';

export function makeFixtureProfile(extra: Partial<SitePolicyProfile> = {}): SitePolicyProfile {
  return {
    id: 'fixture.test.v1',
    allowedHosts: ['127.0.0.1', 'localhost'],
    blockedActionPatterns: EBAY_BLOCKED_ACTION_PATTERNS,
    blockedFieldAutocomplete: EBAY_BLOCKED_FIELD_AUTOCOMPLETE,
    transactionEndpointPatterns: ['https?://127\\.0\\.0\\.1:\\d+/(?:checkout|placebid|bestoffer|cart/add)'],
    destinationPostalCode: 'M6H 2W9',
    testOnly: { allowInsecureHttp: true, allowPrivateNetworks: true },
    ...extra,
  };
}
