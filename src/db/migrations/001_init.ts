import { sql, type Kysely } from 'kysely';

import type { Database } from '../types.js';

const STORE_EVENT_TYPES = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'CANCELLATION',
  'BILLING_ISSUE',
  'EXPIRATION',
  'UN_CANCELLATION',
];

const ENTITLEMENT_REASONS = [
  ...STORE_EVENT_TYPES,
  'MARKETPLACE_GRANT',
  'MARKETPLACE_REVOKE',
  'CARRIER_ACTIVE',
  'CARRIER_INACTIVE',
  'NO_ENTITLEMENT',
];

export async function up(db: Kysely<Database>): Promise<void> {
  await sql`create extension if not exists pgcrypto`.execute(db);

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
    .addCheckConstraint('source_entitlements_reason_check', enumCheck('reason', ENTITLEMENT_REASONS))
    .addCheckConstraint(
      'source_entitlements_store_event_fields_check',
      sql`(
        (source = 'STORE' and last_event_ms is not null and last_event_id is not null)
        or
        (source <> 'STORE' and last_event_ms is null and last_event_id is null)
      )`,
    )
    .execute();

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
    .addCheckConstraint('canonical_entitlements_reason_check', enumCheck('reason', ENTITLEMENT_REASONS))
    .execute();

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
    .addCheckConstraint('store_events_product_id_check', sql`product_id in ('premium_monthly')`)
    .execute();

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

  await db.schema
    .createTable('carrier_poll_locks')
    .ifNotExists()
    .addColumn('user_id', 'text', (col) => col.primaryKey())
    .addColumn('next_poll_at', 'timestamptz', (col) => col.notNull())
    .addColumn('lease_until', 'timestamptz')
    .addColumn('locked_by', 'text')
    .addColumn('last_polled_at', 'timestamptz')
    .execute();

  await db.schema
    .createIndex('source_entitlements_source_active_expires_at_idx')
    .ifNotExists()
    .on('source_entitlements')
    .columns(['source', 'active', 'expires_at'])
    .execute();

  await db.schema
    .createIndex('store_events_user_event_order_idx')
    .ifNotExists()
    .on('store_events')
    .columns(['user_id', 'event_time_ms', 'event_id'])
    .execute();

  await sql`
    create index if not exists canonical_entitlements_active_expires_at_idx
    on canonical_entitlements (expires_at)
    where active = true and expires_at is not null
  `.execute(db);

  await db.schema
    .createIndex('notifications_scheduled_sent_idx')
    .ifNotExists()
    .on('notifications')
    .columns(['scheduled_for', 'sent_at'])
    .execute();

  await db.schema
    .createIndex('carrier_poll_locks_next_poll_lease_idx')
    .ifNotExists()
    .on('carrier_poll_locks')
    .columns(['next_poll_at', 'lease_until'])
    .execute();
}

export async function down(db: Kysely<Database>): Promise<void> {
  await db.schema.dropTable('carrier_poll_locks').ifExists().execute();
  await db.schema.dropTable('notifications').ifExists().execute();
  await db.schema.dropTable('store_events').ifExists().execute();
  await db.schema.dropTable('canonical_entitlements').ifExists().execute();
  await db.schema.dropTable('source_entitlements').ifExists().execute();
}

function enumCheck(column: string, values: readonly string[]) {
  const quotedValues = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');
  return sql`${sql.ref(column)} in (${sql.raw(quotedValues)})`;
}
