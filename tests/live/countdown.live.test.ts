/**
 * Countdown API live smoke (docs/COUNTDOWN-API-PLAN.md §6.6; opt-in/manual
 * only). Requires:
 *   - COUNTDOWN_LIVE=1
 *   - COUNTDOWN_API_KEY=<a real key>
 *
 * Never runs in CI. Three charged requests, three credits: one
 * auction-filtered search, one item, one seller profile, plus the free
 * account status read. Shapes only — the marketplace data behind them
 * drifts by the hour.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadGatewayConfig } from '@browser-bridge/config';
import { CountdownSource, MemoryStore } from '@browser-bridge/gateway';
import {
  EbayApiItemsInput,
  EbayApiItemsOutput,
  EbayApiSearchInput,
  EbayApiSearchOutput,
  EbayApiSellerInput,
  EbayApiSellerOutput,
  EbayApiStatusOutput,
} from '@browser-bridge/protocol';

describe.skipIf(!process.env.COUNTDOWN_LIVE || !process.env.COUNTDOWN_API_KEY)('Countdown API live smoke (opt-in)', () => {
  let source: CountdownSource;

  // A skipped suite still has its body collected, so nothing that needs the
  // key runs outside a hook.
  beforeAll(() => {
    const config = loadGatewayConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://browser-mcp.test.example',
      DATABASE_URL: 'postgres://unused-in-live-smoke',
      COUNTDOWN_API_KEY: process.env.COUNTDOWN_API_KEY,
      // The reserve is the deployment's business; the smoke spends three credits whatever the balance.
      COUNTDOWN_CREDIT_RESERVE: '0',
    });
    source = new CountdownSource({ config: config.countdown!, store: new MemoryStore() });
  });

  it('reads the account status without spending a credit', async () => {
    const result = await source.status();
    expect(EbayApiStatusOutput.parse(result)).toBeTruthy();
    expect(result.probe.ok).toBe(true);
    expect(result.credits.remaining).not.toBeNull();
    expect(result.plan.creditsLimit).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(process.env.COUNTDOWN_API_KEY ?? '\u0000');
  }, 60_000);

  it('searches ebay.ca under the auction filter with the Toronto destination', async () => {
    const result = await source.search(
      EbayApiSearchInput.parse({ searchTerm: 'lego minifigure lot', listingType: 'auction', sortBy: 'newly_listed', num: 60, destination: 'toronto' }),
    );
    expect(EbayApiSearchOutput.parse(result)).toBeTruthy();
    expect(result.retrievedUnder).toEqual(['auction']);
    // 2026-09-02: the live vendor sent no request_metadata.id on any response; the field stays for when it does.
    expect(result.requestIds.length).toBeLessThanOrEqual(1);
    expect(result.credits.remaining).not.toBeNull();
    // A charged call never reports zero spend (null when the vendor omits the per-request figure).
    expect(result.credits.usedThisRequest).not.toBe(0);
  }, 180_000);

  it('reads one item page', async () => {
    const result = await source.items(EbayApiItemsInput.parse({ items: [{ itemId: '287557851282', expectedFormat: 'fixed_price' }], destination: 'toronto' }));
    expect(EbayApiItemsOutput.parse(result)).toBeTruthy();
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.warnings.some((warning) => warning.startsWith('DESTINATION_UNVERIFIED:'))).toBe(true);
  }, 180_000);

  it('confirms one seller profile', async () => {
    const result = await source.seller(EbayApiSellerInput.parse({ loginId: 'tweedsidesales' }));
    expect(EbayApiSellerOutput.parse(result)).toBeTruthy();
    expect(result.requestIds.length).toBeLessThanOrEqual(1);
    expect(result.credits.usedThisRequest).not.toBe(0);
  }, 120_000);
});
