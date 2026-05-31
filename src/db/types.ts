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

export type SelectableSourceEntitlement = Selectable<SourceEntitlementsTable>;
export type InsertableSourceEntitlement = Insertable<SourceEntitlementsTable>;
export type UpdateableSourceEntitlement = Updateable<SourceEntitlementsTable>;
export type SourceEntitlement = SelectableSourceEntitlement;
export type NewSourceEntitlement = InsertableSourceEntitlement;
export type SourceEntitlementUpdate = UpdateableSourceEntitlement;

export type SelectableCanonicalEntitlement = Selectable<CanonicalEntitlementsTable>;
export type InsertableCanonicalEntitlement = Insertable<CanonicalEntitlementsTable>;
export type UpdateableCanonicalEntitlement = Updateable<CanonicalEntitlementsTable>;
export type CanonicalEntitlement = SelectableCanonicalEntitlement;
export type NewCanonicalEntitlement = InsertableCanonicalEntitlement;
export type CanonicalEntitlementUpdate = UpdateableCanonicalEntitlement;

export type SelectableStoreEvent = Selectable<StoreEventsTable>;
export type InsertableStoreEvent = Insertable<StoreEventsTable>;
export type UpdateableStoreEvent = Updateable<StoreEventsTable>;
export type StoreEvent = SelectableStoreEvent;
export type NewStoreEvent = InsertableStoreEvent;
export type StoreEventUpdate = UpdateableStoreEvent;

export type SelectableNotification = Selectable<NotificationsTable>;
export type InsertableNotification = Insertable<NotificationsTable>;
export type UpdateableNotification = Updateable<NotificationsTable>;
export type Notification = SelectableNotification;
export type NewNotification = InsertableNotification;
export type NotificationUpdate = UpdateableNotification;

export type SelectableCarrierPollLock = Selectable<CarrierPollLocksTable>;
export type InsertableCarrierPollLock = Insertable<CarrierPollLocksTable>;
export type UpdateableCarrierPollLock = Updateable<CarrierPollLocksTable>;
export type CarrierPollLock = SelectableCarrierPollLock;
export type NewCarrierPollLock = InsertableCarrierPollLock;
export type CarrierPollLockUpdate = UpdateableCarrierPollLock;

export interface SourceEntitlementForDomain {
  userId: string;
  source: EntitlementSource;
  active: boolean;
  expiresAt: Date | null;
  lastChangedAt: Date;
  reason: EntitlementReason;
}

export interface CanonicalEntitlementForDomain {
  userId: string;
  active: boolean;
  source: CanonicalEntitlementSource;
  expiresAt: Date | null;
  lastChangedAt: Date | null;
  reason: EntitlementReason;
}

export interface StoreEventForDomain {
  eventId: string;
  userId: string;
  type: StoreEventType;
  eventTimeMs: number;
  productId: ProductId;
  receivedAt: Date;
}

export interface CanonicalEntitlementResponse {
  active: boolean;
  source: CanonicalEntitlementSource;
  expiresAt: string | null;
  lastChangedAt: string | null;
  reason: EntitlementReason;
}

const MIN_JS_DATE_MS = -8_640_000_000_000_000;
const MAX_JS_DATE_MS = 8_640_000_000_000_000;
const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

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

export function serializeCanonicalEntitlementForResponse(
  row: CanonicalEntitlementForDomain,
): CanonicalEntitlementResponse {
  return {
    active: row.active,
    source: row.source,
    expiresAt: serializeNullableTimestamp(row.expiresAt),
    lastChangedAt: serializeNullableTimestamp(row.lastChangedAt),
    reason: row.reason,
  };
}

export function serializeCanonicalEntitlementRowForResponse(
  row: CanonicalEntitlement,
): CanonicalEntitlementResponse {
  return serializeCanonicalEntitlementForResponse(mapCanonicalEntitlementForDomain(row));
}

export function serializeTimestamp(value: Date): string {
  assertValidDate(value, 'timestamp');
  return value.toISOString();
}

export function serializeNullableTimestamp(value: Date | null): string | null {
  return value === null ? null : serializeTimestamp(value);
}

export function parseDbBigIntAsSafeEpochMs(
  value: string | number | bigint,
  columnName: string,
): number {
  const parsed = parseDbBigIntAsSafeNumber(value, columnName);

  if (parsed < MIN_JS_DATE_MS || parsed > MAX_JS_DATE_MS) {
    throw new Error(`${columnName} must be within the JavaScript Date epoch millisecond range`);
  }

  return parsed;
}

function parseDbBigIntAsSafeNumber(value: string | number | bigint, columnName: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${columnName} must be a safe integer`);
    }

    return value;
  }

  const parsed = typeof value === 'bigint' ? value : parseDbBigIntString(value, columnName);

  if (parsed < MIN_SAFE_INTEGER_BIGINT || parsed > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`${columnName} must fit in a safe JavaScript integer`);
  }

  return Number(parsed);
}

function parseDbBigIntString(value: string, columnName: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${columnName} must be an integer string`);
  }

  return BigInt(trimmed);
}

function assertValidDate(value: Date, fieldName: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}
