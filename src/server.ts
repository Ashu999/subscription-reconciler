import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createDb } from './db/factory.js';
import { runMigrations } from './db/migrations/runner.js';
import { startCronJobs } from './jobs/index.js';

/**
 * What: Start the service process from configuration through HTTP and jobs.
 * Why: Startup owns the lifecycle boundary, so migrations, app creation, cron jobs,
 * and cleanup all stay in one place.
 */
async function main(): Promise<void> {
  const config = readConfig();
  const db = createDb(config.databaseUrl);

  try {
    // Migrations run before the socket opens so live traffic never sees a missing
    // table or index during process startup.
    await runMigrations(db);
    const app = await buildApp(db, config);
    await app.listen({ host: config.appHost, port: config.appPort });

    const jobs = startCronJobs({ db, config, logger: app.log });

    // Shutdown order stops background writes before closing HTTP and database
    // resources, which keeps in-flight job cleanup predictable.
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

// Let the top-level handler report startup failures without hiding the original
// error stack from the process logs.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
