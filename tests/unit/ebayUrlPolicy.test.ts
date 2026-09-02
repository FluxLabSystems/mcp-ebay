/**
 * The §2 URL policy of docs/COUNTDOWN-API-PLAN.md, as the source-tool
 * schemas enforce it: a caller-supplied eBay URL is forwarded to the vendor
 * verbatim, so the screen is the only thing between a tool argument and a
 * third party's fetch of it.
 */
import { describe, expect, it } from 'vitest';
import { EBAY_URL_HOSTS, ebayDomainOfUrl, screenEbayUrl } from '@browser-bridge/protocol';

describe('screenEbayUrl (plan §2 URL policy)', () => {
  it('accepts https eBay URLs whose path matches the requested kind', () => {
    expect(
      screenEbayUrl('https://www.ebay.ca/sch/i.html?_nkw=lego&_sop=10&_ipg=240&LH_PrefLoc=2', ['search']),
    ).toBeNull();
    expect(screenEbayUrl('https://ebay.com/sch/brickseller/m.html?_ssn=brickseller', ['search'])).toBeNull();
    expect(screenEbayUrl('https://www.ebay.com/itm/LEGO-lot/226123456789?hash=abc', ['item'])).toBeNull();
    expect(screenEbayUrl('https://www.ebay.ca/usr/brickseller', ['seller'])).toBeNull();
    expect(screenEbayUrl('https://www.ebay.ca/str/jeremydoherty', ['seller'])).toBeNull();
    expect(screenEbayUrl('https://www.ebay.ca/itm/226123456789', ['search', 'item'])).toBeNull();
    // The parsed form is judged: host case and a default port normalize away.
    expect(screenEbayUrl('https://WWW.EBAY.CA:443/sch/i.html', ['search'])).toBeNull();
  });

  it('names the reason it refuses', () => {
    expect(screenEbayUrl('http://www.ebay.ca/sch/i.html', ['search'])).toMatch(/https/);
    expect(screenEbayUrl('javascript:alert(1)', ['search'])).toMatch(/https/);
    expect(screenEbayUrl('https://user:pw@www.ebay.ca/sch/i.html', ['search'])).toMatch(/userinfo/);
    expect(screenEbayUrl('https://user@www.ebay.ca/sch/i.html', ['search'])).toMatch(/userinfo/);
    expect(screenEbayUrl('https://www.ebay.ca:8443/sch/i.html', ['search'])).toMatch(/port/);
    expect(screenEbayUrl('https://www.example.com/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://www.ebay.ca.attacker.io/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://notebay.ca/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://www.ebay.co.uk/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://i.ebayimg.com/images/g/x/s-l1600.jpg', ['item'])).toMatch(/host/);
    expect(screenEbayUrl('https://www.ebay.ca./sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://10.0.0.5/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://localhost/sch/i.html', ['search'])).toMatch(/host/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/226123456789', ['search'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/sch/i.html', ['item'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/usr/x', ['item'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/', ['search', 'item', 'seller'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/ITM/226123456789', ['item'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/1', [])).toMatch(/kind/);
    expect(screenEbayUrl('not-a-url', ['search'])).toMatch(/absolute URL/);
    expect(screenEbayUrl('/sch/i.html?_nkw=lego', ['search'])).toMatch(/absolute URL/);
  });

  it('refuses the raw string before parsing whenever the parser would have to repair it', () => {
    // WHATWG reads "\" as "/", so this is an eBay item path here and host
    // evil.com to an RFC 3986 parser; the vendor must never be asked.
    expect(screenEbayUrl('https://www.ebay.ca\\itm\\123456789012@evil.com/', ['item'])).toMatch(/backslash/);
    expect(screenEbayUrl('https://www.ebay.ca\\sch\\i.html?_nkw=lego', ['search'])).toMatch(/backslash/);
    // Tab and newline the parser drops silently; every other whitespace or
    // control character is refused the same way.
    expect(screenEbayUrl('https://www.ebay.ca/itm/1234\t56789012', ['item'])).toMatch(/whitespace or a control character/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/1234\n56789012', ['item'])).toMatch(/whitespace or a control character/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/1234\u000056789012', ['item'])).toMatch(/control character/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/1234\u007f56789012', ['item'])).toMatch(/control character/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/1234\u00a056789012', ['item'])).toMatch(/whitespace/);
    expect(screenEbayUrl(' https://www.ebay.ca/itm/123456789012', ['item'])).toMatch(/leading or trailing whitespace/);
    expect(screenEbayUrl('https://www.ebay.ca/itm/123456789012\n', ['item'])).toMatch(/leading or trailing whitespace/);
    // The same smuggle spelled with a slash is plain userinfo and refused as such.
    expect(screenEbayUrl('https://www.ebay.ca@evil.com/itm/123456789012', ['item'])).toMatch(/userinfo/);
    expect(screenEbayUrl('https://www.ebay.ca:443@evil.com/itm/123456789012', ['item'])).toMatch(/userinfo/);
  });

  it('judges the normalized path, so dot segments cannot smuggle a kind', () => {
    expect(screenEbayUrl('https://www.ebay.ca/sch/../itm/226123456789', ['search'])).toMatch(/path/);
    expect(screenEbayUrl('https://www.ebay.ca/sch/../itm/226123456789', ['item'])).toBeNull();
  });

  it('an IDN lookalike host arrives as punycode and matches nothing', () => {
    // Cyrillic "е" in place of the Latin "e".
    expect(screenEbayUrl('https://www.еbay.ca/sch/i.html', ['search'])).not.toBeNull();
  });

  it('lists exactly the four hosts', () => {
    expect([...EBAY_URL_HOSTS].sort()).toEqual(['ebay.ca', 'ebay.com', 'www.ebay.ca', 'www.ebay.com']);
  });
});

describe('ebayDomainOfUrl', () => {
  it('maps the four hosts to their marketplace and everything else to null', () => {
    expect(ebayDomainOfUrl('https://www.ebay.ca/itm/1')).toBe('ebay.ca');
    expect(ebayDomainOfUrl('https://ebay.ca/usr/x')).toBe('ebay.ca');
    expect(ebayDomainOfUrl('https://www.ebay.com/sch/i.html')).toBe('ebay.com');
    expect(ebayDomainOfUrl('https://EBAY.COM/itm/1')).toBe('ebay.com');
    expect(ebayDomainOfUrl('https://www.ebay.co.uk/itm/1')).toBeNull();
    expect(ebayDomainOfUrl('https://i.ebayimg.com/x.jpg')).toBeNull();
    expect(ebayDomainOfUrl('https://www.ebay.ca.attacker.io/itm/1')).toBeNull();
    expect(ebayDomainOfUrl('not a url')).toBeNull();
  });

  it("is a host lookup only: screening is screenEbayUrl's job", () => {
    expect(ebayDomainOfUrl('http://www.ebay.ca/itm/1')).toBe('ebay.ca');
  });
});
