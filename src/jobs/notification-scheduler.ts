import type { FastifyBaseLogger } from 'fastify';
import { type Kysely, sql } from 'kysely';

import type { Database } from '../db/types.js';
import {
  getTransactionNow,
  recomputeCanonical,
  tryAcquireUserEntitlementLock,
} from '../engine/entitlement.js';
import { syncExpiryNotification } from '../engine/notifications.js';

const NOTIFICATION_SCHEDULER_BATCH_SIZE = 100;

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

export async function runNotificationScheduler(
  options: RunNotificationSchedulerOptions,
): Promise<NotificationSchedulerRunResult> {
  const candidateUserIds = await selectNotificationCandidateUserIds(options.db);
  const result: NotificationSchedulerRunResult = {
    candidateCount: candidateUserIds.length,
    syncedCount: 0,
    skippedBusyCount: 0,
  };

  for (const userId of candidateUserIds) {
    const syncResult = await syncNotificationCandidate(options.db, userId);
    if (syncResult === 'synced') {
      result.syncedCount += 1;
    } else {
      result.skippedBusyCount += 1;
    }
  }

  options.logger?.debug(result, 'notification scheduler run complete');
  return result;
}

async function selectNotificationCandidateUserIds(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    select user_id
    from canonical_entitlements
    where active = true
      and expires_at is not null
      and expires_at > now()
      and expires_at <= now() + interval '24 hours'
    order by expires_at asc, user_id asc
    limit ${NOTIFICATION_SCHEDULER_BATCH_SIZE}
  `.execute(db);

  return rows.rows.map((row) => row.user_id);
}

async function syncNotificationCandidate(
  db: Kysely<Database>,
  userId: string,
): Promise<'synced' | 'skipped_busy'> {
  return db.transaction().execute(async (trx) => {
    const locked = await tryAcquireUserEntitlementLock(trx, userId);
    if (!locked) {
      return 'skipped_busy';
    }

    const transactionNow = await getTransactionNow(trx);
    const canonicalRow = await recomputeCanonical(trx, userId, transactionNow);
    await syncExpiryNotification(trx, canonicalRow, transactionNow);

    return 'synced';
  });
}
