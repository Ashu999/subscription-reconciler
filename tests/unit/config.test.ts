import { describe, expect, it } from 'vitest';

import { readConfig, readMockCarrierConfig } from '../../src/config.js';

describe('configuration parsing', () => {
  it('reads and normalizes the app configuration contract', () => {
    expect(readConfig(baseAppEnv())).toEqual({
      nodeEnv: 'development',
      databaseUrl: 'postgres://app:app@localhost:5432/subscription_reconciler',
      appHost: '0.0.0.0',
      appPort: 3000,
      carrierBaseUrl: 'http://localhost:3001',
      carrierHttpTimeoutMs: 3000,
    });
  });

  it('uses the default carrier timeout when it is omitted', () => {
    const { CARRIER_HTTP_TIMEOUT_MS: _timeout, ...env } = baseAppEnv();

    expect(readConfig(env).carrierHttpTimeoutMs).toBe(3000);
  });

  it('fails fast for malformed app environment values', () => {
    const cases: Array<{ name: string; env: NodeJS.ProcessEnv; error: RegExp }> = [
      {
        name: 'missing database URL',
        env: omit(baseAppEnv(), 'DATABASE_URL'),
        error: /Missing required environment variable: DATABASE_URL/,
      },
      {
        name: 'invalid NODE_ENV',
        env: { ...baseAppEnv(), NODE_ENV: 'staging' },
        error: /NODE_ENV must be one of/,
      },
      {
        name: 'non-postgres database URL',
        env: { ...baseAppEnv(), DATABASE_URL: 'mysql://localhost/app' },
        error: /DATABASE_URL must be a Postgres connection string/,
      },
      {
        name: 'non-http carrier URL',
        env: { ...baseAppEnv(), CARRIER_BASE_URL: 'ftp://carrier.example' },
        error: /CARRIER_BASE_URL must be an HTTP\(S\) URL/,
      },
      {
        name: 'invalid app port',
        env: { ...baseAppEnv(), APP_PORT: '65536' },
        error: /APP_PORT must be less than or equal to 65535/,
      },
      {
        name: 'invalid timeout',
        env: { ...baseAppEnv(), CARRIER_HTTP_TIMEOUT_MS: '0' },
        error: /CARRIER_HTTP_TIMEOUT_MS must be a positive safe integer/,
      },
    ];

    for (const currentCase of cases) {
      expect(() => readConfig(currentCase.env), currentCase.name).toThrow(currentCase.error);
    }
  });

  it('reads and validates the mock carrier configuration contract', () => {
    expect(
      readMockCarrierConfig({
        NODE_ENV: 'test',
        MOCK_CARRIER_HOST: '127.0.0.1',
        MOCK_CARRIER_PORT: '3001',
      }),
    ).toEqual({
      nodeEnv: 'test',
      mockCarrierHost: '127.0.0.1',
      mockCarrierPort: 3001,
    });

    expect(() =>
      readMockCarrierConfig({
        NODE_ENV: 'test',
        MOCK_CARRIER_HOST: '127.0.0.1',
        MOCK_CARRIER_PORT: '-1',
      }),
    ).toThrow(/MOCK_CARRIER_PORT must be a positive integer/);
  });
});

function baseAppEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://app:app@localhost:5432/subscription_reconciler',
    APP_HOST: '0.0.0.0',
    APP_PORT: '3000',
    CARRIER_BASE_URL: 'http://localhost:3001/',
    CARRIER_HTTP_TIMEOUT_MS: '3000',
  };
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}
