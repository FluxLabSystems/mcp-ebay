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
  OPERATOR_HOST_EXCEPTIONS,
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
      // 2026-09-07: Spreadshirt's designer script host and font CDN
      // (create-omat.spreadshirt.net /lib/design.js — the create-your-own
      // designer's own application bundle, ORIGIN_DENIED on every fire;
      // assets.spreadshirt.net web fonts) and its product image server.
      'create-omat.spreadshirt.net',
      'assets.spreadshirt.net',
      'image.spreadshirtmedia.com',
      'www.printful.com',
      'www.gs-jj.com',
      // 2026-09-05: GS-JJ's own image CDN and products API domain.
      'static-oss.gs-souvenir.com',
      'products-api-o2o-prod.gs-souvenir.com',
      'www.etsy.com',
      'i.etsystatic.com',
    ]) {
      expect(hostMatchesAllowlist(host, hosts), host).toBe(true);
    }
    // A shared cloud-storage endpoint is not a vendor domain, roster or not.
    expect(hostMatchesAllowlist('gs-jj-us-static.oss-accelerate.aliyuncs.com', hosts)).toBe(false);
    // Nor is a shared third-party DAM the storefront pulls one image from
    // (cdn.media.amplience.net, 2026-09-07): the operator's call, not the roster's.
    expect(hostMatchesAllowlist('cdn.media.amplience.net', hosts)).toBe(false);
    expect(hostMatchesAllowlist('spreadshirt.net.attacker.io', hosts)).toBe(false);
    expect(hostMatchesAllowlist('gs-souvenir.com.attacker.io', hosts)).toBe(false);
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

  it('RushOrderTees: the asset-CDN question is answered on the roster entry, and the roster itself did not widen', () => {
    // 2026-09-10 wardrobe fire (gateway+coverage_gap+rushordertees-asset-cdn-
    // and-search-backend-are-third-party-hosts): the first live read found the
    // photography on cdn.sanity.io and the search on Algolia. Neither is a
    // RushOrderTees domain, so the roster ENTRY records the answer instead of
    // re-asking and its hosts stay the vendor's own; the two third-party
    // hosts reach the allowlist only as operator exceptions (below).
    const entry = WARDROBE_VENDORS.find((vendor) => vendor.vendor === 'RushOrderTees');
    expect(entry?.hosts).toEqual(['rushordertees.com']);
    expect(entry?.needsLiveVerification).toBeUndefined();
    expect(entry?.verifiedLive).toMatch(/cdn\.sanity\.io/);
    expect(entry?.verifiedLive).toMatch(/algolia/i);
    expect(entry?.verifiedLive).toMatch(/2026-09-10/);
    expect(entry?.verifiedLive).toMatch(/2026-09-14/);
    expect(hostMatchesAllowlist('www.rushordertees.com', wardrobeVendorsSiteProfile.allowedHosts)).toBe(true);
  });

  it('operator exceptions (2026-09-14): exact third-party hosts the operator ratified on the CI board, nothing beside or beneath them', () => {
    // ci-approval-rushordertees-third-party-asset-and-search-hosts and
    // ci-approval-spreadshirt-api-img-ly-design-sdk-host, both approved
    // 2026-09-14 through the authenticated feedback path. An exception is an
    // exact hostname — the profile derives no wildcard for it — with the
    // approval id as its source, so every widening of the allowlist beyond
    // the vendor roster is auditable back to an operator decision.
    const hosts = wardrobeVendorsSiteProfile.allowedHosts;
    const expected = [
      'cdn.sanity.io',
      'hwj52h4d98-dsn.algolia.net',
      'hwj52h4d98-1.algolianet.com',
      'hwj52h4d98-2.algolianet.com',
      'hwj52h4d98-3.algolianet.com',
      'api.img.ly',
    ];
    expect(OPERATOR_HOST_EXCEPTIONS.map((e) => e.host)).toEqual(expected);
    for (const exception of OPERATOR_HOST_EXCEPTIONS) {
      expect(exception.host).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
      expect(exception.approvedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(exception.source).toMatch(/^ci-approval-[a-z0-9-]+ \(approved 2026-09-14T/);
      expect(['RushOrderTees', 'Spreadshirt']).toContain(exception.vendor);
      expect(hostMatchesAllowlist(exception.host, hosts), exception.host).toBe(true);
      // Exact only: no wildcard beneath, and never the registrable parent.
      expect(hostMatchesAllowlist(`www.${exception.host}`, hosts), `www.${exception.host}`).toBe(false);
      expect(hostMatchesAllowlist(exception.host.split('.').slice(-2).join('.'), hosts)).toBe(false);
    }
    // Siblings the ruling did not name stay out: another Algolia app id, and
    // the two hosts the Spreadshirt approval listed as still pending.
    expect(hostMatchesAllowlist('abcdefghij-dsn.algolia.net', hosts)).toBe(false);
    expect(hostMatchesAllowlist('hwj52h4d98-4.algolianet.com', hosts)).toBe(false);
    expect(hostMatchesAllowlist('cdn.media.amplience.net', hosts)).toBe(false);
    expect(hostMatchesAllowlist('adtm.spreadshirts.net', hosts)).toBe(false);
    expect(hostMatchesAllowlist('gs-jj-us-static.oss-accelerate.aliyuncs.com', hosts)).toBe(false);
    // An exception host is not a vendor page: extract dispatch still treats it as foreign.
    expect(isWardrobeVendorHost('cdn.sanity.io')).toBe(false);
    // The exceptions survive the composite the agent actually runs.
    const composite = mergeSiteProfiles([ebaySiteProfile, kijijiSiteProfile, zazzleSiteProfile, wardrobeVendorsSiteProfile]);
    expect(hostMatchesAllowlist('api.img.ly', composite.allowedHosts)).toBe(true);
    expect(hostMatchesAllowlist('img.ly', composite.allowedHosts)).toBe(false);
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
