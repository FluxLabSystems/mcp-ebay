/**
 * URL and SSRF policy — SDD v0.5 §19.1. The local policy engine is
 * authoritative; gateway/LLM classifications are hints only.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BridgeError } from '@browser-bridge/protocol';
import { classifyIpLiteral, isProhibitedAddress } from './ipClassify.js';
import type { SitePolicyProfile, UrlPolicyContext, UrlPolicyDecision } from './types.js';

export interface UrlPolicyOptions {
  /** Injectable DNS resolver (tests use a stub; production uses dns.lookup all-addresses). */
  resolve?: (hostname: string) => Promise<string[]>;
}

const BROWSER_INTERNAL_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'filesystem:',
]);

const ALWAYS_DENIED_SCHEMES = new Set(['file:', 'data:', 'javascript:', 'blob:', 'vbscript:', 'ftp:']);

async function defaultResolve(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}

/**
 * Contexts the auth-surface deny rules apply to. Subresources are exempt on
 * purpose: an allowed page may pull assets from an auth host, and blocking
 * those would break rendering without stopping any sign-in. What must never
 * happen is the TAB landing on an auth page — directly, via redirect hop,
 * popup, or frame handoff.
 */
const AUTH_BLOCKED_CONTEXTS: ReadonlySet<UrlPolicyContext> = new Set([
  'navigation',
  'redirect',
  'popup',
  'frame',
]);

/** Compiled authPathPatterns, memoized per profile object. */
const authPatternCache = new WeakMap<SitePolicyProfile, RegExp[]>();

function compiledAuthPatterns(profile: SitePolicyProfile): RegExp[] {
  const cached = authPatternCache.get(profile);
  if (cached !== undefined) return cached;
  const compiled: RegExp[] = [];
  for (const source of profile.authPathPatterns ?? []) {
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch {
      // An uncompilable deny rule must not silently widen the surface; fail
      // closed by matching everything the raw source appears in.
      compiled.push(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  }
  authPatternCache.set(profile, compiled);
  return compiled;
}

/** True when the URL matches the profile's auth-surface deny rules. */
export function isAuthPathBlocked(rawUrl: string, profile: SitePolicyProfile): boolean {
  const patterns = compiledAuthPatterns(profile);
  if (patterns.length === 0) return false;
  return patterns.some((pattern) => pattern.test(rawUrl));
}

/**
 * Label-boundary-safe host allowlist match. "ebay.ca" matches only itself;
 * "*.ebay.ca" matches any depth of subdomain but never "notebay.ca".
 * Comparison is case-insensitive; trailing dots are normalized away.
 */
export function hostMatchesAllowlist(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  for (const raw of allowedHosts) {
    const entry = raw.toLowerCase().replace(/\.$/, '');
    if (entry.startsWith('*.')) {
      const base = entry.slice(2);
      if (host === base) continue; // bare host must be listed explicitly
      if (host.endsWith(`.${base}`)) return true;
    } else if (host === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Full URL policy check for a tool-target navigation, redirect hop, popup,
 * frame handoff, or direct image download. Resolves DNS and rejects any
 * prohibited address (§19.1 rebinding rule: a host that resolves to a
 * prohibited address is never allowed).
 */
export async function checkUrl(
  rawUrl: string,
  profile: SitePolicyProfile,
  context: UrlPolicyContext,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyDecision> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, errorCode: 'SCHEME_DENIED', reason: `Unparseable URL: ${rawUrl}` };
  }

  const scheme = url.protocol;
  if (ALWAYS_DENIED_SCHEMES.has(scheme) || BROWSER_INTERNAL_SCHEMES.has(scheme)) {
    return { allowed: false, errorCode: 'SCHEME_DENIED', reason: `Scheme ${scheme} is not permitted` };
  }
  if (scheme !== 'https:') {
    if (scheme === 'http:' && profile.testOnly?.allowInsecureHttp === true) {
      // test-only profiles may serve fixtures over http
    } else {
      return { allowed: false, errorCode: 'SCHEME_DENIED', reason: `Scheme ${scheme} is not permitted` };
    }
  }

  const hostname = url.hostname;
  // Deny wins, and it wins BEFORE the allowlist so no union of profiles can
  // ever re-admit a host one profile has permanently ruled out.
  if (profile.deniedHosts !== undefined && hostMatchesAllowlist(hostname, profile.deniedHosts)) {
    return {
      allowed: false,
      errorCode: 'ORIGIN_DENIED',
      reason: `Host ${hostname} is on the ${profile.id} permanent deny list`,
    };
  }
  if (!hostMatchesAllowlist(hostname, profile.allowedHosts)) {
    return {
      allowed: false,
      errorCode: 'ORIGIN_DENIED',
      reason: `Host ${hostname} is not in the ${profile.id} allowlist`,
    };
  }

  // Auth surfaces are blocked by default for tab-level targets, and because
  // this same check runs on every main-frame hop (context 'redirect'), the
  // policy holds for the POST-REDIRECT host, not just the requested URL.
  if (AUTH_BLOCKED_CONTEXTS.has(context) && isAuthPathBlocked(rawUrl, profile)) {
    return {
      allowed: false,
      errorCode: 'ACTION_BLOCKED',
      reason: `${rawUrl} matches the ${profile.id} auth-page deny rules (sign-in/registration/credential surfaces are blocked)`,
    };
  }

  const allowPrivate = profile.testOnly?.allowPrivateNetworks === true;
  const bareHost = hostname.replace(/^\[|\]$/g, '');
  if (isIP(bareHost)) {
    if (!allowPrivate && classifyIpLiteral(bareHost) !== 'public') {
      return {
        allowed: false,
        errorCode: 'PRIVATE_NETWORK_DENIED',
        reason: `Literal address ${bareHost} is in a prohibited range`,
      };
    }
    return { allowed: true, resolvedAddresses: [bareHost] };
  }

  // Subresource requests are constrained by scheme + allowlist; full DNS
  // classification applies to tool targets and downloads (§19.1 list).
  if (context === 'subresource') {
    return { allowed: true };
  }

  const resolve = options.resolve ?? defaultResolve;
  let addresses: string[];
  try {
    addresses = await resolve(bareHost);
  } catch {
    return {
      allowed: false,
      errorCode: 'PRIVATE_NETWORK_DENIED',
      reason: `Hostname ${bareHost} did not resolve`,
    };
  }
  if (addresses.length === 0) {
    return {
      allowed: false,
      errorCode: 'PRIVATE_NETWORK_DENIED',
      reason: `Hostname ${bareHost} did not resolve`,
    };
  }
  if (!allowPrivate) {
    for (const address of addresses) {
      if (isProhibitedAddress(address)) {
        return {
          allowed: false,
          errorCode: 'PRIVATE_NETWORK_DENIED',
          reason: `Hostname ${bareHost} resolves to prohibited address ${address}`,
        };
      }
    }
  }
  return { allowed: true, resolvedAddresses: addresses };
}

/** checkUrl variant that throws the catalogued BridgeError on denial. */
export async function assertUrlAllowed(
  rawUrl: string,
  profile: SitePolicyProfile,
  context: UrlPolicyContext,
  options: UrlPolicyOptions = {},
): Promise<UrlPolicyDecision> {
  const decision = await checkUrl(rawUrl, profile, context, options);
  if (!decision.allowed) {
    throw new BridgeError(decision.errorCode ?? 'ORIGIN_DENIED', decision.reason, {
      url: rawUrl,
      context,
    });
  }
  return decision;
}
