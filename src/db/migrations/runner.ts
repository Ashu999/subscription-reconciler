import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { readConfig } from '../../config.js';
import { createDb } from '../factory.js';
import type { Database } from '../schema.js';
import * as initialMigration from './001_init.js';

/**
 * What: Apply all pending Kysely migrations to the target database.
 * Why: App startup and CLI usage should share the same migration path and logging.
 */
export async function runMigrations(db: Kysely<Database>): Promise<void> {
  const migrationFolder = path.dirname(fileURLToPath(import.meta.url));
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder,
      import: importMigration,
      onFileIgnored(fileName, reason) {
        if (!fileName.startsWith('runner.') && !fileName.endsWith('.map')) {
          console.warn(`Ignored migration file ${fileName}: ${reason}`);
        }
      },
    }),
  });

  // Kysely reports per-migration results separately from the aggregate error, so
  // log useful progress before rethrowing any failure.
  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === 'Success') {
      console.info(`Migration ${result.migrationName} applied`);
    } else if (result.status === 'Error') {
      console.error(`Migration ${result.migrationName} failed`);
    }
  }

  if (error !== undefined) {
    throw error;
  }
}

/**
 * What: Load a migration module from disk or from the bundled TS import.
 * Why: The runner must work both under tsx in development and from compiled JS in
 * production containers.
 */
async function importMigration(modulePath: string) {
  const fileName = path.basename(modulePath);
  if (fileName === '001_init.ts' || fileName === '001_init.js') {
    return initialMigration;
  }

  return import(pathToFileURL(modulePath).href);
}

// Allow this module to be imported by app startup or executed directly as the
// migration CLI entrypoint.
if (isMainModule()) {
  const config = readConfig();
  const db = createDb(config.databaseUrl);

  runMigrations(db)
    .finally(() => db.destroy())
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

/**
 * What: Detect whether this file is the current Node entrypoint.
 * Why: ES modules do not have require.main, so direct execution needs URL comparison.
 */
function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
