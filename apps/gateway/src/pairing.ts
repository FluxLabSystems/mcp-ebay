/**
 * Device pairing endpoint — SDD v0.5 §11.2/§11.3. One-time tokens are
 * stored as SHA-256 hashes, consumed atomically, and expire after 10
 * minutes. The response returns the opaque deviceId.
 */
import { createPublicKey } from 'node:crypto';
import * as z from 'zod/v4';
import { hashPairingToken, newDeviceId, publicKeyFingerprint } from '@browser-bridge/protocol';
import type { Logger } from 'pino';
import type { Store } from './store/types.js';

const PairRequestSchema = z.strictObject({
  pairingToken: z.string().min(16).max(128),
  publicKeyPem: z.string().min(32).max(4096),
  deviceName: z.string().min(1).max(120),
  agentVersion: z.string().min(1).max(64),
});

export async function handlePairRequest(request: Request, store: Store, logger: Logger): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = PairRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'invalid pairing request' }, { status: 400 });
  }
  const { pairingToken, publicKeyPem, deviceName, agentVersion } = parsed.data;

  // Validate the submitted key is a real Ed25519 public key.
  let fingerprint: string;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') {
      return Response.json({ error: 'public key must be Ed25519' }, { status: 400 });
    }
    fingerprint = publicKeyFingerprint(publicKeyPem);
  } catch {
    return Response.json({ error: 'unparseable public key' }, { status: 400 });
  }

  const consumed = await store.pairingTokens.consume(hashPairingToken(pairingToken), new Date());
  if (consumed === null) {
    logger.warn({ deviceName }, 'Pairing rejected: invalid/expired/used token');
    return Response.json({ error: 'invalid, expired, or already-used pairing token' }, { status: 401 });
  }

  const deviceId = newDeviceId();
  await store.devices.insert({
    deviceId,
    name: consumed.requestedName ?? deviceName,
    publicKeyEd25519: Buffer.from(publicKeyPem, 'utf8'),
    keyFingerprint: fingerprint,
    status: 'active',
    agentVersion,
    pairedAt: new Date(),
    lastSeenAt: null,
  });
  logger.info({ deviceId, deviceName }, 'Device paired');
  return Response.json({ deviceId });
}
