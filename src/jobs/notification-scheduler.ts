import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import { selectCanonicalUserIdsExpiringWithin } from '../db/repositories/canonical-entitlements.js';
import type { Database } from '../db/schema.js';
import { EXPIRING_SOON_WINDOW_MS, NOTIFICATION_SCHEDULER_BATCH_SIZE } from '../domain/constants.js';
import { recomputeCanonicalForCandidate } from './entitlement-sync.js';

type NotificationSchedulerLogger = Pick<FastifyBaseLogger, 'debug'>;

export interface RunNotificationSchedulerOptions {
  db: Kysely<Database>;
  logger?: NotificationSchedulerLogger;
}

export interface NotificationSchedulerRunResult {
  candidateCount: number;
  syncedCount: number;
  skippedBusyCount: number;
}

/**
 * What: Ensure soon-expiring canonical entitlements have pending reminders.
 * Why: Notification rows are derived from canonical state and may need resyncing after
 * late events, renewals, or missed scheduler runs.
 */
export async function runNotificationScheduler(
  options: RunNotificationSchedulerOptions,
): Promise<NotificationSchedulerRunResult> {
  const candidateUserIds = await selectCanonicalUserIdsExpiringWithin(
    options.db,
    NOTIFICATION_SCHEDULER_BATCH_SIZE,
    EXPIRING_SOON_WINDOW_MS,
  );
  const result: NotificationSchedulerRunResult = {
    candidateCount: candidateUserIds.length,
    syncedCount: 0,
    skippedBusyCount: 0,
  };

  for (const userId of candidateUserIds) {
    const syncResult = await recomputeCanonicalForCandidate(options.db, userId, 'synced');
    if (syncResult === 'synced') {
      result.syncedCount += 1;
    } else {
      result.skippedBusyCount += 1;
    }
  }

  options.logger?.debug(result, 'notification scheduler run complete');
  return result;
}
