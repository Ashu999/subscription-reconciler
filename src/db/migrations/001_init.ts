import { type Kysely, sql } from 'kysely';

import { ENTITLEMENT_REASONS, PRODUCT_IDS, STORE_EVENT_TYPES } from '../../domain/constants.js';
import type { Database } from '../schema.js';

/**
 * What: Create the initial tables, constraints, and indexes for entitlement state.
 * Why: The service needs raw events, source projections, canonical reads, reminders,
 * and carrier leases to be queryable with concurrency-safe constraints.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  // What: Store the latest entitlement projection from each individual source.
  // Why: Keeping sources separate lets canonical resolution apply precedence later.
  await db.schema
    .createTable('source_entitlements')
    .ifNotExists()
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('active', 'boolean', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_changed_at', 'timestamptz', (col) => col.notNull())
    .addColumn('reason', 'text', (col) => col.notNull())
    .addColumn('last_event_ms', 'bigint')
    .addColumn('last_event_id', 'text')
    .addPrimaryKeyConstraint('source_entitlements_pkey', ['user_id', 'source'])
    .addCheckConstraint(
      'source_entitlements_source_check',
      sql`source in ('STORE', 'CARRIER', 'MARKETPLACE')`,
    )
    .addCheckConstraint(
      'source_entitlements_reason_check',
      enumCheck('reason', ENTITLEMENT_REASONS),
    )
    .addCheckConstraint(
      'source_entitlements_store_event_fields_check',
      sql`(
        (source = 'STORE' and last_event_ms is not null and last_event_id is not null)
        or
        (source <> 'STORE' and last_event_ms is null and last_event_id is null)
      )`,
    )
    .execute();

  // What: Store the single entitlement answer returned to clients.
  // Why: Reads should not replay every source row on the hot path unless refresh is needed.
  await db.schema
    .createTable('canonical_entitlements')
    .ifNotExists()
    .addColumn('user_id', 'text', (col) => col.primaryKey())
    .addColumn('active', 'boolean', (col) => col.notNull())
    .addColumn('source', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz')
    .addColumn('last_changed_at', 'timestamptz')
    .addColumn('reason', 'text', (col) => col.notNull())
    .addCheckConstraint(
      'canonical_entitlements_source_check',
      sql`source in ('STORE', 'CARRIER', 'MARKETPLACE', 'NONE')`,
    )
    .addCheckConstraint(
      'canonical_entitlements_reason_check',
      enumCheck('reason', ENTITLEMENT_REASONS),
    )
    .execute();

  // What: Persist every accepted store webhook event by id.
  // Why: Raw-event storage gives duplicate protection and lets projections be rebuilt.
  await db.schema
    .createTable('store_events')
    .ifNotExists()
    .addColumn('event_id', 'text', (col) => col.primaryKey())
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('event_time_ms', 'bigint', (col) => col.notNull())
    .addColumn('product_id', 'text', (col) => col.notNull())
    .addColumn('received_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addCheckConstraint('store_events_type_check', enumCheck('type', STORE_EVENT_TYPES))
    .addCheckConstraint('store_events_product_id_check', enumCheck('product_id', PRODUCT_IDS))
    .execute();

  // What: Track pending and sent expiry reminders.
  // Why: A unique key prevents duplicate expiring-soon reminders for the same expiry.
  await db.schema
    .createTable('notifications')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('user_id', 'text', (col) => col.notNull())
    .addColumn('type', 'text', (col) => col.notNull())
    .addColumn('expires_at', 'timestamptz', (col) => col.notNull())
    .addColumn('scheduled_for', 'timestamptz', (col) => col.notNull())
    .addColumn('sent_at', 'timestamptz')
    .addUniqueConstraint('notifications_user_type_expires_at_unique', [
      'user_id',
      'type',
      'expires_at',
    ])
    .addCheckConstraint('notifications_type_check', sql`type in ('PREMIUM_EXPIRES_SOON')`)
    .execute();

  // What: Track which active carrier users are ready to poll and who leased them.
  // Why: Multiple workers may run at once, so leases coordinate polling work.
  await db.schema
    .createTable('carrier_poll_locks')
    .ifNotExists()
    .addColumn('user_id', 'text', (col) => col.primaryKey())
    .addColumn('next_poll_at', 'timestamptz', (col) => col.notNull())
    .addColumn('lease_until', 'timestamptz')
    .addColumn('locked_by', 'text')
    .addColumn('last_polled_at', 'timestamptz')
    .execute();

  // What: Speed up carrier work discovery from active source rows.
  // Why: Poller bootstrap checks source state before claiming carrier leases.
  await db.schema
    .createIndex('source_entitlements_source_active_expires_at_idx')
    .ifNotExists()
    .on('source_entitlements')
    .columns(['source', 'active', 'expires_at'])
    .execute();

  // What: Speed up deterministic replay of store events for one user.
  // Why: Every store webhook recompute reads events by user and business-time order.
  await db.schema
    .createIndex('store_events_user_event_order_idx')
    .ifNotExists()
    .on('store_events')
    .columns(['user_id', 'event_time_ms', 'event_id'])
    .execute();

  // What: Speed up finding active canonical rows that have just expired.
  // Why: The expiry reconciler only scans rows with non-null expiry timestamps.
  await sql`
    create index if not exists canonical_entitlements_active_expires_at_idx
    on canonical_entitlements (expires_at)
    where active = true and expires_at is not null
  `.execute(db);

  // What: Speed up notification worker scans for due unsent reminders.
  // Why: Workers repeatedly query by schedule time and sent status.
  await db.schema
    .createIndex('notifications_scheduled_sent_idx')
    .ifNotExists()
    .on('notifications')
    .columns(['scheduled_for', 'sent_at'])
    .execute();

  // What: Speed up carrier lease discovery by next poll time.
  // Why: Poller instances need a small ordered batch of unlocked due rows.
  await db.schema
    .createIndex('carrier_poll_locks_next_poll_lease_idx')
    .ifNotExists()
    .on('carrier_poll_locks')
    .columns(['next_poll_at', 'lease_until'])
    .execute();
}

/**
 * What: Drop the initial schema objects in dependency order.
 * Why: Rollbacks should remove derived tables before their source tables.
 */
export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('carrier_poll_locks').ifExists().execute();
  await db.schema.dropTable('notifications').ifExists().execute();
  await db.schema.dropTable('store_events').ifExists().execute();
  await db.schema.dropTable('canonical_entitlements').ifExists().execute();
  await db.schema.dropTable('source_entitlements').ifExists().execute();
}

/**
 * What: Build a SQL enum-style check constraint for a text column.
 * Why: The schema stores TypeScript union values as text while still enforcing the
 * allowed domain values in Postgres.
 */
function enumCheck(column: string, values: readonly string[]) {
  const quotedValues = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
  return sql`${sql.ref(column)} in (${sql.raw(quotedValues)})`;
}
