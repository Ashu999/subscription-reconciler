import type { FastifyBaseLogger } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';

import type { Database } from '../db/types.js';
import type { CanonicalEntitlementState } from '../engine/canonical.js';
import {
  getTransactionNow,
  recomputeCanonical,
  tryAcquireUserEntitlementLock,
} from '../engine/entitlement.js';
import { syncExpiryNotification } from '../engine/notifications.js';

const NOTIFICATION_WORKER_BATCH_SIZE = 100;

type NotificationWorkerLogger = Pick<FastifyBaseLogger, 'debug'>;

interface DueNotificationCandidate {
  id: string;
  user_id: string;
  expires_at: Date;
}

type LockedDueNotification = DueNotificationCandidate;

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

export async function runNotificationWorker(
  options: RunNotificationWorkerOptions,
): Promise<NotificationWorkerRunResult> {
  const candidates = await selectDueNotificationCandidates(options.db);
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

async function selectDueNotificationCandidates(
  db: Kysely<Database>,
): Promise<DueNotificationCandidate[]> {
  const rows = await sql<DueNotificationCandidate>`
    select id, user_id, expires_at
    from notifications
    where scheduled_for <= now()
      and sent_at is null
    order by scheduled_for asc, id asc
    limit ${NOTIFICATION_WORKER_BATCH_SIZE}
  `.execute(db);

  return rows.rows;
}

async function processDueNotification(
  db: Kysely<Database>,
  candidate: DueNotificationCandidate,
): Promise<DueNotificationProcessResult> {
  return db.transaction().execute(async (trx) => {
    const locked = await tryAcquireUserEntitlementLock(trx, candidate.user_id);
    if (!locked) {
      return 'skipped_busy';
    }

    const transactionNow = await getTransactionNow(trx);
    const canonicalRow = await recomputeCanonical(trx, candidate.user_id, transactionNow);
    await syncExpiryNotification(trx, canonicalRow, transactionNow);

    const notification = await selectDueNotificationForUpdate(trx, candidate.id);
    if (notification === undefined) {
      return isNotificationCurrent(candidate.expires_at, canonicalRow, transactionNow)
        ? 'claim_missed'
        : 'deleted_stale';
    }

    if (isNotificationCurrent(notification.expires_at, canonicalRow, transactionNow)) {
      await trx
        .updateTable('notifications')
        .set({ sent_at: transactionNow })
        .where('id', '=', notification.id)
        .where('sent_at', 'is', null)
        .execute();

      return 'sent';
    }

    await trx
      .deleteFrom('notifications')
      .where('id', '=', notification.id)
      .where('sent_at', 'is', null)
      .execute();

    return 'deleted_stale';
  });
}

async function selectDueNotificationForUpdate(
  trx: Transaction<Database>,
  notificationId: string,
): Promise<LockedDueNotification | undefined> {
  const rows = await sql<LockedDueNotification>`
    select id, user_id, expires_at
    from notifications
    where id = ${notificationId}
      and sent_at is null
    for update skip locked
  `.execute(trx);

  return rows.rows[0];
}

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
