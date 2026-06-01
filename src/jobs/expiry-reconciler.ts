import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import { selectExpiredCanonicalUserIds } from '../db/repositories/canonical-entitlements.js';
import type { Database } from '../db/schema.js';
import { EXPIRY_RECONCILER_BATCH_SIZE } from '../domain/constants.js';
import { recomputeCanonicalForCandidate } from './entitlement-sync.js';

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

/**
 * What: Recompute canonical rows that look active but have passed their expiry.
 * Why: Expiration is time-driven, so a background pass closes rows even when no webhook
 * arrives exactly at the expiry timestamp.
 */
export async function runExpiryReconciler(
  options: RunExpiryReconcilerOptions,
): Promise<ExpiryReconcilerRunResult> {
  const candidateUserIds = await selectExpiredCanonicalUserIds(
    options.db,
    EXPIRY_RECONCILER_BATCH_SIZE,
  );
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

/**
 * What: Recompute one expired canonical row if the user is not busy.
 * Why: The job should avoid waiting behind request-time mutations and let the next run
 * retry skipped users.
 */
async function reconcileExpiredCanonical(
  db: Kysely<Database>,
  userId: string,
): Promise<'reconciled' | 'skipped_busy'> {
  return recomputeCanonicalForCandidate(db, userId, 'reconciled');
}
