/**
 * Device pairing & challenge-response primitives — SDD v0.5 §11.
 *
 * Canonical challenge byte layout (both sides MUST use exactly this):
 *   digest = SHA-256( nonceBytes || utf8(deviceId) || utf8(timestamp) || utf8(agentVersion) )
 * where nonceBytes are the raw 32 bytes the gateway generated (transported
 * base64), timestamp is the RFC3339 string the agent places in device.hello,
 * and the Ed25519 signature is computed over the 32-byte digest.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  timingSafeEqual,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

export const CHALLENGE_NONCE_BYTES = 32;
export const MAX_TIMESTAMP_SKEW_SECONDS = 60;
export const PAIRING_TOKEN_TTL_SECONDS = 600;
export const ARTIFACT_TOKEN_TTL_SECONDS = 900;

export function generateDeviceKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Fingerprint = sha256 over the SPKI DER encoding, base64url, prefixed. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const key = createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
  return `ed25519:${createHash('sha256').update(der).digest('base64url')}`;
}

export function newChallengeNonce(): Buffer {
  return randomBytes(CHALLENGE_NONCE_BYTES);
}

export function challengeDigest(
  nonce: Buffer,
  deviceId: string,
  timestamp: string,
  agentVersion: string,
): Buffer {
  return createHash('sha256')
    .update(nonce)
    .update(Buffer.from(deviceId, 'utf8'))
    .update(Buffer.from(timestamp, 'utf8'))
    .update(Buffer.from(agentVersion, 'utf8'))
    .digest();
}

export function signChallenge(
  privateKeyPem: string | KeyObject,
  nonce: Buffer,
  deviceId: string,
  timestamp: string,
  agentVersion: string,
): string {
  const key = typeof privateKeyPem === 'string' ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const digest = challengeDigest(nonce, deviceId, timestamp, agentVersion);
  return edSign(null, digest, key).toString('base64');
}

export function verifyChallengeSignature(
  publicKeyPem: string | KeyObject,
  signatureBase64: string,
  nonce: Buffer,
  deviceId: string,
  timestamp: string,
  agentVersion: string,
): boolean {
  const key = typeof publicKeyPem === 'string' ? createPublicKey(publicKeyPem) : publicKeyPem;
  const digest = challengeDigest(nonce, deviceId, timestamp, agentVersion);
  try {
    return edVerify(null, digest, key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** True when |now - timestamp| is within the permitted skew (§11.5). */
export function timestampWithinSkew(timestamp: string, nowMs: number = Date.now()): boolean {
  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts)) return false;
  return Math.abs(nowMs - ts) <= MAX_TIMESTAMP_SKEW_SECONDS * 1000;
}

/** One-time pairing token: 24 random bytes, base64url (§11.2). */
export function generatePairingToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Pairing tokens are stored only as SHA-256 hashes (§11 hard rule). */
export function hashPairingToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function pairingTokenMatches(token: string, storedHash: Buffer): boolean {
  const hash = hashPairingToken(token);
  return hash.length === storedHash.length && timingSafeEqual(hash, storedHash);
}
