import { type Kysely, sql, type Transaction } from 'kysely';

import { CARRIER_POLL_INTERVAL_MS, CARRIER_POLL_LEASE_MS } from '../../domain/constants.js';
import type { Database } from '../schema.js';

/**
 * What: Create the carrier poll state for active carrier users.
 * Why: Active CARRIER grants must be discoverable by the poller immediately, and
 * existing poll rows should keep their lease/schedule.
 */
export async function ensureCarrierPollLock(
  trx: Transaction<Database>,
  userId: string,
  transactionNow: Date,
): Promise<void> {
  await trx
    .insertInto('carrier_poll_locks')
    .values({
      user_id: userId,
      next_poll_at: transactionNow,
      lease_until: null,
      locked_by: null,
      last_polled_at: null,
    })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();
}

/**
 * What: Backfill carrier poll locks for active carrier grants.
 * Why: Seeded or repaired source rows should become pollable even if their lock row
 * was never created.
 */
export async function ensureMissingCarrierPollLocks(trx: Transaction<Database>): Promise<void> {
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

/**
 * What: Claim due carrier poll locks for this worker.
 * Why: Row locks and leases let many poller instances share work without polling the
 * same user at the same time.
 */
export async function claimDueCarrierPollLocks(
  db: Kysely<Database>,
  workerId: string,
  batchSize: number,
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    await ensureMissingCarrierPollLocks(trx);

    // SKIP LOCKED lets another worker keep its in-flight claims while this worker
    // moves on to a different due row.
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
      limit ${batchSize}
    `.execute(trx);

    const userIds = claimedRows.rows.map((row) => row.user_id);
    if (userIds.length === 0) {
      return userIds;
    }

    await trx
      .updateTable('carrier_poll_locks')
      .set({
        lease_until: sql<Date>`now() + ${CARRIER_POLL_LEASE_MS} * interval '1 millisecond'`,
        locked_by: workerId,
      })
      .where('user_id', 'in', userIds)
      .execute();

    return userIds;
  });
}

/**
 * What: Check whether this worker still owns a carrier poll lock under row lock.
 * Why: Carrier responses arrive after the claim transaction, so mutation code must
 * prove the lease was not cleared or stolen meanwhile.
 */
export async function selectOwnedCarrierPollLockForUpdate(
  trx: Transaction<Database>,
  userId: string,
  workerId: string,
): Promise<boolean> {
  const ownedLock = await sql<{ user_id: string }>`
    select user_id
    from carrier_poll_locks
    where user_id = ${userId}
      and locked_by = ${workerId}
    for update
  `.execute(trx);

  return ownedLock.rows[0] !== undefined;
}

/**
 * What: Delete a carrier poll lock still owned by this worker.
 * Why: Confirmed inactive carrier users should leave the poll cadence entirely.
 */
export async function deleteOwnedCarrierPollLock(
  trx: Transaction<Database>,
  userId: string,
  workerId: string,
): Promise<void> {
  await trx
    .deleteFrom('carrier_poll_locks')
    .where('user_id', '=', userId)
    .where('locked_by', '=', workerId)
    .execute();
}

/**
 * What: Move a carrier poll lock to its next due time and clear the lease.
 * Why: Active or retryable users should be polled again later without staying owned by
 * this worker.
 */
export async function advanceAndReleaseCarrierPollLock(
  db: Kysely<Database>,
  userId: string,
  workerId: string,
): Promise<void> {
  await db
    .updateTable('carrier_poll_locks')
    .set({
      next_poll_at: sql<Date>`now() + ${CARRIER_POLL_INTERVAL_MS} * interval '1 millisecond'`,
      lease_until: null,
      locked_by: null,
      last_polled_at: sql<Date>`now()`,
    })
    .where('user_id', '=', userId)
    .where('locked_by', '=', workerId)
    .execute();
}
