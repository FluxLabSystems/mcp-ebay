import { describe, expect, it } from 'vitest';
import { loadGatewayConfig, parseCreditReserve } from '@browser-bridge/config';
import { SOURCE_REQUEST_TIMEOUT_MAX_MS } from '@browser-bridge/protocol';

// The same minimal gateway env dashboardClient.test.ts uses; every other
// variable takes its default.
const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
  DATABASE_URL: 'postgres://unused',
};

const KEYED_ENV = { ...BASE_ENV, COUNTDOWN_API_KEY: 'cd-test-key' };

describe('gateway Countdown API configuration', () => {
  it('runs the source as a secondary pathway by default, and only primary or off when told', () => {
    expect(loadGatewayConfig(KEYED_ENV).countdown?.role).toBe('secondary');
    expect(loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_ROLE: '' }).countdown?.role).toBe('secondary');
    expect(loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_ROLE: ' Secondary ' }).countdown?.role).toBe('secondary');
    expect(loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_ROLE: 'primary' }).countdown?.role).toBe('primary');
    // 'off' unregisters the tools while the key stays in place for a later flip.
    expect(loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_ROLE: 'off' }).countdown).toBeNull();
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_ROLE: 'fallback' })).toThrow(/COUNTDOWN_ROLE must be primary, secondary or off/);
  });

  it('is null when COUNTDOWN_API_KEY is unset', () => {
    expect(loadGatewayConfig(BASE_ENV).countdown).toBeNull();
  });

  it('reads an empty or blank key as unset', () => {
    // FluxLab's deploy script copies `COUNTDOWN_API_KEY=` verbatim from
    // .env.example into an existing .env, so the blank line has to mean
    // "unconfigured", never "configured with an empty key".
    expect(loadGatewayConfig({ ...BASE_ENV, COUNTDOWN_API_KEY: '' }).countdown).toBeNull();
    expect(loadGatewayConfig({ ...BASE_ENV, COUNTDOWN_API_KEY: '   ' }).countdown).toBeNull();
  });

  it('applies the defaults and derives the two destinations once the key is set', () => {
    const config = loadGatewayConfig(KEYED_ENV);
    expect(config.countdown).toEqual({
      apiKey: 'cd-test-key',
      role: 'secondary',
      baseUrl: 'https://api.countdownapi.com',
      // Percent of the plan's credit limit by default: an absolute figure
      // outgrew the trial on the first fire (500 against a one-time 100).
      creditReserve: { kind: 'percent', percent: 5, configured: '5%' },
      maxConcurrency: 4,
      // Under the 50 s tool deadline with 2 s to spare; the MCP client allows 60 s.
      timeoutMs: 45_000,
      destinations: {
        toronto: { customerLocation: 'ca', customerZipcode: 'M6H2W9' },
        forwarder: { customerLocation: 'us', customerZipcode: '34249' },
      },
    });
    // The Bridge-facing value keeps eBay's own spelling; only the copy
    // bound for the vendor is compacted.
    expect(config.ebayDestinationPostalCode).toBe('M6H 2W9');
  });

  it('normalises the Toronto postal code to uppercase with all whitespace removed', () => {
    // The vendor forwards customer_zipcode to eBay's _stpos unnormalised.
    const config = loadGatewayConfig({ ...KEYED_ENV, EBAY_DESTINATION_POSTAL_CODE: ' m6h\t2w9 ' });
    expect(config.countdown?.destinations.toronto).toEqual({ customerLocation: 'ca', customerZipcode: 'M6H2W9' });
    expect(config.ebayDestinationPostalCode).toBe(' m6h\t2w9 ');
  });

  it('trims the key and strips trailing slashes from the base URL', () => {
    const config = loadGatewayConfig({
      ...BASE_ENV,
      COUNTDOWN_API_KEY: '  cd-test-key  ',
      COUNTDOWN_API_BASE_URL: 'https://countdown-stub:9999///',
    });
    expect(config.countdown?.apiKey).toBe('cd-test-key');
    expect(config.countdown?.baseUrl).toBe('https://countdown-stub:9999');
  });

  it('refuses a plain-http base URL, because the key rides in every request query string', () => {
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_API_BASE_URL: 'http://countdown-stub:9999' })).toThrow(
      /COUNTDOWN_API_BASE_URL/,
    );
    // Validated at boot whether or not the source is on.
    expect(() => loadGatewayConfig({ ...BASE_ENV, COUNTDOWN_API_BASE_URL: 'http://api.countdownapi.com' })).toThrow(
      /COUNTDOWN_API_BASE_URL/,
    );
  });

  it('reads the tuning knobs at their bounds', () => {
    const config = loadGatewayConfig({
      ...KEYED_ENV,
      COUNTDOWN_CREDIT_RESERVE: '0',
      COUNTDOWN_MAX_CONCURRENCY: '8',
      COUNTDOWN_TIMEOUT_MS: '5000',
      EBAY_FORWARDER_ZIPCODE: '90210',
    });
    expect(config.countdown).toMatchObject({
      creditReserve: { kind: 'absolute', credits: 0, configured: '0' },
      maxConcurrency: 8,
      timeoutMs: 5_000,
    });
    expect(loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: String(SOURCE_REQUEST_TIMEOUT_MAX_MS) }).countdown?.timeoutMs).toBe(
      SOURCE_REQUEST_TIMEOUT_MAX_MS,
    );
    expect(config.countdown?.destinations.forwarder).toEqual({ customerLocation: 'us', customerZipcode: '90210' });
  });

  it('rejects a forwarder zip that is not exactly five digits', () => {
    for (const bad of ['3424', '342490', 'ABCDE', '34249-1234', '34 249', '']) {
      expect(() => loadGatewayConfig({ ...KEYED_ENV, EBAY_FORWARDER_ZIPCODE: bad })).toThrow(/EBAY_FORWARDER_ZIPCODE/);
    }
    // Checked with the source off too: a bad value fails at boot, not on
    // the day the key is added.
    expect(() => loadGatewayConfig({ ...BASE_ENV, EBAY_FORWARDER_ZIPCODE: 'nope' })).toThrow(/EBAY_FORWARDER_ZIPCODE/);
  });

  it('rejects out-of-range concurrency, timeout and reserve values', () => {
    for (const bad of ['0', '9', '2.5', 'four']) {
      expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_MAX_CONCURRENCY: bad })).toThrow(
        /COUNTDOWN_MAX_CONCURRENCY/,
      );
    }
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: '4999' })).toThrow(/COUNTDOWN_TIMEOUT_MS/);
    // The old 90 s default and anything else the 50 s tool deadline cannot
    // contain is refused, naming the deadline it has to fit under.
    expect(SOURCE_REQUEST_TIMEOUT_MAX_MS).toBe(48_000);
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: '60000' })).toThrow(
      /COUNTDOWN_TIMEOUT_MS must be at most 48000 ms: the 50000 ms tool deadline/,
    );
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: '48001' })).toThrow(/COUNTDOWN_TIMEOUT_MS/);
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: '90000' })).toThrow(/COUNTDOWN_TIMEOUT_MS/);
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_CREDIT_RESERVE: '-1' })).toThrow(
      /COUNTDOWN_CREDIT_RESERVE/,
    );
  });

  it('accepts the credit reserve as an absolute count or a percentage of the plan limit, defaulting to 5%', () => {
    const reserveFor = (value: string | undefined) =>
      loadGatewayConfig({ ...KEYED_ENV, ...(value === undefined ? {} : { COUNTDOWN_CREDIT_RESERVE: value }) }).countdown?.creditReserve;
    expect(reserveFor(undefined)).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    // Blank is the default: FluxLab's deploy script may copy an empty line verbatim.
    expect(reserveFor('')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(reserveFor('   ')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(reserveFor('5%')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(reserveFor(' 5% ')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(reserveFor('500')).toEqual({ kind: 'absolute', credits: 500, configured: '500' });
    expect(reserveFor('0')).toEqual({ kind: 'absolute', credits: 0, configured: '0' });
    expect(reserveFor('0%')).toEqual({ kind: 'percent', percent: 0, configured: '0%' });
    expect(reserveFor('50%')).toEqual({ kind: 'percent', percent: 50, configured: '50%' });
    // The display form is normalised, not echoed.
    expect(reserveFor('05%')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(reserveFor('0500')).toEqual({ kind: 'absolute', credits: 500, configured: '500' });
    expect(parseCreditReserve('5%')).toEqual({ kind: 'percent', percent: 5, configured: '5%' });
    expect(parseCreditReserve('5 %')).toBeNull();
  });

  it('rejects any other reserve spelling with a message naming the two accepted forms', () => {
    for (const bad of ['51%', '-1', 'abc', '5 %', '5%%', '1.5', '2.5%', '%', '500 credits']) {
      expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_CREDIT_RESERVE: bad }), bad).toThrow(
        /COUNTDOWN_CREDIT_RESERVE must be an absolute credit count such as 500 \(an integer of 0 or more\) or a percentage of the plan's credit limit such as 5% \(an integer from 0% to 50%\)/,
      );
    }
    // Validated whether or not the source is on: the value fails at boot, not on the day the key is added.
    expect(() => loadGatewayConfig({ ...BASE_ENV, COUNTDOWN_CREDIT_RESERVE: 'abc' })).toThrow(/COUNTDOWN_CREDIT_RESERVE/);
  });

  it('reads GATEWAY_BUILD_SHA into buildSha, with unknown as the fallback', () => {
    expect(loadGatewayConfig(BASE_ENV).buildSha).toBe('unknown');
    expect(loadGatewayConfig({ ...BASE_ENV, GATEWAY_BUILD_SHA: '' }).buildSha).toBe('unknown');
    expect(loadGatewayConfig({ ...BASE_ENV, GATEWAY_BUILD_SHA: '  ' }).buildSha).toBe('unknown');
    expect(loadGatewayConfig({ ...BASE_ENV, GATEWAY_BUILD_SHA: ' 03acf1d ' }).buildSha).toBe('03acf1d');
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_API_BASE_URL: 'countdown-stub' })).toThrow(
      /COUNTDOWN_API_BASE_URL/,
    );
  });

  it('refuses a blank Toronto postal code once the source is on', () => {
    expect(() => loadGatewayConfig({ ...KEYED_ENV, EBAY_DESTINATION_POSTAL_CODE: ' ' })).toThrow(
      /EBAY_DESTINATION_POSTAL_CODE/,
    );
    // With the source off the value is the Bridge's business and is left alone.
    expect(loadGatewayConfig({ ...BASE_ENV, EBAY_DESTINATION_POSTAL_CODE: ' ' }).countdown).toBeNull();
  });

  it('leaves the dashboard block independent of the source', () => {
    expect(loadGatewayConfig(KEYED_ENV).dashboards).toBeNull();
    const both = loadGatewayConfig({ ...KEYED_ENV, DASHBOARD_API_BASE_URL: 'http://dashboard-api:8082' });
    expect(both.dashboards?.baseUrl).toBe('http://dashboard-api:8082');
    expect(both.countdown?.apiKey).toBe('cd-test-key');
  });
});
