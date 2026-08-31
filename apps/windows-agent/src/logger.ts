/**
 * Structured JSON logging — SDD v0.5 §26. Secret values, cookies,
 * Authorization headers, pairing tokens, private keys, and screenshot
 * bytes are never logged.
 */
import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Where serialized lines go. Default is stdout; the console dashboard
 * (tui.ts) supplies a destination that tees each line into the rotating
 * NDJSON file and the on-screen tail. Redaction runs before serialization,
 * so every destination sees the same censored line.
 */
export interface LogDestination {
  write(line: string): void;
}

export function createLogger(level: string, name: string, destination?: LogDestination): Logger {
  const options: LoggerOptions = {
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
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}

export type { Logger };
