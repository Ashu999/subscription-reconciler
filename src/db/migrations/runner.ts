import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import { readConfig } from '../../config.js';
import { createDb } from '../factory.js';
import type { Database } from '../types.js';
import * as initialMigration from './001_init.js';

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

async function importMigration(modulePath: string) {
  const fileName = path.basename(modulePath);
  if (fileName === '001_init.ts' || fileName === '001_init.js') {
    return initialMigration;
  }

  return import(pathToFileURL(modulePath).href);
}

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

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
