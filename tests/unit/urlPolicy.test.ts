import { describe, expect, it } from 'vitest';
import { checkUrl, hostMatchesAllowlist, isAuthPathBlocked, isProtectedEndpoint } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';
import { kijijiSiteProfile } from '@browser-bridge/site-kijiji';
import { zazzleSiteProfile } from '@browser-bridge/site-zazzle';

const publicResolve = async () => ['23.55.0.10'];

describe('host allowlist matching (§19.1 label-boundary safe)', () => {
  const hosts = ebaySiteProfile.allowedHosts;
  it('matches bare and wildcard entries', () => {
    expect(hostMatchesAllowlist('ebay.ca', hosts)).toBe(true);
    expect(hostMatchesAllowlist('www.ebay.ca', hosts)).toBe(true);
    expect(hostMatchesAllowlist('i.ebayimg.com', hosts)).toBe(true);
    expect(hostMatchesAllowlist('WWW.EBAY.CA', hosts)).toBe(true);
    expect(hostMatchesAllowlist('www.ebay.ca.', hosts)).toBe(true);
  });
  it('never matches lookalike suffixes', () => {
    expect(hostMatchesAllowlist('notebay.ca', hosts)).toBe(false);
    expect(hostMatchesAllowlist('evilebay.ca', hosts)).toBe(false);
    expect(hostMatchesAllowlist('ebay.ca.attacker.io', hosts)).toBe(false);
    expect(hostMatchesAllowlist('fakeebayimg.com', hosts)).toBe(false);
  });
});

describe('URL policy for tool targets (§19.1)', () => {
  it('allows allowlisted https hosts resolving publicly', async () => {
    const decision = await checkUrl('https://www.ebay.ca/itm/123', ebaySiteProfile, 'navigation', {
      resolve: publicResolve,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.resolvedAddresses).toEqual(['23.55.0.10']);
  });

  it('denies off-allowlist origins with ORIGIN_DENIED', async () => {
    const decision = await checkUrl('https://example.com/', ebaySiteProfile, 'navigation', {
      resolve: publicResolve,
    });
    expect(decision).toMatchObject({ allowed: false, errorCode: 'ORIGIN_DENIED' });
  });

  it('denies allowlisted hostnames that resolve to prohibited addresses (rebinding)', async () => {
    const decision = await checkUrl('https://www.ebay.ca/', ebaySiteProfile, 'redirect', {
      resolve: async () => ['104.16.0.1', '10.0.0.5'],
    });
    expect(decision).toMatchObject({ allowed: false, errorCode: 'PRIVATE_NETWORK_DENIED' });
  });

  it('denies unresolvable hostnames', async () => {
    const decision = await checkUrl('https://www.ebay.ca/', ebaySiteProfile, 'navigation', {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(decision).toMatchObject({ allowed: false, errorCode: 'PRIVATE_NETWORK_DENIED' });
  });

  it('subresource context skips DNS but keeps scheme+allowlist', async () => {
    const ok = await checkUrl('https://i.ebayimg.com/images/g/x/s-l1600.jpg', ebaySiteProfile, 'subresource');
    expect(ok.allowed).toBe(true);
    const denied = await checkUrl('https://tracker.example.net/pixel.gif', ebaySiteProfile, 'subresource');
    expect(denied).toMatchObject({ allowed: false, errorCode: 'ORIGIN_DENIED' });
  });
});

// 2026-09-01: the zazzle.com country selector navigates to the same path on
// zazzle.ca, and a .com-only allowlist made that navigation die on Chrome's
// "blocked by client policies" page. Both storefront TLDs are one research
// surface, and every wall the .com host has must hold on .ca too.
describe('zazzle.ca joins the zazzle research surface (2026-09-01)', () => {
  const publicResolve = async () => ['104.16.0.10'];

  it('allows the .ca storefront the country selector navigates to', async () => {
    const decision = await checkUrl(
      'https://www.zazzle.ca/s/custom+name+t+shirt',
      zazzleSiteProfile,
      'navigation',
      { resolve: publicResolve },
    );
    expect(decision.allowed).toBe(true);
  });

  it('matches .ca hosts without admitting lookalike suffixes', () => {
    const hosts = zazzleSiteProfile.allowedHosts;
    expect(hostMatchesAllowlist('zazzle.ca', hosts)).toBe(true);
    expect(hostMatchesAllowlist('www.zazzle.ca', hosts)).toBe(true);
    expect(hostMatchesAllowlist('notzazzle.ca', hosts)).toBe(false);
    expect(hostMatchesAllowlist('zazzle.ca.attacker.io', hosts)).toBe(false);
  });

  // 2026-09-05 wardrobe fire: the .ca storefront's assets live on zcache.ca,
  // which the .com-only CDN entry refused (asset.zcache.ca 59 requests,
  // rlv.zcache.ca 10) — extraction fine, screenshots and image URLs not.
  it('reaches the .ca asset CDN the .ca storefront serves from, as subresources', async () => {
    for (const url of [
      'https://asset.zcache.ca/bld/z.3/desktop/common.e9ceb1d2b531f8.css',
      'https://rlv.zcache.ca/custom_company_logo_bar_code_employee_photo_blue_badge-r_v4niql_644.webp',
    ]) {
      const decision = await checkUrl(url, zazzleSiteProfile, 'subresource', { resolve: publicResolve });
      expect(decision.allowed, url).toBe(true);
    }
    const hosts = zazzleSiteProfile.allowedHosts;
    expect(hostMatchesAllowlist('zcache.ca.attacker.io', hosts)).toBe(false);
    expect(hostMatchesAllowlist('notzcache.ca', hosts)).toBe(false);
    expect(hostMatchesAllowlist('www.googletagmanager.com', hosts)).toBe(false);
  });

  it('keeps the transaction wall on the .ca host, segment-anchored', () => {
    expect(isProtectedEndpoint('https://www.zazzle.ca/co/cart', zazzleSiteProfile)).toBe(true);
    expect(isProtectedEndpoint('https://www.zazzle.ca/checkout/', zazzleSiteProfile)).toBe(true);
    // A product slug merely containing the word stays reachable.
    expect(
      isProtectedEndpoint(
        'https://www.zazzle.ca/custom_checkout_counter_sign-256993602821254375',
        zazzleSiteProfile,
      ),
    ).toBe(false);
  });

  it('keeps the auth wall on the .ca host', () => {
    expect(isAuthPathBlocked('https://www.zazzle.ca/signin/', zazzleSiteProfile)).toBe(true);
    expect(isAuthPathBlocked('https://www.zazzle.ca/s/custom+t+shirt', zazzleSiteProfile)).toBe(false);
  });

  it('still denies entripy.com whatever the allowlist grows to', async () => {
    const decision = await checkUrl('https://www.entripy.com/', zazzleSiteProfile, 'navigation', {
      resolve: publicResolve,
    });
    expect(decision.allowed).toBe(false);
  });
});

// 2026-09-05, operator authorization in-session (fingerprint mcp-ebay+
// site_profile_request+operator-override-allowlist-first-party-subresource-
// origins): four first-party subresource origins the marketplace pages pull
// from were ORIGIN_DENIED on essentially every load — Kijiji's three
// production app-shell buckets (the seller-profile page rendered no listing
// region at all with them blocked) and eBay's item-description iframe host.
// Exactly those origins are allowed; ad, analytics and fingerprinting
// origins the same fires saw denied stay denied.
describe('first-party subresource origins allowed on the operator\'s authorization (2026-09-05)', () => {
  it('kijiji.ca.v1 reaches the three ca-kijiji-production buckets and nothing else on that bucket domain', async () => {
    for (const url of [
      'https://webapp-static.ca-kijiji-production.classifiedscloud.io/v1-25-9/dist/chunk.js',
      'https://fes.ca-kijiji-production.classifiedscloud.io/v1-25-9/dist/Larsseit.92161b1b.woff2',
      'https://box-static.ca-kijiji-production.classifiedscloud.io/current/css/master.theme.css',
    ]) {
      const decision = await checkUrl(url, kijijiSiteProfile, 'subresource', { resolve: publicResolve });
      expect(decision.allowed, url).toBe(true);
    }
    for (const host of [
      'ca-kijiji-production.classifiedscloud.io',
      'other.ca-kijiji-production.classifiedscloud.io',
      'classifiedscloud.io',
      'fes.ca-kijiji-production.classifiedscloud.io.attacker.example',
      'js.sentry-cdn.com',
      'securepubads.g.doubleclick.net',
    ]) {
      expect(hostMatchesAllowlist(host, kijijiSiteProfile.allowedHosts), host).toBe(false);
    }
  });

  it('ebay.ca.v1 reaches the item-description iframe host, and the lookalike suffix stays out', async () => {
    const allowed = await checkUrl(
      'https://itm.ebaydesc.com/itmdesc/198591780847?t=0&category=51268&seller=sunthan',
      ebaySiteProfile,
      'subresource',
      { resolve: publicResolve },
    );
    expect(allowed.allowed).toBe(true);
    for (const host of ['ebaydesc.com.attacker.example', 'notebaydesc.com', 'cas.avalon.perfdrive.com', 'c.amazon-adsystem.com']) {
      expect(hostMatchesAllowlist(host, ebaySiteProfile.allowedHosts), host).toBe(false);
    }
    // No wall moved: a description frame never becomes a transaction path.
    expect(isProtectedEndpoint('https://itm.ebaydesc.com/itmdesc/198591780847', ebaySiteProfile)).toBe(false);
    expect(isProtectedEndpoint('https://www.ebay.ca/placebid?item=198591780847', ebaySiteProfile)).toBe(true);
  });
});
