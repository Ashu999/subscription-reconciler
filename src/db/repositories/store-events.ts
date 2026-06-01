import type { Transaction } from 'kysely';

import type { ProductId, StoreEventType } from '../../domain/types.js';
import type { Database, NewStoreEvent, StoreEvent } from '../schema.js';

export interface StoreEventInsertInput {
  eventId: string;
  userId: string;
  type: StoreEventType;
  eventTimeMs: number;
  productId: ProductId;
  receivedAt?: Date;
}

/**
 * What: Store a raw webhook event once by event id.
 * Why: Duplicate webhook delivery should be acknowledged without replaying or changing
 * entitlement state a second time.
 */
export async function insertStoreEventOnce(
  trx: Transaction<Database>,
  event: StoreEventInsertInput,
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

/**
 * What: Read one user's store events in deterministic replay order.
 * Why: Source projection rebuilds need database ordering to match reducer ordering.
 */
export async function selectStoreEventsForUser(
  trx: Transaction<Database>,
  userId: string,
): Promise<StoreEvent[]> {
  return trx
    .selectFrom('store_events')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('event_time_ms', 'asc')
    .orderBy('event_id', 'asc')
    .execute();
}
