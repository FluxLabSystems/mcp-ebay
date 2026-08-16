/**
 * Protected-action policy — SDD v0.5 §19.2. click/fill/key/select MUST
 * inspect accessible name, role, href/form action, page context, and
 * site-profile deny rules before interaction. The deny list is
 * defense-in-depth alongside network-layer endpoint blocking.
 */
import type { ActionContext, SitePolicyProfile } from './types.js';

export interface ActionDecision {
  blocked: boolean;
  matchedPattern?: string;
  reason?: string;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function evaluateProtectedAction(
  action: ActionContext,
  profile: Pick<SitePolicyProfile, 'blockedActionPatterns' | 'transactionEndpointPatterns'>,
): ActionDecision {
  const haystacks = [action.accessibleName, action.text ?? '']
    .map(normalizeText)
    .filter((value) => value.length > 0);

  for (const pattern of profile.blockedActionPatterns) {
    const needle = normalizeText(pattern);
    if (needle.length === 0) continue;
    for (const haystack of haystacks) {
      if (haystack.includes(needle)) {
        return {
          blocked: true,
          matchedPattern: pattern,
          reason: `Accessible name/text matches protected pattern "${pattern}"`,
        };
      }
    }
  }

  for (const target of [action.href, action.formAction]) {
    if (!target) continue;
    for (const source of profile.transactionEndpointPatterns) {
      let regex: RegExp;
      try {
        regex = new RegExp(source, 'i');
      } catch {
        continue;
      }
      if (regex.test(target)) {
        return {
          blocked: true,
          matchedPattern: source,
          reason: `Target URL matches protected endpoint pattern`,
        };
      }
    }
  }

  return { blocked: false };
}

/** Network-layer request check (§19.2): abort protected endpoint requests. */
export function isProtectedEndpoint(
  requestUrl: string,
  profile: Pick<SitePolicyProfile, 'transactionEndpointPatterns'>,
): boolean {
  for (const source of profile.transactionEndpointPatterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(source, 'i');
    } catch {
      continue;
    }
    if (regex.test(requestUrl)) return true;
  }
  return false;
}
