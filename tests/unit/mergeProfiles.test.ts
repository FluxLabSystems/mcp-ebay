import { describe, expect, it } from 'vitest';
import { mergeSiteProfiles, type SitePolicyProfile } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
// The tests package deliberately imports site-kijiji by relative path (see
// kijijiExtract.test.ts for the tests/package.json rationale).
import { kijijiSiteProfile } from '../../packages/site-kijiji/src/index.js';
import { loadAgentConfig } from '@browser-bridge/config';

describe('mergeSiteProfiles', () => {
  it('returns a single profile unchanged (identity, id preserved)', () => {
    expect(mergeSiteProfiles([ebaySiteProfile])).toBe(ebaySiteProfile);
  });

  it('rejects an empty profile list', () => {
    expect(() => mergeSiteProfiles([])).toThrow(/at least one/);
  });

  it('composes ebay+kijiji: union of every allow and deny list, composite id', () => {
    const merged = mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile]);
    expect(merged.id).toBe('ebay.ca.v1+kijiji.ca.v1');
    for (const source of [ebaySiteProfile, kijijiSiteProfile]) {
      for (const host of source.allowedHosts) expect(merged.allowedHosts).toContain(host);
      for (const pattern of source.blockedActionPatterns) expect(merged.blockedActionPatterns).toContain(pattern);
      for (const token of source.blockedFieldAutocomplete) expect(merged.blockedFieldAutocomplete).toContain(token);
      for (const endpoint of source.transactionEndpointPatterns) {
        expect(merged.transactionEndpointPatterns).toContain(endpoint);
      }
    }
    // The shared autocomplete tokens deduplicate instead of doubling.
    expect(merged.blockedFieldAutocomplete.filter((token) => token === 'cc-number')).toHaveLength(1);
    // The eBay destination survives; Kijiji contributes none.
    expect(merged.destinationPostalCode).toBe(ebaySiteProfile.destinationPostalCode);
    expect(merged.testOnly).toBeUndefined();
  });

  it('refuses to merge duplicate ids', () => {
    expect(() => mergeSiteProfiles([ebaySiteProfile, ebaySiteProfile])).toThrow(/duplicate/);
  });

  it('refuses to merge any profile carrying testOnly escapes', () => {
    const testProfile: SitePolicyProfile = {
      ...kijijiSiteProfile,
      id: 'kijiji.test.v1',
      testOnly: { allowInsecureHttp: true },
    };
    expect(() => mergeSiteProfiles([ebaySiteProfile, testProfile])).toThrow(/testOnly/);
  });

  it('refuses conflicting destinationPostalCode values', () => {
    const conflicting: SitePolicyProfile = {
      ...kijijiSiteProfile,
      id: 'other.site.v1',
      destinationPostalCode: 'H0H 0H0',
    };
    expect(() => mergeSiteProfiles([ebaySiteProfile, conflicting])).toThrow(/destinationPostalCode/);
  });
});

describe('AGENT_SITE_PROFILES config', () => {
  const baseEnv = { AGENT_GATEWAY_URL: 'ws://127.0.0.1:3000/agent/ws' };

  it('defaults to every compiled site profile', () => {
    expect(loadAgentConfig(baseEnv, 'linux').siteProfileIds).toEqual([
      'ebay.ca.v1',
      'kijiji.ca.v1',
      'zazzle.com.v1',
      'wardrobe-vendors.v1',
    ]);
  });

  it('parses, trims, and deduplicates an explicit list', () => {
    const config = loadAgentConfig(
      { ...baseEnv, AGENT_SITE_PROFILES: ' kijiji.ca.v1 , ebay.ca.v1 ,kijiji.ca.v1, ' },
      'linux',
    );
    expect(config.siteProfileIds).toEqual(['kijiji.ca.v1', 'ebay.ca.v1']);
  });

  it('rejects an effectively empty list', () => {
    expect(() => loadAgentConfig({ ...baseEnv, AGENT_SITE_PROFILES: ' , ' }, 'linux')).toThrow(
      /at least one site profile/,
    );
  });
});
