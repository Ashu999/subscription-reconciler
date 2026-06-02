import { type Kysely, sql } from 'kysely';

import type { Database } from '../schema.js';

const AUDITED_TABLES = ['source_entitlements', 'canonical_entitlements', 'notifications'] as const;

/**
 * What: Add row lifecycle audit timestamps to mutable entitlement tables.
 * Why: created_at and updated_at capture persistence history without changing the
 * existing business timestamps such as last_changed_at, received_at, or sent_at.
 */
export async function up(db: Kysely<Database>): Promise<void> {
  for (const table of AUDITED_TABLES) {
    await sql`
      alter table ${sql.table(table)}
        add column if not exists created_at timestamptz not null default now(),
        add column if not exists updated_at timestamptz not null default now()
    `.execute(db);
  }

  await sql`
    create or replace function subscription_reconciler_set_updated_at()
    returns trigger
    language plpgsql
    as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$
  `.execute(db);

  for (const table of AUDITED_TABLES) {
    await sql`
      drop trigger if exists ${sql.raw(`${table}_set_updated_at`)} on ${sql.table(table)}
    `.execute(db);
    await sql`
      create trigger ${sql.raw(`${table}_set_updated_at`)}
      before update on ${sql.table(table)}
      for each row
      execute function subscription_reconciler_set_updated_at()
    `.execute(db);
  }
}

/**
 * What: Remove audit timestamp triggers and columns.
 * Why: Migration rollback should leave the database in the pre-audit schema state.
 */
export async function down(db: Kysely<Database>): Promise<void> {
  for (const table of AUDITED_TABLES) {
    await sql`
      drop trigger if exists ${sql.raw(`${table}_set_updated_at`)} on ${sql.table(table)}
    `.execute(db);
  }

  await sql`drop function if exists subscription_reconciler_set_updated_at()`.execute(db);

  for (const table of AUDITED_TABLES) {
    await sql`
      alter table ${sql.table(table)}
        drop column if exists updated_at,
        drop column if exists created_at
    `.execute(db);
  }
}
