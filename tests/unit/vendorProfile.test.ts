/**
 * wardrobe-vendors.v1 — the policy-only profile that lets the wardrobe
 * routine reach its non-Zazzle vendors through the Bridge. Filed by the
 * 2026-09-02 wardrobe fire (gateway+coverage_gap+browser-bridge-non-zazzle-
 * wardrobe-hosts-not-allowlisted: ORIGIN_DENIED on vistaprint.ca) and
 * ratified by the operator the same day. The roster is data; every vendor
 * gets the same strict read-only walls, and the profile ships no extractor.
 */
import { describe, expect, it } from 'vitest';
import {
  checkUrl,
  hostMatchesAllowlist,
  isAuthPathBlocked,
  isProtectedEndpoint,
  mergeSiteProfiles,
} from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { kijijiSiteProfile } from '@browser-bridge/site-kijiji';
import { zazzleSiteProfile } from '@browser-bridge/site-zazzle';
import {
  isWardrobeVendorHost,
  WARDROBE_VENDORS,
  WARDROBE_VENDORS_SITE_PROFILE_ID,
  wardrobeVendorsSiteProfile,
} from '@browser-bridge/site-vendors';

const publicResolve = async () => ['23.55.0.10'];

describe('wardrobe-vendors.v1 roster', () => {
  it('is a production profile: versioned id, no test escapes, entripy denied', () => {
    expect(wardrobeVendorsSiteProfile.id).toBe('wardrobe-vendors.v1');
    expect(WARDROBE_VENDORS_SITE_PROFILE_ID).toBe(wardrobeVendorsSiteProfile.id);
    expect(wardrobeVendorsSiteProfile.testOnly).toBeUndefined();
    expect(wardrobeVendorsSiteProfile.deniedHosts).toEqual(expect.arrayContaining(['entripy.com', '*.entripy.com']));
  });

  it('covers every vendor the 2026-09-02 report named, apex and subdomains', () => {
    const hosts = wardrobeVendorsSiteProfile.allowedHosts;
    for (const host of [
      'www.vistaprint.ca',
      'vistaprint.ca',
      'www.vistaprint.com',
      'www.rushordertees.com',
      'www.spreadshirt.ca',
      'www.spreadshirt.com',
      'www.printful.com',
      'www.gs-jj.com',
      'www.etsy.com',
      'i.etsystatic.com',
    ]) {
      expect(hostMatchesAllowlist(host, hosts), host).toBe(true);
    }
  });

  it('every roster entry names a public registrable domain and a source', () => {
    for (const vendor of WARDROBE_VENDORS) {
      expect(vendor.vendor.length).toBeGreaterThan(0);
      expect(vendor.hosts.length).toBeGreaterThan(0);
      for (const host of vendor.hosts) {
        // Bare registrable domains only: no scheme, path, port, IP, or
        // wildcard here — the profile derives the wildcard itself.
        expect(host).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
        expect(host).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      }
      expect(vendor.addedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(vendor.source.length).toBeGreaterThan(0);
    }
  });

  it('never matches lookalikes, and a denied host loses even when allowlisted-shaped', async () => {
    const hosts = wardrobeVendorsSiteProfile.allowedHosts;
    expect(hostMatchesAllowlist('notvistaprint.ca', hosts)).toBe(false);
    expect(hostMatchesAllowlist('vistaprint.ca.attacker.io', hosts)).toBe(false);
    expect(hostMatchesAllowlist('printful.company', hosts)).toBe(false);
    const denied = await checkUrl('https://www.entripy.com/custom-tees', wardrobeVendorsSiteProfile, 'navigation', {
      resolve: publicResolve,
    });
    expect(denied.allowed).toBe(false);
  });

  it('allows vendor product pages and blocks their carts, checkouts and sign-ins', async () => {
    const ok = await checkUrl(
      'https://www.vistaprint.ca/clothing-bags/polos/embroidered-polo-shirts',
      wardrobeVendorsSiteProfile,
      'navigation',
      { resolve: publicResolve },
    );
    expect(ok.allowed).toBe(true);
    for (const url of [
      'https://www.vistaprint.ca/cart',
      'https://www.rushordertees.com/checkout/',
      'https://www.printful.com/dashboard/billing',
      'https://www.etsy.com/cart?ref=hdr',
      'https://www.spreadshirt.ca/checkout',
      'https://www.gs-jj.com/payment',
    ]) {
      expect(isProtectedEndpoint(url, wardrobeVendorsSiteProfile), url).toBe(true);
    }
    for (const url of [
      'https://www.etsy.com/signin',
      'https://www.printful.com/auth/login',
      'https://www.vistaprint.ca/account/sign-in',
      'https://www.spreadshirt.ca/register',
    ]) {
      expect(isAuthPathBlocked(url, wardrobeVendorsSiteProfile), url).toBe(true);
      const decision = await checkUrl(url, wardrobeVendorsSiteProfile, 'navigation', { resolve: publicResolve });
      expect(decision.allowed, url).toBe(false);
    }
    // A product slug carrying an endpoint word is NOT an endpoint (segment-anchored).
    expect(
      isProtectedEndpoint('https://www.etsy.com/listing/123/checkout-counter-sign-custom', wardrobeVendorsSiteProfile),
    ).toBe(false);
    expect(wardrobeVendorsSiteProfile.blockedActionPatterns).toEqual(
      expect.arrayContaining(['add to cart', 'checkout', 'buy now', 'sign in', 'place order']),
    );
    expect(wardrobeVendorsSiteProfile.blockedFieldAutocomplete).toEqual(
      expect.arrayContaining(['current-password', 'cc-number', 'one-time-code']),
    );
  });

  it('composes with the three marketplace profiles without loosening any of them', () => {
    const composite = mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile, zazzleSiteProfile, wardrobeVendorsSiteProfile]);
    expect(composite.id).toBe('ebay.ca.v1+kijiji.ca.v1+zazzle.com.v1+wardrobe-vendors.v1');
    expect(hostMatchesAllowlist('www.vistaprint.ca', composite.allowedHosts)).toBe(true);
    expect(hostMatchesAllowlist('www.ebay.ca', composite.allowedHosts)).toBe(true);
    expect(composite.deniedHosts).toEqual(expect.arrayContaining(['entripy.com']));
    // eBay's own walls still apply inside the composite.
    expect(isProtectedEndpoint('https://www.ebay.ca/placebid?item=1', composite)).toBe(true);
  });

  it('answers whether a host is a wardrobe vendor', () => {
    expect(isWardrobeVendorHost('www.vistaprint.ca')).toBe(true);
    expect(isWardrobeVendorHost('https://www.printful.com/custom/polo')).toBe(true);
    expect(isWardrobeVendorHost('www.zazzle.ca')).toBe(false);
    expect(isWardrobeVendorHost('www.ebay.ca')).toBe(false);
    expect(isWardrobeVendorHost('not a host')).toBe(false);
  });
});
