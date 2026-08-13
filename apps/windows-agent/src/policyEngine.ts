/**
 * Local policy engine host — SDD v0.5 §19. Builds the authoritative
 * PagePolicy from a versioned site profile. Gateway/LLM classifications
 * are hints only; everything is re-checked here.
 */
import type { PagePolicy } from '@browser-bridge/browser-core';
import {
  checkUrl,
  evaluateProtectedAction,
  evaluateSecretField,
  isProtectedEndpoint,
  type ActionContext,
  type FieldContext,
  type SitePolicyProfile,
  type UrlPolicyContext,
  type UrlPolicyDecision,
  type UrlPolicyOptions,
} from '@browser-bridge/policy';
import { BridgeError } from '@browser-bridge/protocol';

export function createPagePolicy(profile: SitePolicyProfile, urlOptions: UrlPolicyOptions = {}): PagePolicy {
  return {
    profile,
    async checkUrl(url: string, context: UrlPolicyContext): Promise<UrlPolicyDecision> {
      return checkUrl(url, profile, context, urlOptions);
    },
    async assertUrlAllowed(url: string, context: UrlPolicyContext): Promise<UrlPolicyDecision> {
      const decision = await checkUrl(url, profile, context, urlOptions);
      if (!decision.allowed) {
        throw new BridgeError(decision.errorCode ?? 'ORIGIN_DENIED', decision.reason, { url, context });
      }
      return decision;
    },
    assertActionAllowed(action: ActionContext): void {
      const decision = evaluateProtectedAction(action, profile);
      if (decision.blocked) {
        throw new BridgeError('ACTION_BLOCKED', decision.reason, {
          matchedPattern: decision.matchedPattern,
          accessibleName: action.accessibleName,
        });
      }
    },
    assertFieldAllowed(field: FieldContext): void {
      const decision = evaluateSecretField(field, profile);
      if (decision.blocked) {
        throw new BridgeError('SECRET_FIELD_BLOCKED', decision.reason, {});
      }
    },
    isProtectedEndpoint(url: string): boolean {
      return isProtectedEndpoint(url, profile);
    },
    isSecretField(field: FieldContext): boolean {
      return evaluateSecretField(field, profile).blocked;
    },
  };
}
