/**
 * Compose several versioned site profiles into the single profile a
 * PagePolicy is built from, so one agent session can research more than
 * one marketplace (the Fluxology deals pipeline runs eBay and Kijiji
 * passes in the same scheduled run).
 *
 * The merge is a pure union of allow AND deny data: allowed hosts widen
 * to the union, but every profile's blocked-action patterns, secret-field
 * autocomplete tokens, and transaction-endpoint deny regexes apply on
 * every site. The composite is therefore never more permissive on any
 * one site than that site's own profile.
 */
import type { SitePolicyProfile } from './types.js';

function union(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

export function mergeSiteProfiles(profiles: readonly SitePolicyProfile[]): SitePolicyProfile {
  if (profiles.length === 0) {
    throw new Error('mergeSiteProfiles requires at least one site profile');
  }
  if (profiles.length === 1) return profiles[0]!;

  const ids = profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`mergeSiteProfiles received duplicate profile ids: ${ids.join(', ')}`);
  }
  // Composites exist for production multi-site sessions; test escape
  // hatches must never widen a composite, so their presence is an error
  // rather than being silently dropped or propagated.
  const withTestOnly = profiles.filter((profile) => profile.testOnly !== undefined);
  if (withTestOnly.length > 0) {
    throw new Error(
      `refusing to merge profiles carrying testOnly escapes: ${withTestOnly.map((profile) => profile.id).join(', ')}`,
    );
  }
  const destinations = [
    ...new Set(
      profiles
        .map((profile) => profile.destinationPostalCode)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  if (destinations.length > 1) {
    throw new Error(`profiles disagree on destinationPostalCode: ${destinations.join(' vs ')}`);
  }

  return {
    id: ids.join('+'),
    allowedHosts: union(profiles.map((profile) => profile.allowedHosts)),
    blockedActionPatterns: union(profiles.map((profile) => profile.blockedActionPatterns)),
    blockedFieldAutocomplete: union(profiles.map((profile) => profile.blockedFieldAutocomplete)),
    transactionEndpointPatterns: union(profiles.map((profile) => profile.transactionEndpointPatterns)),
    ...(destinations.length === 1 ? { destinationPostalCode: destinations[0]! } : {}),
  };
}
