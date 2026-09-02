import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_ID_PATTERN,
  BRIDGE_ERROR_CODES,
  BridgeError,
  BROWSER_SESSION_HANDLE_PATTERN,
  ELEMENT_REF_PATTERN,
  ERROR_CATALOG,
  IMAGE_ID_PATTERN,
  isBridgeErrorCode,
  makeElementRef,
  newArtifactId,
  newBrowserSessionHandle,
  newImageId,
  newTabId,
  parseElementRef,
  TAB_ID_PATTERN,
  ulid,
} from '@browser-bridge/protocol';

describe('error catalog (§17)', () => {
  it('contains exactly the 27 normative codes', () => {
    // 24 from SDD v0.5 §17 plus the three Countdown API source codes
    // (docs/COUNTDOWN-API-PLAN.md §2).
    expect(BRIDGE_ERROR_CODES).toHaveLength(27);
    expect(BRIDGE_ERROR_CODES).toContain('DESTINATION_UNVERIFIED');
    expect(BRIDGE_ERROR_CODES).toContain('PROFILE_IN_USE');
    expect(BRIDGE_ERROR_CODES).toContain('SOURCE_UNAVAILABLE');
    expect(BRIDGE_ERROR_CODES).toContain('SOURCE_CREDITS_EXHAUSTED');
    expect(BRIDGE_ERROR_CODES).toContain('SOURCE_REJECTED');
  });

  it('matches the normative retryability table', () => {
    const retryable = [
      'DEVICE_OFFLINE',
      'BROWSER_UNAVAILABLE',
      'TAB_NOT_FOUND',
      'STALE_ELEMENT',
      'DESTINATION_UNVERIFIED',
      'NAVIGATION_TIMEOUT',
      'CONDITION_TIMEOUT',
      'EXTRACTION_INCOMPLETE',
      'RATE_LIMITED',
      // A vendor incident, 5xx or timeout clears on its own; exhausted
      // credits and a rejected request do not, so only this one retries.
      'SOURCE_UNAVAILABLE',
      'INTERNAL_ERROR',
    ];
    for (const code of BRIDGE_ERROR_CODES) {
      expect(ERROR_CATALOG[code].retryable, code).toBe(retryable.includes(code));
    }
  });

  it('BridgeError carries code/retryable/details payload (§12.3 envelope shape)', () => {
    const err = new BridgeError('STALE_ELEMENT', undefined, { elementRef: 'el_1_0_x' });
    expect(err.toPayload()).toEqual({
      code: 'STALE_ELEMENT',
      message: ERROR_CATALOG.STALE_ELEMENT.message,
      retryable: true,
      details: { elementRef: 'el_1_0_x' },
    });
    expect(isBridgeErrorCode('NOT_A_CODE')).toBe(false);
  });
});

describe('identifier formats (§14, Appendix A)', () => {
  it('generates handles matching the normative patterns', () => {
    expect(newBrowserSessionHandle()).toMatch(BROWSER_SESSION_HANDLE_PATTERN);
    expect(newTabId()).toMatch(TAB_ID_PATTERN);
    expect(newImageId()).toMatch(IMAGE_ID_PATTERN);
    expect(newArtifactId()).toMatch(ARTIFACT_ID_PATTERN);
  });

  it('ulid is 26 chars, sortable by time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    expect(early).toHaveLength(26);
    expect(early < late).toBe(true);
  });

  it('element refs round-trip and match the appendix pattern', () => {
    const ref = makeElementRef(42, 7, 'a1b2c3');
    expect(ref).toBe('el_42_7_a1b2c3');
    expect(ref).toMatch(ELEMENT_REF_PATTERN);
    expect(parseElementRef(ref)).toEqual({ pageRevision: 42, ordinal: 7, hash: 'a1b2c3' });
    expect(parseElementRef('el_x_y')).toBeNull();
  });
});
