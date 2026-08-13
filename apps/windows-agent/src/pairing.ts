/**
 * Device pairing — SDD v0.5 §11.3. The agent presents the one-time token,
 * its public key, name, and version over HTTPS; the gateway consumes the
 * token and returns an opaque deviceId.
 */
import { AGENT_VERSION } from './version.js';

export interface PairResult {
  deviceId: string;
}

export async function pairDevice(
  gatewayHttpUrl: string,
  pairingToken: string,
  publicKeyPem: string,
  deviceName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PairResult> {
  const response = await fetchImpl(`${gatewayHttpUrl}/agent/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairingToken,
      publicKeyPem,
      deviceName,
      agentVersion: AGENT_VERSION,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Pairing failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { deviceId?: string };
  if (typeof payload.deviceId !== 'string' || payload.deviceId.length === 0) {
    throw new Error('Pairing response did not include a deviceId');
  }
  return { deviceId: payload.deviceId };
}
