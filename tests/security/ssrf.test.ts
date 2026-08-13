/**
 * Security invariants (§27.2): no navigation to localhost, RFC1918,
 * link-local, file:, data:, or javascript: targets; redirect/rebinding
 * revalidation; the production eBay profile carries no test escapes.
 */
import { describe, expect, it } from 'vitest';
import { checkUrl } from '@browser-bridge/policy';
import { ebaySiteProfile } from '@browser-bridge/site-ebay';

const publicResolve = async () => ['23.55.0.10'];

describe('production profile hygiene', () => {
  it('ebay.ca.v1 carries the normative allowlist and no test escapes', () => {
    expect(ebaySiteProfile.id).toBe('ebay.ca.v1');
    expect(ebaySiteProfile.testOnly).toBeUndefined();
    expect([...ebaySiteProfile.allowedHosts].sort()).toEqual(
      ['*.ebay.ca', '*.ebay.com', '*.ebayimg.com', '*.ebaystatic.com', 'ebay.ca', 'ebay.com', 'ebayimg.com', 'ebaystatic.com'].sort(),
    );
    expect(ebaySiteProfile.destinationPostalCode).toBe('M6H 2W9');
  });
});

describe('scheme denial (§19.1)', () => {
  const deniedSchemes = [
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'javascript:alert(1)',
    'blob:https://www.ebay.ca/uuid',
    'chrome://settings',
    'chrome-extension://abcdef/page.html',
    'about:config',
    'view-source:https://www.ebay.ca/',
    'ftp://ebay.ca/file',
    'http://www.ebay.ca/itm/1',
  ];
  it.each(deniedSchemes)('denies %s', async (url) => {
    const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
    expect(decision.allowed).toBe(false);
    expect(decision.errorCode).toBe('SCHEME_DENIED');
  });
});

describe('private/local network denial (§19.1, §27.2)', () => {
  const literalTargets = [
    'https://127.0.0.1/admin',
    'https://localhost/admin',
    'https://[::1]/admin',
    'https://10.0.0.5/',
    'https://192.168.1.10/router',
    'https://172.16.0.1/',
    'https://169.254.169.254/latest/meta-data',
    'https://0.0.0.0/',
    'https://[fe80::1]/',
    'https://[fc00::1]/',
    'https://[::ffff:127.0.0.1]/',
  ];
  it.each(literalTargets)('denies %s', async (url) => {
    const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
    expect(decision.allowed).toBe(false);
    // Off-allowlist hosts fail closed on ORIGIN_DENIED before address checks;
    // both codes satisfy the invariant that navigation never proceeds.
    expect(['ORIGIN_DENIED', 'PRIVATE_NETWORK_DENIED']).toContain(decision.errorCode);
  });

  it('denies allowlisted hosts that RESOLVE to prohibited ranges (DNS rebinding)', async () => {
    for (const addresses of [['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['104.18.0.1', '192.168.0.9']]) {
      const decision = await checkUrl('https://www.ebay.ca/itm/1', ebaySiteProfile, 'redirect', {
        resolve: async () => addresses,
      });
      expect(decision.allowed, addresses.join(',')).toBe(false);
      expect(decision.errorCode).toBe('PRIVATE_NETWORK_DENIED');
    }
  });

  it('revalidates every hop context, not just first navigation', async () => {
    for (const context of ['navigation', 'redirect', 'popup', 'frame', 'image_download'] as const) {
      const decision = await checkUrl('https://internal.attacker.example/', ebaySiteProfile, context, {
        resolve: publicResolve,
      });
      expect(decision.allowed, context).toBe(false);
    }
  });

  it('decimal/hex IP obfuscation cannot bypass the allowlist', async () => {
    for (const url of ['https://2130706433/', 'https://0x7f000001/', 'https://017700000001/']) {
      const decision = await checkUrl(url, ebaySiteProfile, 'navigation', { resolve: publicResolve });
      expect(decision.allowed, url).toBe(false);
    }
  });
});
