import type {
  CanonicalEntitlementForDomain,
  SourceEntitlementForDomain,
  StoreEventForDomain,
} from '../domain/types.js';
import { parseDbBigIntAsSafeEpochMs } from './scalars.js';
import type { CanonicalEntitlement, SourceEntitlement, StoreEvent } from './schema.js';

/**
 * What: Convert a source entitlement row into the camelCase domain shape.
 * Why: Engine code should operate on business names rather than leaking SQL column
 * naming across the codebase.
 */
export function mapSourceEntitlementForDomain(row: SourceEntitlement): SourceEntitlementForDomain {
  return {
    userId: row.user_id,
    source: row.source,
    active: row.active,
    expiresAt: row.expires_at,
    lastChangedAt: row.last_changed_at,
    reason: row.reason,
  };
}

/**
 * What: Convert a canonical entitlement row into the domain shape.
 * Why: Serialization and engine callers should share one mapping from database columns
 * to API-facing field names.
 */
export function mapCanonicalEntitlementForDomain(
  row: CanonicalEntitlement,
): CanonicalEntitlementForDomain {
  return {
    userId: row.user_id,
    active: row.active,
    source: row.source,
    expiresAt: row.expires_at,
    lastChangedAt: row.last_changed_at,
    reason: row.reason,
  };
}

/**
 * What: Convert a stored webhook event into reducer input.
 * Why: The reducer needs a safe numeric epoch time, while Postgres stores event time
 * in a bigint column for range and precision.
 */
export function mapStoreEventForDomain(row: StoreEvent): StoreEventForDomain {
  return {
    eventId: row.event_id,
    userId: row.user_id,
    type: row.type,
    eventTimeMs: parseDbBigIntAsSafeEpochMs(row.event_time_ms, 'store_events.event_time_ms'),
    productId: row.product_id,
    receivedAt: row.received_at,
  };
}
