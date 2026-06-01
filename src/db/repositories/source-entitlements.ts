import type { Transaction } from 'kysely';

import type { EntitlementReason, EntitlementSource } from '../../domain/types.js';
import type { Database, SourceEntitlement } from '../schema.js';

export interface UpsertExternalSourceEntitlementInput {
  userId: string;
  source: Exclude<EntitlementSource, 'STORE'>;
  active: boolean;
  expiresAt: Date | null;
  reason: Extract<
    EntitlementReason,
    'CARRIER_ACTIVE' | 'CARRIER_INACTIVE' | 'MARKETPLACE_GRANT' | 'MARKETPLACE_REVOKE'
  >;
}

export interface UpsertStoreSourceEntitlementInput {
  userId: string;
  active: boolean;
  expiresAt: Date | null;
  lastChangedAt: Date;
  reason: EntitlementReason;
  lastEventMs: number;
  lastEventId: string;
}

/**
 * What: Read all source entitlement rows for one user.
 * Why: Canonical recompute needs the current state of every source before resolving
 * precedence.
 */
export async function selectSourceEntitlementsForUser(
  trx: Transaction<Database>,
  userId: string,
): Promise<SourceEntitlement[]> {
  return trx.selectFrom('source_entitlements').selectAll().where('user_id', '=', userId).execute();
}

/**
 * What: Persist the rebuilt STORE source projection.
 * Why: Replaying store events produces one source row that canonical recompute can
 * compare against carrier and marketplace rows.
 */
export async function upsertStoreSourceEntitlement(
  trx: Transaction<Database>,
  input: UpsertStoreSourceEntitlementInput,
): Promise<SourceEntitlement> {
  return trx
    .insertInto('source_entitlements')
    .values({
      user_id: input.userId,
      source: 'STORE',
      active: input.active,
      expires_at: input.expiresAt,
      last_changed_at: input.lastChangedAt,
      reason: input.reason,
      last_event_ms: input.lastEventMs,
      last_event_id: input.lastEventId,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'source']).doUpdateSet({
        active: input.active,
        expires_at: input.expiresAt,
        last_changed_at: input.lastChangedAt,
        reason: input.reason,
        last_event_ms: input.lastEventMs,
        last_event_id: input.lastEventId,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * What: Upsert a seeded carrier or marketplace source row.
 * Why: Re-seeding should replace the source's latest state while clearing STORE-only
 * event metadata that does not apply to external sources.
 */
export async function upsertExternalSourceEntitlement(
  trx: Transaction<Database>,
  input: UpsertExternalSourceEntitlementInput,
  transactionNow: Date,
): Promise<SourceEntitlement | undefined> {
  return trx
    .insertInto('source_entitlements')
    .values({
      user_id: input.userId,
      source: input.source,
      active: input.active,
      expires_at: input.expiresAt,
      last_changed_at: transactionNow,
      reason: input.reason,
      last_event_ms: null,
      last_event_id: null,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'source']).doUpdateSet({
        active: input.active,
        expires_at: input.expiresAt,
        last_changed_at: transactionNow,
        reason: input.reason,
        last_event_ms: null,
        last_event_id: null,
      }),
    )
    .returningAll()
    .executeTakeFirst();
}

/**
 * What: Revoke active marketplace rows for a sorted chunk of users.
 * Why: Bulk revoke orchestration should not duplicate the source-row update shape.
 */
export async function revokeActiveMarketplaceEntitlements(
  trx: Transaction<Database>,
  userIds: readonly string[],
  transactionNow: Date,
): Promise<string[]> {
  const revokedRows = await trx
    .updateTable('source_entitlements')
    .set({
      active: false,
      expires_at: null,
      last_changed_at: transactionNow,
      reason: 'MARKETPLACE_REVOKE',
    })
    .where('user_id', 'in', userIds)
    .where('source', '=', 'MARKETPLACE')
    .where('active', '=', true)
    .returning('user_id')
    .execute();

  return revokedRows.map((row) => row.user_id);
}

/**
 * What: Deactivate one active CARRIER source row.
 * Why: Carrier polling and canonical recompute should share a single source update
 * contract for confirmed inactive plans.
 */
export async function deactivateActiveCarrierSource(
  trx: Transaction<Database>,
  userId: string,
  transactionNow: Date,
): Promise<boolean> {
  const changedRows = await trx
    .updateTable('source_entitlements')
    .set({
      active: false,
      expires_at: null,
      last_changed_at: transactionNow,
      reason: 'CARRIER_INACTIVE',
    })
    .where('user_id', '=', userId)
    .where('source', '=', 'CARRIER')
    .where('active', '=', true)
    .returning('user_id')
    .execute();

  return changedRows.length > 0;
}
