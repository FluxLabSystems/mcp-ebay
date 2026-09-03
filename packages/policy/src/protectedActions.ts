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

const READ_METHODS = new Set(['GET', 'HEAD']);

function matchesAny(target: string, sources: readonly string[]): string | null {
  for (const source of sources) {
    let regex: RegExp;
    try {
      regex = new RegExp(source, 'i');
    } catch {
      continue;
    }
    if (regex.test(target)) return source;
  }
  return null;
}

export function evaluateProtectedAction(
  action: ActionContext,
  profile: Pick<SitePolicyProfile, 'blockedActionPatterns' | 'transactionEndpointPatterns' | 'mutationEndpointPatterns'>,
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
    // An interaction that targets a mutation endpoint is a mutation
    // whatever method the control would use; only the network layer's
    // read exemption is method-aware.
    const matched = matchesAny(target, profile.transactionEndpointPatterns) ?? matchesAny(target, profile.mutationEndpointPatterns ?? []);
    if (matched !== null) {
      return {
        blocked: true,
        matchedPattern: matched,
        reason: `Target URL matches protected endpoint pattern`,
      };
    }
  }

  return { blocked: false };
}

/**
 * Network-layer request check (§19.2): abort protected endpoint requests.
 * Transaction endpoints are aborted for every method; mutation endpoints
 * (mutationEndpointPatterns) are aborted for every method except GET and
 * HEAD, so a signed-in page may READ the account state it renders — the
 * watch-list page loading the watch list — while the same API's add,
 * remove and update calls stay aborted. An omitted method is treated as
 * mutating, so a caller that does not know the method gets the strict
 * answer the pre-2026-09 code gave for every request.
 */
export function isProtectedEndpoint(
  requestUrl: string,
  profile: Pick<SitePolicyProfile, 'transactionEndpointPatterns' | 'mutationEndpointPatterns'>,
  method?: string,
): boolean {
  if (matchesAny(requestUrl, profile.transactionEndpointPatterns) !== null) return true;
  const mutation = profile.mutationEndpointPatterns ?? [];
  if (mutation.length === 0) return false;
  const isRead = method !== undefined && READ_METHODS.has(method.toUpperCase());
  return !isRead && matchesAny(requestUrl, mutation) !== null;
}
