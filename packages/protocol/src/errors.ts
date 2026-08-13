/**
 * Stable error model — SDD v0.5 §17. Codes, retryability, and default
 * messages are normative; the catalog is frozen for major API version 1.
 */

export const ERROR_CATALOG = {
  DEVICE_OFFLINE: { retryable: true, message: 'Selected Windows agent is not connected.' },
  DEVICE_UNAUTHORIZED: { retryable: false, message: 'Device pairing/signature/revocation failed.' },
  BROWSER_UNAVAILABLE: {
    retryable: true,
    message:
      'Google Chrome context could not be launched/recovered, or the required branded Chrome installation/channel is unavailable.',
  },
  PROFILE_IN_USE: { retryable: false, message: 'Dedicated browser profile is owned by another process.' },
  SESSION_NOT_FOUND: { retryable: false, message: 'browserSessionHandle is unknown or not owned by device.' },
  TAB_NOT_FOUND: { retryable: true, message: 'tabId no longer exists.' },
  STALE_ELEMENT: { retryable: true, message: 'elementRef belongs to an older page revision.' },
  ORIGIN_DENIED: { retryable: false, message: 'URL origin is not in the site allowlist.' },
  PRIVATE_NETWORK_DENIED: {
    retryable: false,
    message: 'Resolved target/redirect is loopback, link-local, RFC1918/private, or otherwise prohibited.',
  },
  SCHEME_DENIED: { retryable: false, message: 'URL scheme is not permitted.' },
  ACTION_BLOCKED: { retryable: false, message: 'Local protected-action policy denied the requested interaction.' },
  SECRET_FIELD_BLOCKED: {
    retryable: false,
    message: 'Target is password, payment, 2FA, security, or other secret field.',
  },
  DESTINATION_UNVERIFIED: {
    retryable: true,
    message: 'eBay shipping destination could not be verified as M6H 2W9.',
  },
  NAVIGATION_TIMEOUT: { retryable: true, message: 'Navigation exceeded timeout.' },
  CONDITION_TIMEOUT: { retryable: true, message: 'Wait condition exceeded timeout.' },
  DOWNLOAD_BLOCKED: { retryable: false, message: 'Download violates site/profile policy.' },
  ARTIFACT_TOO_LARGE: { retryable: false, message: 'Artifact exceeds configured size limit.' },
  ARTIFACT_EXPIRED: { retryable: false, message: 'Artifact TTL elapsed.' },
  REQUEST_EXPIRED: { retryable: false, message: 'Agent command expired before execution.' },
  CANCELLED: { retryable: false, message: 'Command was cancelled.' },
  SITE_PROFILE_MISMATCH: { retryable: false, message: 'Named extractor does not support current origin/page.' },
  EXTRACTION_INCOMPLETE: { retryable: true, message: 'Required extraction fields could not be resolved.' },
  RATE_LIMITED: { retryable: true, message: 'Local/gateway rate limit exceeded.' },
  INTERNAL_ERROR: { retryable: true, message: 'Unexpected internal failure; trace id supplied.' },
} as const;

export type BridgeErrorCode = keyof typeof ERROR_CATALOG;

export const BRIDGE_ERROR_CODES = Object.keys(ERROR_CATALOG) as BridgeErrorCode[];

export function isBridgeErrorCode(code: string): code is BridgeErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_CATALOG, code);
}

export function isRetryable(code: BridgeErrorCode): boolean {
  return ERROR_CATALOG[code].retryable;
}

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? ERROR_CATALOG[code].message);
    this.name = 'BridgeError';
    this.code = code;
    this.retryable = ERROR_CATALOG[code].retryable;
    this.details = details ?? {};
  }

  toPayload(): BridgeErrorPayload {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }

  static from(err: unknown, fallback: BridgeErrorCode = 'INTERNAL_ERROR'): BridgeError {
    if (err instanceof BridgeError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new BridgeError(fallback, message);
  }
}
