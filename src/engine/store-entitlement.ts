import type { Transaction } from 'kysely';

import { mapStoreEventForDomain } from '../db/mappers.js';
import { upsertStoreSourceEntitlement } from '../db/repositories/source-entitlements.js';
import { insertStoreEventOnce, selectStoreEventsForUser } from '../db/repositories/store-events.js';
import type { Database, SourceEntitlement } from '../db/schema.js';
import { acquireUserEntitlementLock, getTransactionNow } from '../db/transactions.js';
import type { ProductId, StoreEventType } from '../domain/types.js';
import type { CanonicalEntitlementState } from './canonical.js';
import { recomputeCanonicalAndSyncNotifications } from './recompute.js';
import { reduceStoreEvents } from './reducer.js';

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
    }
  | {
      status: 'duplicate';
    };

/**
 * What: Persist a store webhook and update all derived entitlement state.
 * Why: Raw-event idempotency plus full replay lets duplicate, late, or out-of-order
 * delivery converge without trusting arrival order.
 */
export async function applyStoreEvent(
  trx: Transaction<Database>,
  event: StoreEventInput,
): Promise<ApplyStoreEventResult> {
  const insertedEvent = await insertStoreEventOnce(trx, event);
  if (insertedEvent === undefined) {
    return { status: 'duplicate' };
  }

  const transactionNow = await getTransactionNow(trx);
  await acquireUserEntitlementLock(trx, event.userId);

  await recomputeStoreSource(trx, event.userId);
  const canonicalRow = await recomputeCanonicalAndSyncNotifications(
    trx,
    event.userId,
    transactionNow,
  );

  return {
    status: 'applied',
    canonicalRow,
  };
}

/**
 * What: Rebuild the STORE source row from raw store events.
 * Why: Replaying the full timeline makes the source projection recoverable and stable
 * after late webhooks or prior failed attempts.
 */
export async function recomputeStoreSource(
  trx: Transaction<Database>,
  userId: string,
): Promise<SourceEntitlement> {
  await acquireUserEntitlementLock(trx, userId);

  const eventRows = await selectStoreEventsForUser(trx, userId);
  // Replaying all raw events makes late or out-of-order webhooks converge to
  // the same projection as if they had arrived in business-time order.
  const projection = reduceStoreEvents(eventRows.map((row) => mapStoreEventForDomain(row)));
  const lastChangedAt = projection.lastChangedAt;
  const lastEventMs = projection.lastEventMs;
  const lastEventId = projection.lastEventId;

  if (lastChangedAt === null || lastEventMs === null || lastEventId === null) {
    throw new Error(`Cannot recompute STORE source without store events for user ${userId}`);
  }

  return upsertStoreSourceEntitlement(trx, {
    userId,
    active: projection.active,
    expiresAt: projection.expiresAt,
    lastChangedAt,
    reason: projection.reason,
    lastEventMs,
    lastEventId,
  });
}
