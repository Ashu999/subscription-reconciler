import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../src/config.js';
import type { Database } from '../../src/db/schema.js';
import { startCronJobs } from '../../src/jobs/index.js';

const scheduledTasks = vi.hoisted(() => [] as ScheduledTaskStub[]);

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(
      (expression: string, runner: () => Promise<unknown>, options: { name: string }) => {
        const task = {
          expression,
          options,
          runner,
          stop: vi.fn().mockResolvedValue(undefined),
        };
        scheduledTasks.push(task);
        return task;
      },
    ),
  },
}));

interface ScheduledTaskStub {
  expression: string;
  options: {
    name: string;
    noOverlap?: boolean;
  };
  runner: () => Promise<unknown>;
  stop: ReturnType<typeof vi.fn>;
}

describe('background job scheduling', () => {
  beforeEach(() => {
    scheduledTasks.length = 0;
  });

  it('registers the required recurring jobs with the expected cadence', () => {
    startCronJobs({
      db: {} as Kysely<Database>,
      config: testConfig(),
      logger: { error: vi.fn() } as unknown as FastifyBaseLogger,
    });

    expect(
      scheduledTasks.map((task) => ({
        name: task.options.name,
        expression: task.expression,
        noOverlap: task.options.noOverlap,
      })),
    ).toEqual([
      { name: 'carrier-poller', expression: '*/5 * * * *', noOverlap: true },
      { name: 'notification-worker', expression: '* * * * *', noOverlap: true },
      { name: 'notification-scheduler', expression: '* * * * *', noOverlap: true },
      { name: 'expiry-reconciler', expression: '* * * * *', noOverlap: true },
    ]);
  });

  it('stops every registered cron task', async () => {
    const jobs = startCronJobs({
      db: {} as Kysely<Database>,
      config: testConfig(),
      logger: { error: vi.fn() } as unknown as FastifyBaseLogger,
    });

    await jobs.stop();

    for (const task of scheduledTasks) {
      expect(task.stop).toHaveBeenCalledTimes(1);
    }
  });
});

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    databaseUrl: 'postgres://app:app@localhost:5432/subscription_reconciler',
    appHost: '127.0.0.1',
    appPort: 0,
    carrierBaseUrl: 'http://localhost:3001',
    carrierHttpTimeoutMs: 3000,
  };
}
