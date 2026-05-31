import type { FastifyBaseLogger } from 'fastify';
import { type Kysely, sql } from 'kysely';

import type { Database } from '../db/types.js';
import {
  getTransactionNow,
  recomputeCanonical,
  tryAcquireUserEntitlementLock,
} from '../engine/entitlement.js';
import { syncExpiryNotification } from '../engine/notifications.js';

const EXPIRY_RECONCILER_BATCH_SIZE = 100;

type ExpiryReconcilerLogger = Pick<FastifyBaseLogger, 'debug'>;

export interface RunExpiryReconcilerOptions {
  db: Kysely<Database>;
  logger?: ExpiryReconcilerLogger;
}

export interface ExpiryReconcilerRunResult {
  candidateCount: number;
  reconciledCount: number;
  skippedBusyCount: number;
}

export async function runExpiryReconciler(
  options: RunExpiryReconcilerOptions,
): Promise<ExpiryReconcilerRunResult> {
  const candidateUserIds = await selectExpiredCanonicalUserIds(options.db);
  const result: ExpiryReconcilerRunResult = {
    candidateCount: candidateUserIds.length,
    reconciledCount: 0,
    skippedBusyCount: 0,
  };

  for (const userId of candidateUserIds) {
    const reconcileResult = await reconcileExpiredCanonical(options.db, userId);
    if (reconcileResult === 'reconciled') {
      result.reconciledCount += 1;
    } else {
      result.skippedBusyCount += 1;
    }
  }

  options.logger?.debug(result, 'expiry reconciler run complete');
  return result;
}

async function selectExpiredCanonicalUserIds(db: Kysely<Database>): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    select user_id
    from canonical_entitlements
    where active = true
      and expires_at is not null
      and expires_at <= now()
    order by expires_at asc, user_id asc
    limit ${EXPIRY_RECONCILER_BATCH_SIZE}
  `.execute(db);

  return rows.rows.map((row) => row.user_id);
}

async function reconcileExpiredCanonical(
  db: Kysely<Database>,
  userId: string,
): Promise<'reconciled' | 'skipped_busy'> {
  return db.transaction().execute(async (trx) => {
    const locked = await tryAcquireUserEntitlementLock(trx, userId);
    if (!locked) {
      return 'skipped_busy';
    }

    const transactionNow = await getTransactionNow(trx);
    const canonicalRow = await recomputeCanonical(trx, userId, transactionNow);
    await syncExpiryNotification(trx, canonicalRow, transactionNow);

    return 'reconciled';
  });
}
