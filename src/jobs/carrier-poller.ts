import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import type { CarrierClient, CarrierPlanStatus } from '../clients/carrier.js';
import {
  advanceAndReleaseCarrierPollLock,
  claimDueCarrierPollLocks,
  deleteOwnedCarrierPollLock,
  selectOwnedCarrierPollLockForUpdate,
} from '../db/repositories/carrier-poll-locks.js';
import { deactivateActiveCarrierSource } from '../db/repositories/source-entitlements.js';
import type { Database } from '../db/schema.js';
import { acquireUserEntitlementLock, getTransactionNow } from '../db/transactions.js';
import { CARRIER_POLL_BATCH_SIZE, CARRIER_POLL_CONCURRENCY } from '../domain/constants.js';
import { recomputeCanonicalAndSyncNotifications } from '../engine/recompute.js';

type CarrierPollerLogger = Pick<FastifyBaseLogger, 'debug' | 'error' | 'warn'>;

export interface RunCarrierPollerOptions {
  db: Kysely<Database>;
  carrierClient: CarrierClient;
  workerId?: string;
  logger?: CarrierPollerLogger;
}

export interface CarrierPollerRunResult {
  workerId: string;
  claimedCount: number;
  activeCount: number;
  inactiveCount: number;
  apiErrorCount: number;
  failedCount: number;
}

/**
 * What: Poll a bounded batch of active carrier entitlements.
 * Why: Carrier does not push updates, so workers must periodically discover inactive
 * plans while coordinating safely across multiple service instances.
 */
export async function runCarrierPoller(
  options: RunCarrierPollerOptions,
): Promise<CarrierPollerRunResult> {
  const workerId = options.workerId ?? randomUUID();
  const claimedUserIds = await claimDueCarrierPollLocks(
    options.db,
    workerId,
    CARRIER_POLL_BATCH_SIZE,
  );
  const settledResults = await settleWithConcurrency(
    claimedUserIds,
    CARRIER_POLL_CONCURRENCY,
    async (userId) => ({
      userId,
      outcome: await pollClaimedUser({
        db: options.db,
        carrierClient: options.carrierClient,
        workerId,
        userId,
        logger: options.logger,
      }),
    }),
  );

  const result: CarrierPollerRunResult = {
    workerId,
    claimedCount: claimedUserIds.length,
    activeCount: 0,
    inactiveCount: 0,
    apiErrorCount: 0,
    failedCount: 0,
  };

  // Promise.allSettled keeps one failing user from hiding the rest of the batch's
  // outcomes or leaving summary counts incomplete.
  for (const settledResult of settledResults) {
    if (settledResult.status === 'rejected') {
      result.failedCount += 1;
      options.logger?.error({ err: settledResult.reason, workerId }, 'carrier poll user failed');
      continue;
    }

    if (settledResult.value.outcome === 'active') {
      result.activeCount += 1;
    } else if (settledResult.value.outcome === 'inactive') {
      result.inactiveCount += 1;
    } else {
      result.apiErrorCount += 1;
    }
  }

  options.logger?.debug(result, 'carrier poller run complete');
  return result;
}

interface PollClaimedUserInput {
  db: Kysely<Database>;
  carrierClient: CarrierClient;
  workerId: string;
  userId: string;
  logger?: CarrierPollerLogger;
}

/**
 * What: Poll one claimed user and update carrier source state when needed.
 * Why: Active or uncertain responses only advance the schedule, while confirmed
 * inactive responses must revoke CARRIER access and recompute derived rows.
 */
async function pollClaimedUser(input: PollClaimedUserInput): Promise<CarrierPlanStatus> {
  let shouldReleaseLease = true;
  let outcome: CarrierPlanStatus = 'api_error';

  try {
    const plan = await input.carrierClient.getPlan(input.userId);
    outcome = plan.status;

    if (plan.status === 'inactive') {
      const deactivated = await deactivateCarrierSource(input.db, input.userId, input.workerId);
      // A successful deactivation deletes the lock entirely; releasing it again would
      // re-create poll cadence for a user who no longer has CARRIER access.
      shouldReleaseLease = !deactivated;
      if (deactivated) {
        return 'inactive';
      }

      outcome = 'api_error';
      return outcome;
    }

    if (plan.status === 'api_error') {
      input.logger?.warn(
        { workerId: input.workerId, userId: input.userId },
        'carrier returned api_error status',
      );
    }

    return plan.status;
  } catch (error) {
    input.logger?.warn(
      { err: error, workerId: input.workerId, userId: input.userId },
      'carrier client threw while polling user',
    );
    outcome = 'api_error';
    return outcome;
  } finally {
    if (shouldReleaseLease) {
      await advanceAndReleaseCarrierPollLock(input.db, input.userId, input.workerId);
    }
  }
}

/**
 * What: Deactivate a user's CARRIER source when this worker still owns the claim.
 * Why: The carrier lock and user entitlement lock together prevent stale poll results
 * from overwriting fresher entitlement changes.
 */
async function deactivateCarrierSource(
  db: Kysely<Database>,
  userId: string,
  workerId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await acquireUserEntitlementLock(trx, userId);

    // Re-check ownership inside the mutation transaction because the poll happened
    // outside this transaction and the lease may have been stolen or cleared.
    const ownsLock = await selectOwnedCarrierPollLockForUpdate(trx, userId, workerId);
    if (!ownsLock) {
      return false;
    }

    const transactionNow = await getTransactionNow(trx);
    const changed = await deactivateActiveCarrierSource(trx, userId, transactionNow);

    if (changed) {
      await recomputeCanonicalAndSyncNotifications(trx, userId, transactionNow);
    }

    await deleteOwnedCarrierPollLock(trx, userId, workerId);

    return true;
  });
}

/**
 * What: Run async work in fixed-size batches and keep every settled result.
 * Why: Polling should limit carrier/API pressure while still reporting rejected users
 * separately from carrier api_error statuses.
 */
async function settleWithConcurrency<T, TResult>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<TResult>,
): Promise<PromiseSettledResult<TResult>[]> {
  const results: PromiseSettledResult<TResult>[] = [];

  for (let offset = 0; offset < items.length; offset += concurrency) {
    const batch = items.slice(offset, offset + concurrency);
    results.push(...(await Promise.allSettled(batch.map((item) => worker(item)))));
  }

  return results;
}
