import cron, { type ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import type { AppConfig } from '../config.js';
import type { Database } from '../db/types.js';

export interface JobContext {
  db: Kysely<Database>;
  config: AppConfig;
  logger: FastifyBaseLogger;
}

export interface RunningJobs {
  stop(): Promise<void>;
}

export function startCronJobs(context: JobContext): RunningJobs {
  const tasks = [
    schedulePlaceholder('*/5 * * * *', 'carrier-poller', context),
    schedulePlaceholder('* * * * *', 'notification-worker', context),
    schedulePlaceholder('*/5 * * * *', 'notification-scheduler', context),
    schedulePlaceholder('*/5 * * * *', 'expiry-reconciler', context),
  ];

  return {
    async stop() {
      await Promise.all(tasks.map((task) => task.stop()));
    },
  };
}

function schedulePlaceholder(
  expression: string,
  name: string,
  context: JobContext,
): ScheduledTask {
  return cron.schedule(
    expression,
    () => {
      context.logger.debug({ job: name, carrierBaseUrl: context.config.carrierBaseUrl }, 'job tick');
    },
    { name, noOverlap: true },
  );
}
