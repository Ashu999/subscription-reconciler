import { type Kysely, sql, type Transaction } from 'kysely';

import type { CanonicalEntitlementForDomain } from '../../domain/types.js';
import type { CanonicalEntitlement, Database } from '../schema.js';

export interface CanonicalEntitlementReadRow extends CanonicalEntitlement {
  needs_refresh: boolean;
}

/**
 * What: Persist the derived canonical entitlement for one user.
 * Why: Reads and jobs use one stored row instead of resolving source precedence on
 * every hot-path request.
 */
export async function upsertCanonicalEntitlement(
  trx: Transaction<Database>,
  row: CanonicalEntitlementForDomain,
): Promise<void> {
  await trx
    .insertInto('canonical_entitlements')
    .values({
      user_id: row.userId,
      active: row.active,
      source: row.source,
      expires_at: row.expiresAt,
      last_changed_at: row.lastChangedAt,
      reason: row.reason,
    })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        active: row.active,
        source: row.source,
        expires_at: row.expiresAt,
        last_changed_at: row.lastChangedAt,
        reason: row.reason,
      }),
    )
    .execute();
}

/**
 * What: Read a canonical entitlement and flag active rows that have expired.
 * Why: The route can return fresh persisted rows directly and only pay recompute cost
 * when time has invalidated the stored canonical state.
 */
export async function selectCanonicalEntitlementForRead(
  db: Kysely<Database>,
  userId: string,
): Promise<CanonicalEntitlementReadRow | undefined> {
  return db
    .selectFrom('canonical_entitlements')
    .selectAll()
    .select(
      sql<boolean>`
        active = true
        and expires_at is not null
        and expires_at <= now()
      `.as('needs_refresh'),
    )
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

/**
 * What: Select a stable batch of expired active canonical users.
 * Why: The expiry reconciler should discover candidates through the canonical repository.
 */
export async function selectExpiredCanonicalUserIds(
  db: Kysely<Database>,
  batchSize: number,
): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    select user_id
    from canonical_entitlements
    where active = true
      and expires_at is not null
      and expires_at <= now()
    order by expires_at asc, user_id asc
    limit ${batchSize}
  `.execute(db);

  return rows.rows.map((row) => row.user_id);
}

/**
 * What: Select active users whose access expires inside a given window.
 * Why: The notification scheduler only needs users that can produce a reminder soon.
 */
export async function selectCanonicalUserIdsExpiringWithin(
  db: Kysely<Database>,
  batchSize: number,
  windowMs: number,
): Promise<string[]> {
  const rows = await sql<{ user_id: string }>`
    select user_id
    from canonical_entitlements
    where active = true
      and expires_at is not null
      and expires_at > now()
      and expires_at <= now() + ${windowMs} * interval '1 millisecond'
    order by expires_at asc, user_id asc
    limit ${batchSize}
  `.execute(db);

  return rows.rows.map((row) => row.user_id);
}
