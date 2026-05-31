import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

export interface AppConfig {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  appHost: string;
  appPort: number;
  carrierBaseUrl: string;
  carrierHttpTimeoutMs: number;
}

export interface MockCarrierConfig {
  nodeEnv: NodeEnv;
  mockCarrierHost: string;
  mockCarrierPort: number;
}

type Env = NodeJS.ProcessEnv;

export function readConfig(env: Env = process.env): AppConfig {
  return {
    nodeEnv: parseNodeEnv(readRequired(env, 'NODE_ENV')),
    databaseUrl: parsePostgresUrl(readRequired(env, 'DATABASE_URL'), 'DATABASE_URL'),
    appHost: readRequired(env, 'APP_HOST'),
    appPort: parsePort(readRequired(env, 'APP_PORT'), 'APP_PORT'),
    carrierBaseUrl: parseHttpUrl(readRequired(env, 'CARRIER_BASE_URL'), 'CARRIER_BASE_URL'),
    carrierHttpTimeoutMs: parsePositiveInteger(
      env.CARRIER_HTTP_TIMEOUT_MS ?? '3000',
      'CARRIER_HTTP_TIMEOUT_MS',
    ),
  };
}

export function readMockCarrierConfig(env: Env = process.env): MockCarrierConfig {
  return {
    nodeEnv: parseNodeEnv(readRequired(env, 'NODE_ENV')),
    mockCarrierHost: readRequired(env, 'MOCK_CARRIER_HOST'),
    mockCarrierPort: parsePort(readRequired(env, 'MOCK_CARRIER_PORT'), 'MOCK_CARRIER_PORT'),
  };
}

function readRequired(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseNodeEnv(value: string): NodeEnv {
  if (NODE_ENVS.includes(value as NodeEnv)) {
    return value as NodeEnv;
  }

  throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
}

function parsePort(value: string, name: string): number {
  const parsed = parsePositiveInteger(value, name);
  if (parsed > 65535) {
    throw new Error(`${name} must be less than or equal to 65535`);
  }

  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }

  return parsed;
}

function parseHttpUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }

  return trimTrailingSlash(url.toString());
}

function parsePostgresUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a Postgres connection string`);
  }

  return url.toString();
}

function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
