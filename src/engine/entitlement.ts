import { sql, type Transaction } from 'kysely';

import type {
  Database,
  EntitlementReason,
  EntitlementSource,
  NewStoreEvent,
  ProductId,
  SourceEntitlement,
  StoreEvent,
  StoreEventType,
} from '../db/types.js';
import {
  mapSourceEntitlementForDomain,
  mapStoreEventForDomain,
} from '../db/types.js';
import { resolveCanonical, type CanonicalEntitlementState } from './canonical.js';
import { syncExpiryNotification } from './notifications.js';
import { reduceStoreEvents } from './reducer.js';

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

export interface StoreEventInput {
  eventId: string;
  userId: string;
  type: StoreEventType;
  eventTimeMs: number;
  productId: ProductId;
  receivedAt?: Date;
}

export type ApplyStoreEventResult =
  | {
      status: 'applied';
      canonicalRow: CanonicalEntitlementState;
      storeSourceRow: SourceEntitlement;
    }
  | {
      status: 'duplicate';
    };

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

export async function applyStoreEvent(
  trx: Transaction<Database>,
  event: StoreEventInput,
): Promise<ApplyStoreEventResult> {
  const insertedEvent = await insertRawStoreEvent(trx, event);
  if (insertedEvent === undefined) {
    return { status: 'duplicate' };
  }

  const transactionNow = await getTransactionNow(trx);
  await acquireUserEntitlementLock(trx, event.userId);

  const storeSourceRow = await recomputeStoreSource(trx, event.userId);
  const canonicalRow = await recomputeCanonical(trx, event.userId, transactionNow);
  await syncExpiryNotification(trx, canonicalRow, transactionNow);

  return {
    status: 'applied',
    canonicalRow,
    storeSourceRow,
  };
}

export async function recomputeStoreSource(
  trx: Transaction<Database>,
  userId: string,
): Promise<SourceEntitlement> {
  await acquireUserEntitlementLock(trx, userId);

  const eventRows = await trx
    .selectFrom('store_events')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('event_time_ms', 'asc')
    .orderBy('event_id', 'asc')
    .execute();
  const projection = reduceStoreEvents(eventRows.map((row) => mapStoreEventForDomain(row)));
  const lastChangedAt = projection.lastChangedAt;
  const lastEventMs = projection.lastEventMs;
  const lastEventId = projection.lastEventId;

  if (
    lastChangedAt === null ||
    lastEventMs === null ||
    lastEventId === null
  ) {
    throw new Error(`Cannot recompute STORE source without store events for user ${userId}`);
  }

  return trx
    .insertInto('source_entitlements')
    .values({
      user_id: userId,
      source: 'STORE',
      active: projection.active,
      expires_at: projection.expiresAt,
      last_changed_at: lastChangedAt,
      reason: projection.reason,
      last_event_ms: lastEventMs,
      last_event_id: lastEventId,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'source']).doUpdateSet({
        active: projection.active,
        expires_at: projection.expiresAt,
        last_changed_at: lastChangedAt,
        reason: projection.reason,
        last_event_ms: lastEventMs,
        last_event_id: lastEventId,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function recomputeCanonical(
  trx: Transaction<Database>,
  userId: string,
  transactionNow?: Date,
): Promise<CanonicalEntitlementState> {
  const now = transactionNow ?? (await getTransactionNow(trx));
  const sourceRows = await trx
    .selectFrom('source_entitlements')
    .selectAll()
    .where('user_id', '=', userId)
    .execute();
  const canonicalRow = resolveCanonical(
    sourceRows.map((row) => mapSourceEntitlementForDomain(row)),
    now,
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

async function insertRawStoreEvent(
  trx: Transaction<Database>,
  event: StoreEventInput,
): Promise<StoreEvent | undefined> {
  const newStoreEventBase = {
    event_id: event.eventId,
    user_id: event.userId,
    type: event.type,
    event_time_ms: event.eventTimeMs,
    product_id: event.productId,
  };
  const newStoreEvent: NewStoreEvent =
    event.receivedAt === undefined
      ? newStoreEventBase
      : { ...newStoreEventBase, received_at: event.receivedAt };

  return trx
    .insertInto('store_events')
    .values(newStoreEvent)
    .onConflict((oc) => oc.column('event_id').doNothing())
    .returningAll()
    .executeTakeFirst();
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
