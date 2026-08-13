import { defineConfig } from 'vitest/config';

const baseTest = {
  environment: 'node' as const,
  globals: false,
  hookTimeout: 60_000,
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...baseTest,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        test: {
          ...baseTest,
          name: 'contract',
          include: ['tests/contract/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          ...baseTest,
          name: 'security',
          include: ['tests/security/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        test: {
          ...baseTest,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 120_000,
        },
      },
      {
        test: {
          ...baseTest,
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 180_000,
        },
      },
      {
        test: {
          ...baseTest,
          name: 'live',
          include: ['tests/live/**/*.test.ts'],
          testTimeout: 300_000,
        },
      },
    ],
  },
});
