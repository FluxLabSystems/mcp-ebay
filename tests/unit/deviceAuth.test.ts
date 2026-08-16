import { describe, expect, it } from 'vitest';
import {
  challengeDigest,
  generateDeviceKeyPair,
  generatePairingToken,
  hashPairingToken,
  newChallengeNonce,
  pairingTokenMatches,
  publicKeyFingerprint,
  signChallenge,
  timestampWithinSkew,
  verifyChallengeSignature,
} from '@browser-bridge/protocol';

describe('Ed25519 challenge-response (§11)', () => {
  const pair = generateDeviceKeyPair();
  const nonce = newChallengeNonce();
  const timestamp = new Date().toISOString();

  it('signs and verifies the canonical digest', () => {
    const signature = signChallenge(pair.privateKeyPem, nonce, 'dev_1', timestamp, '0.1.0');
    expect(verifyChallengeSignature(pair.publicKeyPem, signature, nonce, 'dev_1', timestamp, '0.1.0')).toBe(true);
  });

  it('rejects tampered inputs (deviceId, timestamp, nonce, version)', () => {
    const signature = signChallenge(pair.privateKeyPem, nonce, 'dev_1', timestamp, '0.1.0');
    expect(verifyChallengeSignature(pair.publicKeyPem, signature, nonce, 'dev_2', timestamp, '0.1.0')).toBe(false);
    expect(verifyChallengeSignature(pair.publicKeyPem, signature, newChallengeNonce(), 'dev_1', timestamp, '0.1.0')).toBe(false);
    expect(
      verifyChallengeSignature(pair.publicKeyPem, signature, nonce, 'dev_1', new Date(0).toISOString(), '0.1.0'),
    ).toBe(false);
    expect(verifyChallengeSignature(pair.publicKeyPem, signature, nonce, 'dev_1', timestamp, '9.9.9')).toBe(false);
  });

  it('rejects signatures from a different key', () => {
    const other = generateDeviceKeyPair();
    const signature = signChallenge(other.privateKeyPem, nonce, 'dev_1', timestamp, '0.1.0');
    expect(verifyChallengeSignature(pair.publicKeyPem, signature, nonce, 'dev_1', timestamp, '0.1.0')).toBe(false);
  });

  it('digest layout is deterministic', () => {
    const a = challengeDigest(nonce, 'dev_1', timestamp, '0.1.0');
    const b = challengeDigest(nonce, 'dev_1', timestamp, '0.1.0');
    expect(a.equals(b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('enforces ±60s timestamp skew (§11.5)', () => {
    expect(timestampWithinSkew(new Date().toISOString())).toBe(true);
    expect(timestampWithinSkew(new Date(Date.now() - 61_000).toISOString())).toBe(false);
    expect(timestampWithinSkew(new Date(Date.now() + 61_000).toISOString())).toBe(false);
    expect(timestampWithinSkew('not-a-date')).toBe(false);
  });

  it('fingerprints are stable per key', () => {
    expect(publicKeyFingerprint(pair.publicKeyPem)).toBe(publicKeyFingerprint(pair.publicKeyPem));
    expect(publicKeyFingerprint(pair.publicKeyPem)).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
  });
});

describe('pairing tokens (§11.2)', () => {
  it('hashes match only the original token', () => {
    const token = generatePairingToken();
    const hash = hashPairingToken(token);
    expect(pairingTokenMatches(token, hash)).toBe(true);
    expect(pairingTokenMatches(generatePairingToken(), hash)).toBe(false);
  });
});
