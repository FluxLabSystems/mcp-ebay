import { describe, expect, it } from 'vitest';
import { checkUrl, hostMatchesAllowlist } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';

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
