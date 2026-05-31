import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import cron, { type ScheduledTask } from 'node-cron';

import { HttpCarrierClient } from '../clients/carrier.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/types.js';
import { runCarrierPoller } from './carrier-poller.js';
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
    schedulePlaceholder('*/5 * * * *', 'expiry-reconciler', context),
  ];

  return {
    async stop() {
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
}

function scheduleNotificationScheduler(context: JobContext): ScheduledTask {
  return cron.schedule(
    '* * * * *',
    async () => {
      try {
        await runNotificationScheduler({
          db: context.db,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.error({ err: error, job: 'notification-scheduler' }, 'job failed');
      }
    },
    { name: 'notification-scheduler', noOverlap: true },
  );
}

function scheduleNotificationWorker(context: JobContext): ScheduledTask {
  return cron.schedule(
    '* * * * *',
    async () => {
      try {
        await runNotificationWorker({
          db: context.db,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.error({ err: error, job: 'notification-worker' }, 'job failed');
      }
    },
    { name: 'notification-worker', noOverlap: true },
  );
}

function scheduleCarrierPoller(
  context: JobContext,
  carrierClient: HttpCarrierClient,
  workerId: string,
): ScheduledTask {
  return cron.schedule(
    '*/5 * * * *',
    async () => {
      try {
        await runCarrierPoller({
          db: context.db,
          carrierClient,
          workerId,
          logger: context.logger,
        });
      } catch (error) {
        context.logger.error({ err: error, job: 'carrier-poller' }, 'job failed');
      }
    },
    { name: 'carrier-poller', noOverlap: true },
  );
}

function schedulePlaceholder(expression: string, name: string, context: JobContext): ScheduledTask {
  return cron.schedule(
    expression,
    () => {
      context.logger.debug(
        { job: name, carrierBaseUrl: context.config.carrierBaseUrl },
        'job tick',
      );
    },
    { name, noOverlap: true },
  );
}
