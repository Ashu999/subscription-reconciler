import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createDb } from './db/factory.js';
import { runMigrations } from './db/migrations/runner.js';
import { startCronJobs } from './jobs/index.js';

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDb(config.databaseUrl);

  try {
    await runMigrations(db);
    const app = await buildApp(db, config);
    await app.listen({ host: config.appHost, port: config.appPort });

    const jobs = startCronJobs({ db, config, logger: app.log });

    const shutdown = async (signal: NodeJS.Signals) => {
      app.log.info({ signal }, 'shutting down');
      await jobs.stop();
      await app.close();
      await db.destroy();
    };

    process.once('SIGINT', (signal) => {
      void shutdown(signal).catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
    });
    process.once('SIGTERM', (signal) => {
      void shutdown(signal).catch((error: unknown) => {
        app.log.error(error);
        process.exitCode = 1;
      });
    });
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
