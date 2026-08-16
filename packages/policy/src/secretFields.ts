/**
 * Secret field detection — SDD v0.5 §19.3. Values from blocked fields are
 * never returned in snapshots or extraction output; interaction with them
 * fails with SECRET_FIELD_BLOCKED.
 */
import type { FieldContext, SitePolicyProfile } from './types.js';

/** Global autocomplete tokens that always mark a secret field. */
export const SECRET_AUTOCOMPLETE_TOKENS: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-csc',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-type',
];

const SECRET_INPUT_TYPES = new Set(['password']);

/**
 * Signals that an enclosing form is a payment, authentication, security, or
 * account-recovery form (§19.3 second rule). Matched against a lower-cased
 * blob of form action/id/class/aria text.
 */
const SENSITIVE_FORM_SIGNALS: readonly string[] = [
  'password',
  'passwd',
  'signin',
  'sign-in',
  'login',
  'log-in',
  'payment',
  'checkout',
  'billing',
  'credit-card',
  'creditcard',
  'card-number',
  'cvv',
  'security',
  'account-recovery',
  'recovery',
  'two-factor',
  '2fa',
  'totp',
  'one-time',
  'otp',
  'verification-code',
];

export interface SecretFieldDecision {
  blocked: boolean;
  reason?: string;
}

export function evaluateSecretField(
  field: FieldContext,
  profile?: Pick<SitePolicyProfile, 'blockedFieldAutocomplete'>,
): SecretFieldDecision {
  const inputType = field.inputType?.toLowerCase().trim() ?? '';
  if (SECRET_INPUT_TYPES.has(inputType)) {
    return { blocked: true, reason: `input type "${inputType}" is a secret field` };
  }

  const autocompleteTokens = (field.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const blockedTokens = new Set([
    ...SECRET_AUTOCOMPLETE_TOKENS,
    ...(profile?.blockedFieldAutocomplete ?? []).map((token) => token.toLowerCase()),
  ]);
  for (const token of autocompleteTokens) {
    if (blockedTokens.has(token)) {
      return { blocked: true, reason: `autocomplete token "${token}" marks a secret field` };
    }
  }

  const formBlob = (field.formSignals ?? '').toLowerCase();
  if (formBlob.length > 0) {
    for (const signal of SENSITIVE_FORM_SIGNALS) {
      if (formBlob.includes(signal)) {
        return {
          blocked: true,
          reason: `field is inside a recognized sensitive form (signal "${signal}")`,
        };
      }
    }
  }

  const nameBlob = `${field.name ?? ''} ${field.id ?? ''} ${field.ariaLabel ?? ''}`.toLowerCase();
  for (const hint of ['password', 'card number', 'cvv', 'cvc', 'security code', 'one-time code', 'otp']) {
    if (nameBlob.includes(hint)) {
      return { blocked: true, reason: `field name/label matches secret hint "${hint}"` };
    }
  }

  return { blocked: false };
}
