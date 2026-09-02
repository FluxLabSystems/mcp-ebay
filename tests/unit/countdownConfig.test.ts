import { describe, expect, it } from 'vitest';
import { loadGatewayConfig } from '@browser-bridge/config';

// The same minimal gateway env dashboardClient.test.ts uses; every other
// variable takes its default.
const BASE_ENV = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
  DATABASE_URL: 'postgres://unused',
};

const KEYED_ENV = { ...BASE_ENV, COUNTDOWN_API_KEY: 'cd-test-key' };

describe('gateway Countdown API configuration', () => {
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
      baseUrl: 'https://api.countdownapi.com',
      creditReserve: 500,
      maxConcurrency: 4,
      timeoutMs: 90_000,
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
      COUNTDOWN_API_BASE_URL: 'http://countdown-stub:9999///',
    });
    expect(config.countdown?.apiKey).toBe('cd-test-key');
    expect(config.countdown?.baseUrl).toBe('http://countdown-stub:9999');
  });

  it('reads the tuning knobs at their bounds', () => {
    const config = loadGatewayConfig({
      ...KEYED_ENV,
      COUNTDOWN_CREDIT_RESERVE: '0',
      COUNTDOWN_MAX_CONCURRENCY: '8',
      COUNTDOWN_TIMEOUT_MS: '5000',
      EBAY_FORWARDER_ZIPCODE: '90210',
    });
    expect(config.countdown).toMatchObject({ creditReserve: 0, maxConcurrency: 8, timeoutMs: 5_000 });
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
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_TIMEOUT_MS: '300001' })).toThrow(/COUNTDOWN_TIMEOUT_MS/);
    expect(() => loadGatewayConfig({ ...KEYED_ENV, COUNTDOWN_CREDIT_RESERVE: '-1' })).toThrow(
      /COUNTDOWN_CREDIT_RESERVE/,
    );
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
