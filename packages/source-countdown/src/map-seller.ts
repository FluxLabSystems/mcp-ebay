/**
 * Seller profile → SellerProfile — docs/COUNTDOWN-API-PLAN.md §3.3, §4.3.
 *
 * Pure. Measured (§1.3): the `/usr/` form returns name, a `/str/` store
 * link, positive percent and followers ("79 followers"); the store slug
 * differs from the login id, so the login id comes from a `/usr/` or
 * `/sch/<id>/m.html` link — the vendor's when it is one, else the URL the
 * caller asked for.
 */
import { COUNTDOWN_WARNING, nonEmpty, parseSellerLink, readInt, readNumber } from './common.js';
import { SellerProfileResponseSchema, parseCountdownBody } from './schemas.js';

export interface SellerProfile {
  /** Display name; not a login id. */
  name: string | null;
  /** The /usr/<loginId> page when one is known (the vendor's link, the requested URL, or synthesised from the login id). */
  profileUrl: string | null;
  loginId: string | null;
  /** The /str/<slug> segment when a store link is known; not a login id. */
  storeSlug: string | null;
  storeUrl: string | null;
  memberSince: string | null;
  positivePercent: number | null;
  followers: number | null;
  /** Followers as rendered ("79 followers"). */
  followersText: string | null;
  location: string | null;
  topRated: boolean | null;
  /** ≤ 500 characters. */
  description: string | null;
  imageUrl: string | null;
}

export interface MapSellerProfileInput {
  /** A decoded seller_profile response (the client's `body`, or a fixture). */
  body: unknown;
  /** The /usr/ or /str/ URL the caller asked for; the login-id fallback. */
  requestedUrl?: string | null;
}

export interface MapSellerProfileResult {
  /** False when the vendor returned no seller block or an empty name. */
  resolved: boolean;
  seller: SellerProfile | null;
  warnings: string[];
}

const DESCRIPTION_MAX = 500;

function truncate(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function mapSellerProfile(input: MapSellerProfileInput): MapSellerProfileResult {
  const body = parseCountdownBody(SellerProfileResponseSchema, input.body, 'seller_profile');
  const warnings: string[] = [];
  const seller = body.seller ?? null;
  const name = nonEmpty(seller?.name);
  if (seller === null || name === null) {
    const message = nonEmpty(body.message) ?? nonEmpty(body.request_info?.message);
    warnings.push(
      `${COUNTDOWN_WARNING.SELLER_UNRESOLVED}: ${message ?? 'the source returned no seller block'}`,
    );
    return { resolved: false, seller: null, warnings };
  }

  const requestedUrl = nonEmpty(input.requestedUrl);
  const vendorLink = nonEmpty(seller.link);
  const ebayUrl = nonEmpty(body.request_metadata?.ebay_url);
  const paramsUrl = nonEmpty(body.request_parameters?.url);
  const candidates = [vendorLink, requestedUrl, ebayUrl, paramsUrl].map((url) => ({ url, parsed: parseSellerLink(url) }));

  const usr = candidates.find((entry) => entry.parsed.kind === 'usr' && entry.parsed.loginId !== null);
  const sch = candidates.find((entry) => entry.parsed.kind === 'sch' && entry.parsed.loginId !== null);
  const str = candidates.find((entry) => entry.parsed.kind === 'str' && entry.parsed.storeSlug !== null);
  const loginId = usr?.parsed.loginId ?? sch?.parsed.loginId ?? nonEmpty(body.request_parameters?.seller_name);
  const storeSlug = str?.parsed.storeSlug ?? null;
  const host = hostOf(vendorLink) ?? hostOf(requestedUrl) ?? hostOf(ebayUrl) ?? 'www.ebay.ca';

  let profileUrl: string | null = null;
  if (usr !== undefined && usr.url !== null) {
    try {
      const url = new URL(usr.url);
      profileUrl = `${url.origin}${url.pathname}`;
    } catch {
      profileUrl = usr.url;
    }
  } else if (loginId !== null) {
    profileUrl = `https://${host}/usr/${encodeURIComponent(loginId)}`;
  }
  const storeUrl = str?.url ?? null;

  if (loginId === null) {
    warnings.push(
      `${COUNTDOWN_WARNING.SELLER_LOGIN_ID_UNAVAILABLE}: no /usr/ or /sch/<id>/m.html link was available${
        storeSlug === null ? '' : ` (only the store page /str/${storeSlug})`
      }; loginId is null.`,
    );
  }

  const followersText = typeof seller.followers === 'number' ? `${seller.followers}` : nonEmpty(seller.followers);
  return {
    resolved: true,
    seller: {
      name,
      profileUrl,
      loginId,
      storeSlug,
      storeUrl,
      memberSince: nonEmpty(seller.member_since),
      positivePercent: readNumber(seller.positive_ratings_percent),
      followers: readInt(seller.followers),
      followersText,
      location: nonEmpty(seller.location),
      topRated: typeof seller.top_rated_seller === 'boolean' ? seller.top_rated_seller : null,
      description: truncate(nonEmpty(seller.description), DESCRIPTION_MAX),
      imageUrl: nonEmpty(seller.image),
    },
    warnings,
  };
}
