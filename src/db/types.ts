import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

export type EntitlementSource = 'STORE' | 'CARRIER' | 'MARKETPLACE';
export type CanonicalEntitlementSource = EntitlementSource | 'NONE';
export type StoreEventType =
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'BILLING_ISSUE'
  | 'EXPIRATION'
  | 'UN_CANCELLATION';
export type EntitlementReason =
  | StoreEventType
  | 'MARKETPLACE_GRANT'
  | 'MARKETPLACE_REVOKE'
  | 'CARRIER_ACTIVE'
  | 'CARRIER_INACTIVE'
  | 'NO_ENTITLEMENT';
export type NotificationType = 'PREMIUM_EXPIRES_SOON';
export type ProductId = 'premium_monthly';

type TimestampColumn = ColumnType<Date, Date | string, Date | string>;
type NullableTimestampColumn = ColumnType<Date | null, Date | string | null, Date | string | null>;
type DefaultTimestampColumn = ColumnType<Date, Date | string | undefined, Date | string>;
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
}

export interface CanonicalEntitlementsTable {
  user_id: string;
  active: boolean;
  source: CanonicalEntitlementSource;
  expires_at: NullableTimestampColumn;
  last_changed_at: NullableTimestampColumn;
  reason: EntitlementReason;
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
}

export interface CarrierPollLocksTable {
  user_id: string;
  next_poll_at: TimestampColumn;
  lease_until: NullableTimestampColumn;
  locked_by: string | null;
  last_polled_at: NullableTimestampColumn;
}

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
