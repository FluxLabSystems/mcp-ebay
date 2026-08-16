/**
 * Device private-key storage — SDD v0.5 §11.1. On Windows the Ed25519
 * private key is encrypted with DPAPI (CurrentUser) before touching disk;
 * only the public key can leave the PC. Non-Windows hosts are
 * development/test targets only and use a 0600 plain file with an explicit
 * marker.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KeyStore {
  save(privateKeyPem: string): void;
  load(): string | null;
  readonly kind: 'dpapi' | 'plainfile-dev';
}

const DPAPI_PROTECT = `
Add-Type -AssemblyName System.Security;
$bytes = [Convert]::FromBase64String($args[0]);
$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Convert]::ToBase64String($out)
`;

const DPAPI_UNPROTECT = `
Add-Type -AssemblyName System.Security;
$bytes = [Convert]::FromBase64String($args[0]);
$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);
[Convert]::ToBase64String($out)
`;

function runPowershell(script: string, argument: string): string {
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, argument],
    { encoding: 'utf8', windowsHide: true },
  );
  return stdout.trim();
}

export class DpapiKeyStore implements KeyStore {
  readonly kind = 'dpapi' as const;
  private readonly filePath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, 'device-key.dpapi');
  }

  save(privateKeyPem: string): void {
    const plainBase64 = Buffer.from(privateKeyPem, 'utf8').toString('base64');
    const protectedBase64 = runPowershell(DPAPI_PROTECT, plainBase64);
    writeFileSync(this.filePath, protectedBase64, 'utf8');
  }

  load(): string | null {
    if (!existsSync(this.filePath)) return null;
    const protectedBase64 = readFileSync(this.filePath, 'utf8').trim();
    const plainBase64 = runPowershell(DPAPI_UNPROTECT, protectedBase64);
    return Buffer.from(plainBase64, 'base64').toString('utf8');
  }
}

export class PlainFileKeyStore implements KeyStore {
  readonly kind = 'plainfile-dev' as const;
  private readonly filePath: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, 'device-key.dev.pem');
  }

  save(privateKeyPem: string): void {
    writeFileSync(this.filePath, privateKeyPem, { encoding: 'utf8', mode: 0o600 });
    chmodSync(this.filePath, 0o600);
  }

  load(): string | null {
    if (!existsSync(this.filePath)) return null;
    return readFileSync(this.filePath, 'utf8');
  }
}

export function createKeyStore(stateDir: string, platform: NodeJS.Platform = process.platform): KeyStore {
  return platform === 'win32' ? new DpapiKeyStore(stateDir) : new PlainFileKeyStore(stateDir);
}
