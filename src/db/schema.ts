import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

import type {
  CanonicalEntitlementSource,
  EntitlementReason,
  EntitlementSource,
  NotificationType,
  ProductId,
  StoreEventType,
} from '../domain/types.js';

// Kysely column helpers describe different read/insert/update shapes so callers
// can pass strings from requests while domain code receives Date objects.
type TimestampColumn = ColumnType<Date, Date | string, Date | string>;
type NullableTimestampColumn = ColumnType<Date | null, Date | string | null, Date | string | null>;
type DefaultTimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;
type AuditTimestampColumn = ColumnType<Date, Date | string | undefined, never>;
// pg may surface bigint-like values as strings, so conversion happens explicitly
// before reducer code treats event times as JavaScript numbers.
type BigIntColumn = ColumnType<
  string | null,
  string | number | bigint | null,
  string | number | bigint | null
>;

export interface SourceEntitlementsTable {
  user_id: string;
  source: EntitlementSource;
  active: boolean;
  expires_at: NullableTimestampColumn;
  last_changed_at: TimestampColumn;
  reason: EntitlementReason;
  last_event_ms: BigIntColumn;
  last_event_id: string | null;
  created_at: AuditTimestampColumn;
  updated_at: AuditTimestampColumn;
}

export interface CanonicalEntitlementsTable {
  user_id: string;
  active: boolean;
  source: CanonicalEntitlementSource;
  expires_at: NullableTimestampColumn;
  last_changed_at: NullableTimestampColumn;
  reason: EntitlementReason;
  created_at: AuditTimestampColumn;
  updated_at: AuditTimestampColumn;
}

export interface StoreEventsTable {
  event_id: string;
  user_id: string;
  type: StoreEventType;
  event_time_ms: ColumnType<string, string | number | bigint, string | number | bigint>;
  product_id: ProductId;
  received_at: DefaultTimestampColumn;
}

export interface NotificationsTable {
  id: Generated<string>;
  user_id: string;
  type: NotificationType;
  expires_at: TimestampColumn;
  scheduled_for: TimestampColumn;
  sent_at: NullableTimestampColumn;
  created_at: AuditTimestampColumn;
  updated_at: AuditTimestampColumn;
}

export interface CarrierPollLocksTable {
  user_id: string;
  next_poll_at: TimestampColumn;
  lease_until: NullableTimestampColumn;
  locked_by: string | null;
  last_polled_at: NullableTimestampColumn;
}

/**
 * What: Declare the database tables available to Kysely.
 * Why: A single schema map gives all query builders compile-time table and column
 * names without duplicating database structure in each module.
 */
export interface Database {
  source_entitlements: SourceEntitlementsTable;
  canonical_entitlements: CanonicalEntitlementsTable;
  store_events: StoreEventsTable;
  notifications: NotificationsTable;
  carrier_poll_locks: CarrierPollLocksTable;
}

export type SourceEntitlement = Selectable<SourceEntitlementsTable>;
export type NewSourceEntitlement = Insertable<SourceEntitlementsTable>;
export type SourceEntitlementUpdate = Updateable<SourceEntitlementsTable>;

export type CanonicalEntitlement = Selectable<CanonicalEntitlementsTable>;
export type NewCanonicalEntitlement = Insertable<CanonicalEntitlementsTable>;
export type CanonicalEntitlementUpdate = Updateable<CanonicalEntitlementsTable>;

export type StoreEvent = Selectable<StoreEventsTable>;
export type NewStoreEvent = Insertable<StoreEventsTable>;
export type StoreEventUpdate = Updateable<StoreEventsTable>;

export type Notification = Selectable<NotificationsTable>;
export type NewNotification = Insertable<NotificationsTable>;
export type NotificationUpdate = Updateable<NotificationsTable>;

export type CarrierPollLock = Selectable<CarrierPollLocksTable>;
export type NewCarrierPollLock = Insertable<CarrierPollLocksTable>;
export type CarrierPollLockUpdate = Updateable<CarrierPollLocksTable>;
