import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import cron, { type ScheduledTask } from 'node-cron';

import { HttpCarrierClient } from '../clients/carrier.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/schema.js';
import { runCarrierPoller } from './carrier-poller.js';
import { runExpiryReconciler } from './expiry-reconciler.js';
import { runNotificationScheduler } from './notification-scheduler.js';
import { runNotificationWorker } from './notification-worker.js';

export interface JobContext {
  db: Kysely<Database>;
  config: AppConfig;
  logger: FastifyBaseLogger;
}

export interface RunningJobs {
  stop(): Promise<void>;
}

type JobRunner = () => Promise<unknown>;

/**
 * What: Start all recurring background jobs for the service process.
 * Why: Jobs share app configuration, logging, and database access, and the caller needs
 * one handle to stop them during shutdown.
 */
export function startCronJobs(context: JobContext): RunningJobs {
  const carrierClient = new HttpCarrierClient({
    baseUrl: context.config.carrierBaseUrl,
    timeoutMs: context.config.carrierHttpTimeoutMs,
  });
  const carrierWorkerId = randomUUID();
  const tasks = [
    scheduleCarrierPoller(context, carrierClient, carrierWorkerId),
    scheduleNotificationWorker(context),
    scheduleNotificationScheduler(context),
    scheduleExpiryReconciler(context),
  ];

  return {
    async stop() {
      // Stop every cron task before the server destroys the shared database pool.
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
}

/**
 * What: Schedule the time-based expiry reconciler every minute.
 * Why: Expired canonical rows should be corrected soon even without new source events.
 */
function scheduleExpiryReconciler(context: JobContext): ScheduledTask {
  return scheduleJob(context, 'expiry-reconciler', '* * * * *', () =>
    runExpiryReconciler({
      db: context.db,
      logger: context.logger,
    }),
  );
}

/**
 * What: Schedule reminder synchronization every minute.
 * Why: Soon-expiring entitlements need notification rows created or refreshed promptly.
 */
function scheduleNotificationScheduler(context: JobContext): ScheduledTask {
  return scheduleJob(context, 'notification-scheduler', '* * * * *', () =>
    runNotificationScheduler({
      db: context.db,
      logger: context.logger,
    }),
  );
}

/**
 * What: Schedule due notification processing every minute.
 * Why: Notification rows become "sent" only when this worker reaches their scheduled
 * time and verifies they are still current.
 */
function scheduleNotificationWorker(context: JobContext): ScheduledTask {
  return scheduleJob(context, 'notification-worker', '* * * * *', () =>
    runNotificationWorker({
      db: context.db,
      logger: context.logger,
    }),
  );
}

/**
 * What: Schedule carrier polling every five minutes with a stable worker id.
 * Why: Carrier state is external, and the lease owner id is used to prove the worker
 * still owns a claim before mutating source state.
 */
function scheduleCarrierPoller(
  context: JobContext,
  carrierClient: HttpCarrierClient,
  workerId: string,
): ScheduledTask {
  return scheduleJob(context, 'carrier-poller', '*/5 * * * *', () =>
    runCarrierPoller({
      db: context.db,
      carrierClient,
      workerId,
      logger: context.logger,
    }),
  );
}

/**
 * What: Schedule a cron job with standard error logging and overlap prevention.
 * Why: Job-specific scheduling should define cadence and work, not repeat wrapper
 * behavior for every task.
 */
function scheduleJob(
  context: JobContext,
  name: string,
  expression: string,
  runner: JobRunner,
): ScheduledTask {
  return cron.schedule(
    expression,
    async () => {
      try {
        await runner();
      } catch (error) {
        context.logger.error({ err: error, job: name }, 'job failed');
      }
    },
    { name, noOverlap: true },
  );
}
