import type { Transaction } from 'kysely';

import { ensureCarrierPollLock } from '../db/repositories/carrier-poll-locks.js';
import {
  type UpsertExternalSourceEntitlementInput,
  upsertExternalSourceEntitlement,
} from '../db/repositories/source-entitlements.js';
import type { Database } from '../db/schema.js';
import { acquireUserEntitlementLock } from '../db/transactions.js';
import type { CanonicalEntitlementState } from './canonical.js';
import { recomputeCanonicalAndSyncNotifications } from './recompute.js';

export type SeedSourceEntitlementInput = UpsertExternalSourceEntitlementInput;

/**
 * What: Insert or update a non-STORE source entitlement during seeding.
 * Why: Seeded carrier or marketplace state should flow through the same locked
 * canonical and notification recompute path as live mutations.
 */
export async function upsertSeedSourceEntitlement(
  trx: Transaction<Database>,
  input: SeedSourceEntitlementInput,
  transactionNow: Date,
): Promise<CanonicalEntitlementState> {
  await acquireUserEntitlementLock(trx, input.userId);

  await upsertExternalSourceEntitlement(trx, input, transactionNow);
  if (input.source === 'CARRIER' && input.active) {
    await ensureCarrierPollLock(trx, input.userId, transactionNow);
  }

  return recomputeCanonicalAndSyncNotifications(trx, input.userId, transactionNow);
}
