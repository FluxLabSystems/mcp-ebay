/**
 * Identifier formats and generators — SDD v0.5 §14 and Appendix A common
 * definitions. Handles are opaque application-level state passed in MCP
 * tool arguments; they are not MCP transport sessions.
 */
import { randomBytes } from 'node:crypto';

export const BROWSER_SESSION_HANDLE_PATTERN = /^bs_[A-Za-z0-9_-]{16,}$/;
export const TAB_ID_PATTERN = /^tab_[A-Za-z0-9_-]{10,}$/;
export const ELEMENT_REF_PATTERN = /^el_[0-9]+_[A-Za-z0-9_-]+$/;
export const IMAGE_ID_PATTERN = /^img_[A-Za-z0-9_-]{10,}$/;
export const ARTIFACT_ID_PATTERN = /^art_[A-Za-z0-9_-]{10,}$/;
export const DEVICE_ID_PATTERN = /^dev_[A-Za-z0-9_-]{10,}$/;

/** Crockford base32 alphabet used by ULID. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Dependency-free ULID: 48-bit millisecond timestamp + 80 bits of
 * crypto randomness, Crockford base32, 26 chars, lexicographically sortable.
 */
export function ulid(now: number = Date.now()): string {
  let time = now;
  const timeChars: string[] = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = ULID_ALPHABET[time % 32]!;
    time = Math.floor(time / 32);
  }
  const rand = randomBytes(16);
  let out = timeChars.join('');
  for (let i = 0; i < 16; i++) {
    out += ULID_ALPHABET[rand[i]! % 32];
  }
  return out;
}

/** bs_ + 128-bit random base64url (§14 identifier table). */
export function newBrowserSessionHandle(): string {
  return `bs_${randomBytes(16).toString('base64url')}`;
}

export function newTabId(): string {
  return `tab_${ulid()}`;
}

export function newRequestId(): string {
  return ulid();
}

export function newIdempotencyKey(): string {
  return `idem_${ulid()}`;
}

export function newArtifactId(): string {
  return `art_${ulid()}`;
}

export function newImageId(): string {
  return `img_${ulid()}`;
}

export function newDeviceId(): string {
  return `dev_${ulid()}`;
}

export function newEventId(): string {
  return `evt_${ulid()}`;
}

/** elementRef format el_<pageRevision>_<ordinal>_<hash> (§14). */
export function makeElementRef(pageRevision: number, ordinal: number, hash: string): string {
  return `el_${pageRevision}_${ordinal}_${hash}`;
}

export interface ParsedElementRef {
  pageRevision: number;
  ordinal: number;
  hash: string;
}

export function parseElementRef(ref: string): ParsedElementRef | null {
  const match = /^el_([0-9]+)_([0-9]+)_([A-Za-z0-9_-]+)$/.exec(ref);
  if (!match) return null;
  return {
    pageRevision: Number.parseInt(match[1]!, 10),
    ordinal: Number.parseInt(match[2]!, 10),
    hash: match[3]!,
  };
}
