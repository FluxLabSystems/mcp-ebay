/**
 * Destination verification flow metadata — SDD v0.5 §20.1. The agent
 * drives these reversible steps with browser-core primitives; only
 * destination controls are touched, never passwords or payment data.
 */

/**
 * Selectors used by the agent's destination routine, in attempt order.
 * The flow: open the shipping "Change/Deliver to" control, fill the postal
 * code, apply, then re-read the indicator from rendered state.
 */
export const DESTINATION_CONTROL_SELECTORS = {
  openControl: [
    '.ux-labels-values--shipping button',
    '[data-testid="ux-labels-values--shipping"] button',
    'button[aria-label*="Change" i]',
    '.vim-delivery-module button',
    '#SRPSection button',
  ],
  postalInput: [
    'input[name="zipCode" i]',
    'input[id*="zipCode" i]',
    'input[aria-label*="postal" i]',
    'input[placeholder*="postal" i]',
    '.shzipmodal input[type="text"]',
  ],
  applyButton: [
    'button[type="submit"]',
    'button[aria-label*="Apply" i]',
    '.shzipmodal button',
  ],
} as const;

export type DestinationVerdict =
  | { verified: true; postalCode: string }
  | { verified: false; postalCode: string | null; reason: string };

export function destinationVerdict(
  observedPostal: string | null,
  expectedPostal: string,
  matches: (a: string, b: string) => boolean,
): DestinationVerdict {
  if (observedPostal === null) {
    return { verified: false, postalCode: null, reason: 'No destination indicator found in rendered page state' };
  }
  if (!matches(observedPostal, expectedPostal)) {
    return {
      verified: false,
      postalCode: observedPostal,
      reason: `Destination indicator shows ${observedPostal}, expected ${expectedPostal}`,
    };
  }
  return { verified: true, postalCode: observedPostal };
}
