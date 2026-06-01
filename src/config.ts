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

/**
 * What: Read and validate configuration for the main API service.
 * Why: Failing fast on malformed environment values prevents partially started
 * processes from running with unusable network or database settings.
 */
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

/**
 * What: Read and validate configuration for the mock carrier service.
 * Why: The mock runs as a separate process, so it needs its own host and port while
 * sharing the same environment validation rules.
 */
export function readMockCarrierConfig(env: Env = process.env): MockCarrierConfig {
  return {
    nodeEnv: parseNodeEnv(readRequired(env, 'NODE_ENV')),
    mockCarrierHost: readRequired(env, 'MOCK_CARRIER_HOST'),
    mockCarrierPort: parsePort(readRequired(env, 'MOCK_CARRIER_PORT'), 'MOCK_CARRIER_PORT'),
  };
}

/**
 * What: Fetch a required environment variable as a non-empty string.
 * Why: Later parsers should only deal with shape validation, not missing values.
 */
function readRequired(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/**
 * What: Restrict NODE_ENV to the supported runtime modes.
 * Why: Logger behavior and test setup depend on predictable environment names.
 */
function parseNodeEnv(value: string): NodeEnv {
  if (NODE_ENVS.includes(value as NodeEnv)) {
    return value as NodeEnv;
  }

  throw new Error(`NODE_ENV must be one of: ${NODE_ENVS.join(', ')}`);
}

/**
 * What: Parse a TCP port from an environment variable.
 * Why: Ports must be positive integers inside the valid network port range.
 */
function parsePort(value: string, name: string): number {
  const parsed = parsePositiveInteger(value, name);
  if (parsed > 65535) {
    throw new Error(`${name} must be less than or equal to 65535`);
  }

  return parsed;
}

/**
 * What: Parse a string as a positive safe integer.
 * Why: Timeouts and ports should reject floats, negatives, and values JavaScript cannot
 * represent exactly.
 */
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

/**
 * What: Parse and normalize an HTTP(S) base URL.
 * Why: Carrier client URL construction should not depend on whether env values include
 * a trailing slash.
 */
function parseHttpUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an HTTP(S) URL`);
  }

  return trimTrailingSlash(url.toString());
}

/**
 * What: Parse a Postgres connection string.
 * Why: The DB factory expects a database URL, not an arbitrary URI or plain hostname.
 */
function parsePostgresUrl(value: string, name: string): string {
  const url = parseUrl(value, name);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a Postgres connection string`);
  }

  return url.toString();
}

/**
 * What: Convert a string into a URL object with a named error.
 * Why: Higher-level parsers can attach environment variable names to validation
 * failures instead of leaking generic URL exceptions.
 */
function parseUrl(value: string, name: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
}

/**
 * What: Remove one trailing slash from a URL string.
 * Why: Callers compose path segments themselves, so normalized bases avoid accidental
 * double slashes.
 */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
