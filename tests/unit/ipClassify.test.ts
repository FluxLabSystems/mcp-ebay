import { describe, expect, it } from 'vitest';
import { classifyIpLiteral, isProhibitedAddress } from '@browser-bridge/policy';

describe('IP classification (§19.1)', () => {
  const prohibited = [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.10',
    '64:ff9b::7f00:1',
  ];
  const publicAddresses = ['8.8.8.8', '99.79.1.1', '172.32.0.1', '100.128.0.1', '2607:f8b0::1', '::ffff:8.8.8.8'];

  it.each(prohibited)('prohibits %s', (address) => {
    expect(classifyIpLiteral(address)).toBe('prohibited');
    expect(isProhibitedAddress(address)).toBe(true);
  });

  it.each(publicAddresses)('allows public %s', (address) => {
    expect(classifyIpLiteral(address)).toBe('public');
  });

  it('treats non-IP input as prohibited when asked directly', () => {
    expect(classifyIpLiteral('example.com')).toBeNull();
    expect(isProhibitedAddress('example.com')).toBe(true);
  });
});
