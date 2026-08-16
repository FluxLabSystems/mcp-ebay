/**
 * Device identity lifecycle — SDD v0.5 §11. Keypair on first run;
 * deviceId assigned by the gateway at pairing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateDeviceKeyPair, publicKeyFingerprint } from '@browser-bridge/protocol';
import { createKeyStore, type KeyStore } from './keystore.js';

export interface DeviceIdentity {
  deviceId: string | null;
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  keyStoreKind: KeyStore['kind'];
}

interface PublicState {
  deviceId: string | null;
  publicKeyPem: string;
}

export class IdentityStore {
  private readonly stateDir: string;
  private readonly keyStore: KeyStore;
  private readonly publicStatePath: string;

  constructor(stateDir: string, platform: NodeJS.Platform = process.platform) {
    this.stateDir = stateDir;
    this.keyStore = createKeyStore(stateDir, platform);
    this.publicStatePath = join(stateDir, 'device.json');
  }

  loadOrCreate(): DeviceIdentity {
    mkdirSync(this.stateDir, { recursive: true });
    let privateKeyPem = this.keyStore.load();
    let publicState: PublicState | null = null;
    if (existsSync(this.publicStatePath)) {
      try {
        publicState = JSON.parse(readFileSync(this.publicStatePath, 'utf8')) as PublicState;
      } catch {
        publicState = null;
      }
    }
    let publicKeyPem = publicState?.publicKeyPem ?? null;
    if (privateKeyPem === null || publicKeyPem === null) {
      const pair = generateDeviceKeyPair();
      privateKeyPem = pair.privateKeyPem;
      publicKeyPem = pair.publicKeyPem;
      this.keyStore.save(privateKeyPem);
      publicState = { deviceId: null, publicKeyPem };
      this.writePublicState(publicState);
    }
    return {
      deviceId: publicState?.deviceId ?? null,
      publicKeyPem,
      privateKeyPem,
      fingerprint: publicKeyFingerprint(publicKeyPem),
      keyStoreKind: this.keyStore.kind,
    };
  }

  saveDeviceId(deviceId: string): void {
    const identity = this.loadOrCreate();
    this.writePublicState({ deviceId, publicKeyPem: identity.publicKeyPem });
  }

  private writePublicState(state: PublicState): void {
    writeFileSync(this.publicStatePath, JSON.stringify(state, null, 2), 'utf8');
  }
}
