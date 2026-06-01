import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './schema.js';

const { Pool } = pg;

/**
 * What: Create the typed Kysely database client for Postgres.
 * Why: Keeping DB construction centralized gives the app, scripts, and tests the same
 * dialect configuration and schema typing.
 */
export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
      }),
    }),
  });
}
