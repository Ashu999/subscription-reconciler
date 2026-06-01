import type { Kysely } from 'kysely';

import type { Database } from '../db/schema.js';
import { tryAcquireUserEntitlementLock } from '../db/transactions.js';
import { recomputeCanonicalAndSyncNotifications } from '../engine/recompute.js';

export type BusyUserResult<TSuccess extends string> = TSuccess | 'skipped_busy';

/**
 * What: Recompute one candidate user's canonical state without waiting for busy locks.
 * Why: Background jobs should make batch progress and let later runs retry users that
 * are already being changed by a request or another worker.
 */
export async function recomputeCanonicalForCandidate<TSuccess extends string>(
  db: Kysely<Database>,
  userId: string,
  successStatus: TSuccess,
): Promise<BusyUserResult<TSuccess>> {
  return db.transaction().execute(async (trx) => {
    const locked = await tryAcquireUserEntitlementLock(trx, userId);
    if (!locked) {
      return 'skipped_busy';
    }

    await recomputeCanonicalAndSyncNotifications(trx, userId);

    return successStatus;
  });
}
