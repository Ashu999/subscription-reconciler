import { sql, type Transaction } from 'kysely';

import type {
  Database,
  EntitlementReason,
  EntitlementSource,
  SourceEntitlement,
} from '../db/types.js';
import {
  resolveCanonical,
  toSourceEntitlementState,
  type CanonicalEntitlementState,
} from './canonical.js';
import { syncExpiryNotification } from './notifications.js';

export interface SeedSourceEntitlementInput {
  userId: string;
  source: Exclude<EntitlementSource, 'STORE'>;
  active: boolean;
  expiresAt: Date | null;
  reason: Extract<
    EntitlementReason,
    'CARRIER_ACTIVE' | 'CARRIER_INACTIVE' | 'MARKETPLACE_GRANT' | 'MARKETPLACE_REVOKE'
  >;
}

export async function acquireUserEntitlementLock(
  trx: Transaction<Database>,
  userId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`.execute(trx);
}

export async function tryAcquireUserEntitlementLock(
  trx: Transaction<Database>,
  userId: string,
): Promise<boolean> {
  const result = await sql<{ locked: boolean }>`
    select pg_try_advisory_xact_lock(hashtextextended(${userId}::text, 0)) as locked
  `.execute(trx);

  return result.rows[0]?.locked ?? false;
}

export async function getTransactionNow(trx: Transaction<Database>): Promise<Date> {
  const result = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const now = result.rows[0]?.now;
  if (now === undefined) {
    throw new Error('Postgres did not return transaction timestamp');
  }

  return now;
}

export async function upsertSeedSourceEntitlement(
  trx: Transaction<Database>,
  input: SeedSourceEntitlementInput,
  transactionNow: Date,
): Promise<CanonicalEntitlementState> {
  await acquireUserEntitlementLock(trx, input.userId);

  await upsertSourceEntitlement(trx, input, transactionNow);
  if (input.source === 'CARRIER' && input.active) {
    await ensureCarrierPollLock(trx, input.userId, transactionNow);
  }

  const canonicalRow = await recomputeCanonical(trx, input.userId, transactionNow);
  await syncExpiryNotification(trx, canonicalRow, transactionNow);

  return canonicalRow;
}

export async function recomputeCanonical(
  trx: Transaction<Database>,
  userId: string,
  transactionNow: Date,
): Promise<CanonicalEntitlementState> {
  const sourceRows = await trx
    .selectFrom('source_entitlements')
    .selectAll()
    .where('user_id', '=', userId)
    .execute();
  const canonicalRow = resolveCanonical(
    sourceRows.map((row) => toSourceEntitlementState(row)),
    transactionNow,
  );

  const rowWithUserId = canonicalRow.userId === '' ? { ...canonicalRow, userId } : canonicalRow;

  await trx
    .insertInto('canonical_entitlements')
    .values({
      user_id: rowWithUserId.userId,
      active: rowWithUserId.active,
      source: rowWithUserId.source,
      expires_at: rowWithUserId.expiresAt,
      last_changed_at: rowWithUserId.lastChangedAt,
      reason: rowWithUserId.reason,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        active: rowWithUserId.active,
        source: rowWithUserId.source,
        expires_at: rowWithUserId.expiresAt,
        last_changed_at: rowWithUserId.lastChangedAt,
        reason: rowWithUserId.reason,
      }),
    )
    .execute();

  return rowWithUserId;
}

async function upsertSourceEntitlement(
  trx: Transaction<Database>,
  input: SeedSourceEntitlementInput,
  transactionNow: Date,
): Promise<SourceEntitlement | undefined> {
  return trx
    .insertInto('source_entitlements')
    .values({
      user_id: input.userId,
      source: input.source,
      active: input.active,
      expires_at: input.expiresAt,
      last_changed_at: transactionNow,
      reason: input.reason,
      last_event_ms: null,
      last_event_id: null,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'source']).doUpdateSet({
        active: input.active,
        expires_at: input.expiresAt,
        last_changed_at: transactionNow,
        reason: input.reason,
        last_event_ms: null,
        last_event_id: null,
      }),
    )
    .returningAll()
    .executeTakeFirst();
}

async function ensureCarrierPollLock(
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
