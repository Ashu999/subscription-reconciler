import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';

import { buildApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { createDb } from '../../src/db/factory.js';
import { up as runInitialMigration } from '../../src/db/migrations/001_init.js';
import type { Database } from '../../src/db/types.js';

export interface IntegrationHarness {
  app: FastifyInstance;
  db: Kysely<Database>;
  resetDb: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function createIntegrationHarness(): Promise<IntegrationHarness> {
  const container = await new PostgreSqlContainer('postgres:18.4').start();
  const db = createDb(container.getConnectionUri());

  try {
    await runInitialMigration(db);
    const app = await buildApp(db, testConfig(container.getConnectionUri()));

    return {
      app,
      db,
      resetDb: () => resetDb(db),
      stop: async () => {
        await app.close();
        await db.destroy();
        await container.stop();
      },
    };
  } catch (error) {
    await db.destroy();
    await container.stop();
    throw error;
  }
}

async function resetDb(db: Kysely<Database>): Promise<void> {
  await sql`
    truncate table
      notifications,
      carrier_poll_locks,
      canonical_entitlements,
      source_entitlements,
      store_events
    restart identity
  `.execute(db);
}

function testConfig(databaseUrl: string): AppConfig {
  return {
    nodeEnv: 'test',
    databaseUrl,
    appHost: '127.0.0.1',
    appPort: 0,
    carrierBaseUrl: 'http://127.0.0.1:3001',
    carrierHttpTimeoutMs: 3_000,
  };
}
