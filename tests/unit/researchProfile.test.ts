/**
 * createResearchProfile — the read-only walls every policy-only lane needs,
 * built from a host roster instead of hand-copied per lane.
 *
 * The interesting assertions are the two failure modes hand-copying produces:
 * a wall that is missing from one lane, and a wall so broad it swallows an
 * ordinary listing URL. The second one is not hypothetical — the kijiji
 * profile's free-substring rules aborted real ads whose seller-written slugs
 * contained "cash-register", "lamp-post" and "fire-alerts", which is why every
 * pattern here is segment-anchored.
 */
import { describe, expect, it } from 'vitest';
import {
  createResearchProfile,
  hostMatchesAllowlist,
  isAuthPathBlocked,
  isProtectedEndpoint,
  mergeSiteProfiles,
} from '@browser-bridge/policy';
import { wardrobeVendorsSiteProfile } from '@browser-bridge/site-vendors';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';

const profile = createResearchProfile({
  id: 'test-lane.v1',
  hosts: ['spacelist.ca', 'regus.com', 'jobbank.gc.ca'],
  deniedHosts: ['ruledout.example', '*.ruledout.example'],
});

describe('createResearchProfile', () => {
  it('allows each apex and every label depth under it, and nothing that merely looks like one', () => {
    for (const host of ['spacelist.ca', 'www.spacelist.ca', 'cdn.assets.regus.com', 'jobbank.gc.ca']) {
      expect(hostMatchesAllowlist(host, profile.allowedHosts), host).toBe(true);
    }
    // The classic suffix confusions: a longer registrable name, and the
    // allowed name appearing as a label under somebody else's domain.
    for (const host of ['spacelist.ca.attacker.io', 'regus.company', 'notjobbank.gc.ca']) {
      expect(hostMatchesAllowlist(host, profile.allowedHosts), host).toBe(false);
    }
  });

  it('blocks the money, credential and state-mutation paths on every roster host', () => {
    for (const url of [
      'https://www.spacelist.ca/checkout',
      'https://www.regus.com/en-ca/booking/confirm',
      'https://www.spacelist.ca/listing/123/contact-agent',
      'https://www.regus.com/account/billing',
      'https://www.jobbank.gc.ca/jobsearch/apply/50201330',
      'https://www.spacelist.ca/saved-search/new',
    ]) {
      expect(isProtectedEndpoint(url, profile), url).toBe(true);
    }
  });

  it('blocks auth surfaces through named path segments, so a redirect landing is caught too', () => {
    for (const url of [
      'https://www.regus.com/en-ca/login',
      'https://www.spacelist.ca/users/sign-in',
      'https://www.jobbank.gc.ca/auth',
    ]) {
      expect(isAuthPathBlocked(url, profile), url).toBe(true);
    }
  });

  // The bug the anchoring exists for: a listing slug is seller-written text.
  it('does not treat an endpoint word inside a listing slug as an endpoint', () => {
    for (const url of [
      'https://www.spacelist.ca/listings/toronto/order-of-magnitude-studios-suite-200',
      'https://www.spacelist.ca/listings/1200-bay-st-cart-alley-unit-4',
      'https://www.jobbank.gc.ca/jobsearch/jobposting/50201330?applyonline=false',
      'https://www.regus.com/en-ca/canada/toronto/first-canadian-place-buying-guide',
    ]) {
      expect(isProtectedEndpoint(url, profile), url).toBe(false);
      expect(isAuthPathBlocked(url, profile), url).toBe(false);
    }
  });

  it('lets deny-listed hosts win over the allowlist', () => {
    expect(profile.deniedHosts).toEqual(expect.arrayContaining(['ruledout.example']));
  });

  // A hand-copied lane is one omission away from being the weak link in a
  // composite. This pins the floor: whatever wardrobe-vendors.v1 refuses by
  // accessible name and by secret-field token, a generated lane refuses too.
  it('is no weaker than the hand-written wardrobe lane it generalises', () => {
    expect(profile.blockedActionPatterns).toEqual(
      expect.arrayContaining([...wardrobeVendorsSiteProfile.blockedActionPatterns]),
    );
    expect(profile.blockedFieldAutocomplete).toEqual(
      expect.arrayContaining([...wardrobeVendorsSiteProfile.blockedFieldAutocomplete]),
    );
  });

  it('composes with the marketplace profiles without loosening either side', () => {
    const composite = mergeSiteProfiles([ebaySiteProfile, profile]);
    expect(hostMatchesAllowlist('www.spacelist.ca', composite.allowedHosts)).toBe(true);
    expect(hostMatchesAllowlist('www.ebay.ca', composite.allowedHosts)).toBe(true);
    // eBay's own walls still apply inside the composite, and so do the lane's.
    expect(isProtectedEndpoint('https://www.ebay.ca/placebid?item=1', composite)).toBe(true);
    expect(isProtectedEndpoint('https://www.regus.com/account/billing', composite)).toBe(true);
  });

  it('refuses to build a profile with no hosts rather than one that allows nothing', () => {
    expect(() => createResearchProfile({ id: 'empty.v1', hosts: [] })).toThrow(/at least one host/);
  });
});
