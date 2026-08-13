/**
 * eBay destination verification flow — SDD v0.5 §20.1. Uses only
 * reversible destination controls; never enters passwords or payment
 * data. Verification is read from rendered page state.
 */
import type { BrowserSessionRuntime } from '@browser-bridge/browser-core';
import { normalizePostalCode, postalCodesMatch, DESTINATION_CONTROL_SELECTORS } from '@browser-bridge/site-ebay';
import type { Logger } from './logger.js';

export interface DestinationOutcome {
  postalCode: string | null;
  verified: boolean;
  attemptedSet: boolean;
}

const POSTAL_TEXT_PATTERN = String.raw`\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b`;

/** Read the destination indicator from the live page (§20.1 steps 2/4). */
export async function readLiveDestination(session: BrowserSessionRuntime, tabId: string): Promise<string | null> {
  const tab = session.getTab(tabId);
  const raw = await tab.page.evaluate((pattern: string) => {
    const regex = new RegExp(pattern);
    const selectors = [
      '.ux-labels-values--deliverto .ux-labels-values__values',
      '.ux-labels-values--delivery .ux-labels-values__values',
      '[data-testid="ux-labels-values--delivery"] .ux-labels-values__values',
      '.vim-delivery-module',
      '.ux-labels-values--shipping .ux-labels-values__values',
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.replace(/\s+/g, ' ') ?? '';
      const match = regex.exec(text);
      if (match) return match[0];
    }
    return null;
  }, POSTAL_TEXT_PATTERN);
  return raw === null ? null : normalizePostalCode(raw);
}

/**
 * Verify the destination and, when it differs, attempt the reversible
 * set-postal-code flow. Failure is reported, never silently proxied:
 * downstream shipping stays destinationVerified=false (§20.1 step 6).
 */
export async function ensureDestination(
  session: BrowserSessionRuntime,
  tabId: string,
  expectedPostal: string,
  logger: Logger,
): Promise<DestinationOutcome> {
  const current = await readLiveDestination(session, tabId);
  if (current !== null && postalCodesMatch(current, expectedPostal)) {
    return { postalCode: current, verified: true, attemptedSet: false };
  }

  const tab = session.getTab(tabId);
  let attemptedSet = false;
  try {
    // Step 3: open the destination control if present.
    for (const selector of DESTINATION_CONTROL_SELECTORS.openControl) {
      const control = tab.page.locator(selector).first();
      if ((await control.count()) > 0 && (await control.isVisible().catch(() => false))) {
        await control.click({ timeout: 5000 });
        attemptedSet = true;
        break;
      }
    }
    if (attemptedSet) {
      let filled = false;
      for (const selector of DESTINATION_CONTROL_SELECTORS.postalInput) {
        const input = tab.page.locator(selector).first();
        if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
          await input.fill(expectedPostal, { timeout: 5000 });
          filled = true;
          break;
        }
      }
      if (filled) {
        for (const selector of DESTINATION_CONTROL_SELECTORS.applyButton) {
          const button = tab.page.locator(selector).first();
          if ((await button.count()) > 0 && (await button.isVisible().catch(() => false))) {
            await button.click({ timeout: 5000 });
            break;
          }
        }
        await tab.page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => undefined);
        await tab.page.waitForTimeout(750);
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'Destination set flow failed; continuing unverified');
  }

  // Steps 4-5: re-read from rendered state; only a visible match verifies.
  const after = await readLiveDestination(session, tabId);
  const verified = after !== null && postalCodesMatch(after, expectedPostal);
  return { postalCode: after, verified, attemptedSet };
}
