import { randomUUID } from 'node:crypto';

import type { FastifyBaseLogger } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';

import type { CarrierClient, CarrierPlanStatus } from '../clients/carrier.js';
import type { Database } from '../db/types.js';
import {
  acquireUserEntitlementLock,
  getTransactionNow,
  recomputeCanonical,
} from '../engine/entitlement.js';
import { syncExpiryNotification } from '../engine/notifications.js';

const CARRIER_POLL_BATCH_SIZE = 50;
const CARRIER_POLL_CONCURRENCY = 10;

type CarrierPollOutcome = CarrierPlanStatus;
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

export async function runCarrierPoller(
  options: RunCarrierPollerOptions,
): Promise<CarrierPollerRunResult> {
  const workerId = options.workerId ?? randomUUID();
  const claimedUserIds = await claimCarrierPollLocks(options.db, workerId);
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

async function claimCarrierPollLocks(db: Kysely<Database>, workerId: string): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await ensureMissingCarrierPollLocks(trx);

    const claimedRows = await sql<{ user_id: string }>`
      select l.user_id
      from carrier_poll_locks l
      join source_entitlements s
        on s.user_id = l.user_id
       and s.source = 'CARRIER'
      where s.active = true
        and (s.expires_at is null or s.expires_at > now())
        and l.next_poll_at <= now()
        and (l.lease_until is null or l.lease_until < now())
      for update of l skip locked
      limit ${CARRIER_POLL_BATCH_SIZE}
    `.execute(trx);

    const userIds = claimedRows.rows.map((row) => row.user_id);
    if (userIds.length === 0) {
      return userIds;
    }

    await trx
      .updateTable('carrier_poll_locks')
      .set({
        lease_until: sql<Date>`now() + interval '10 minutes'`,
        locked_by: workerId,
      })
      .where('user_id', 'in', userIds)
      .execute();

    return userIds;
  });
}

async function ensureMissingCarrierPollLocks(trx: Transaction<Database>): Promise<void> {
  await sql`
    insert into carrier_poll_locks (
      user_id,
      next_poll_at,
      lease_until,
      locked_by,
      last_polled_at
    )
    select
      user_id,
      now(),
      null,
      null,
      null
    from source_entitlements
    where source = 'CARRIER'
      and active = true
      and (expires_at is null or expires_at > now())
    on conflict (user_id) do nothing
  `.execute(trx);
}

interface PollClaimedUserInput {
  db: Kysely<Database>;
  carrierClient: CarrierClient;
  workerId: string;
  userId: string;
  logger?: CarrierPollerLogger;
}

async function pollClaimedUser(input: PollClaimedUserInput): Promise<CarrierPollOutcome> {
  let shouldReleaseLease = true;
  let outcome: CarrierPollOutcome = 'api_error';

  try {
    const plan = await input.carrierClient.getPlan(input.userId);
    outcome = plan.status;

    if (plan.status === 'inactive') {
      const deactivated = await deactivateCarrierSource(input.db, input.userId, input.workerId);
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

async function deactivateCarrierSource(
  db: Kysely<Database>,
  userId: string,
  workerId: string,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await acquireUserEntitlementLock(trx, userId);

    const ownedLock = await sql<{ user_id: string }>`
      select user_id
      from carrier_poll_locks
      where user_id = ${userId}
        and locked_by = ${workerId}
      for update
    `.execute(trx);
    if (ownedLock.rows[0] === undefined) {
      return false;
    }

    const transactionNow = await getTransactionNow(trx);
    const changedRows = await trx
      .updateTable('source_entitlements')
      .set({
        active: false,
        expires_at: null,
        last_changed_at: transactionNow,
        reason: 'CARRIER_INACTIVE',
      })
      .where('user_id', '=', userId)
      .where('source', '=', 'CARRIER')
      .where('active', '=', true)
      .returning('user_id')
      .execute();

    if (changedRows.length > 0) {
      const canonicalRow = await recomputeCanonical(trx, userId, transactionNow);
      await syncExpiryNotification(trx, canonicalRow, transactionNow);
    }

    await trx
      .deleteFrom('carrier_poll_locks')
      .where('user_id', '=', userId)
      .where('locked_by', '=', workerId)
      .execute();

    return true;
  });
}

async function advanceAndReleaseCarrierPollLock(
  db: Kysely<Database>,
  userId: string,
  workerId: string,
): Promise<void> {
  await db
    .updateTable('carrier_poll_locks')
    .set({
      next_poll_at: sql<Date>`now() + interval '5 minutes'`,
      lease_until: null,
      locked_by: null,
      last_polled_at: sql<Date>`now()`,
    })
    .where('user_id', '=', userId)
    .where('locked_by', '=', workerId)
    .execute();
}

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
