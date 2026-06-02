import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const REQUIRED_ENV_VARS = [
  'NODE_ENV',
  'DATABASE_URL',
  'APP_HOST',
  'APP_PORT',
  'CARRIER_BASE_URL',
  'MOCK_CARRIER_HOST',
  'MOCK_CARRIER_PORT',
  'CARRIER_HTTP_TIMEOUT_MS',
] as const;

describe('runtime setup contract', () => {
  it('keeps .env.example aligned with the documented runtime variables', async () => {
    const envExample = await readText('.env.example');
    const keys = new Set(
      envExample
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
        .map((line) => line.split('=')[0]),
    );

    for (const key of REQUIRED_ENV_VARS) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it('defines the required Docker Compose services and health dependencies', async () => {
    const compose = await readText('docker-compose.yml');

    expect(compose).toContain('  db:');
    expect(compose).toContain('  mock-carrier:');
    expect(compose).toContain('  app:');
    expect(compose).toContain('DATABASE_URL: postgres://app:app@db:5432/subscription_reconciler');
    expect(compose).toContain('CARRIER_BASE_URL: http://mock-carrier:3001');
    expect(compose).toContain('mock-carrier:');
    expect(compose).toContain('condition: service_healthy');
  });

  it('pins the Node runtime and exposes the single-command lifecycle scripts', async () => {
    const packageJson = JSON.parse(await readText('package.json')) as {
      engines?: { node?: string };
      scripts?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe('24.16.0');
    expect(packageJson.scripts?.start).toBe('node dist/server.js');
    expect(packageJson.scripts?.seed).toBe('tsx scripts/seed.ts');
    expect(packageJson.scripts?.test).toBe('vitest run');
  });
});

function readText(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}
