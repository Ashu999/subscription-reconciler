import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import {
  type DueNotificationCandidate,
  deleteUnsentNotification,
  markNotificationSent,
  selectDueNotificationCandidates,
  selectDueNotificationForUpdate,
} from '../db/repositories/notifications.js';
import type { Database } from '../db/schema.js';
import { getTransactionNow, tryAcquireUserEntitlementLock } from '../db/transactions.js';
import { NOTIFICATION_WORKER_BATCH_SIZE } from '../domain/constants.js';
import type { CanonicalEntitlementState } from '../engine/canonical.js';
import { recomputeCanonicalAndSyncNotifications } from '../engine/recompute.js';

type NotificationWorkerLogger = Pick<FastifyBaseLogger, 'debug'>;

type DueNotificationProcessResult = 'sent' | 'deleted_stale' | 'skipped_busy' | 'claim_missed';

export interface RunNotificationWorkerOptions {
  db: Kysely<Database>;
  logger?: NotificationWorkerLogger;
}

export interface NotificationWorkerRunResult {
  candidateCount: number;
  sentCount: number;
  deletedStaleCount: number;
  skippedBusyCount: number;
  claimMissedCount: number;
}

/**
 * What: Process due expiry notifications and mark the current ones as sent.
 * Why: Notification delivery is represented by sent_at, and stale reminders must be
 * deleted when entitlement state changed after scheduling.
 */
export async function runNotificationWorker(
  options: RunNotificationWorkerOptions,
): Promise<NotificationWorkerRunResult> {
  const candidates = await selectDueNotificationCandidates(
    options.db,
    NOTIFICATION_WORKER_BATCH_SIZE,
  );
  const result: NotificationWorkerRunResult = {
    candidateCount: candidates.length,
    sentCount: 0,
    deletedStaleCount: 0,
    skippedBusyCount: 0,
    claimMissedCount: 0,
  };

  for (const candidate of candidates) {
    const processResult = await processDueNotification(options.db, candidate);
    switch (processResult) {
      case 'sent':
        result.sentCount += 1;
        break;
      case 'deleted_stale':
        result.deletedStaleCount += 1;
        break;
      case 'skipped_busy':
        result.skippedBusyCount += 1;
        break;
      case 'claim_missed':
        result.claimMissedCount += 1;
        break;
    }
  }

  options.logger?.debug(result, 'notification worker run complete');
  return result;
}

/**
 * What: Validate and process one due notification inside a transaction.
 * Why: Recomputing canonical state before marking sent prevents old reminders from
 * firing after access was renewed, revoked, or already expired.
 */
async function processDueNotification(
  db: Kysely<Database>,
  candidate: DueNotificationCandidate,
): Promise<DueNotificationProcessResult> {
  return db.transaction().execute(async (trx) => {
    const locked = await tryAcquireUserEntitlementLock(trx, candidate.user_id);
    if (!locked) {
      // Another request or job owns this user's entitlement state; the next worker
      // pass can try this notification again.
      return 'skipped_busy';
    }

    const transactionNow = await getTransactionNow(trx);
    const canonicalRow = await recomputeCanonicalAndSyncNotifications(
      trx,
      candidate.user_id,
      transactionNow,
    );

    const notification = await selectDueNotificationForUpdate(trx, candidate.id);
    if (notification === undefined) {
      // syncExpiryNotification may have deleted or replaced the row before we could
      // lock it, so classify the miss by comparing the original candidate to state.
      return isNotificationCurrent(candidate.expires_at, canonicalRow, transactionNow)
        ? 'claim_missed'
        : 'deleted_stale';
    }

    if (isNotificationCurrent(notification.expires_at, canonicalRow, transactionNow)) {
      await markNotificationSent(trx, notification.id, transactionNow);

      return 'sent';
    }

    await deleteUnsentNotification(trx, notification.id);

    return 'deleted_stale';
  });
}

/**
 * What: Check whether a notification still matches current canonical expiry.
 * Why: Only active, unexpired access with the same expiry instant should produce an
 * expiring-soon send.
 */
function isNotificationCurrent(
  notificationExpiresAt: Date,
  canonicalRow: CanonicalEntitlementState,
  transactionNow: Date,
): boolean {
  return (
    canonicalRow.active &&
    canonicalRow.expiresAt !== null &&
    canonicalRow.expiresAt.getTime() === notificationExpiresAt.getTime() &&
    canonicalRow.expiresAt > transactionNow
  );
}
