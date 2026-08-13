/**
 * Structured JSON logging — SDD v0.5 §26. Secret values, cookies,
 * Authorization headers, pairing tokens, private keys, and screenshot
 * bytes are never logged.
 */
import { pino, type Logger } from 'pino';

export function createLogger(level: string, name: string): Logger {
  return pino({
    name,
    level,
    redact: {
      paths: [
        'authorization',
        '*.authorization',
        'headers.authorization',
        'token',
        '*.token',
        'pairingToken',
        '*.pairingToken',
        'privateKey',
        '*.privateKey',
        'privateKeyPem',
        '*.privateKeyPem',
        'artifactToken',
        '*.artifactToken',
        'dataBase64',
        '*.dataBase64',
        'value',
        'arguments.value',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type { Logger };
