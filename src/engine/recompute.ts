import type { Transaction } from 'kysely';

import { mapSourceEntitlementForDomain } from '../db/mappers.js';
import { upsertCanonicalEntitlement } from '../db/repositories/canonical-entitlements.js';
import { selectSourceEntitlementsForUser } from '../db/repositories/source-entitlements.js';
import type { Database } from '../db/schema.js';
import { getTransactionNow } from '../db/transactions.js';
import { type CanonicalEntitlementState, resolveCanonical } from './canonical.js';
import { syncExpiryNotification } from './notifications.js';

/**
 * What: Rebuild and persist the canonical entitlement for one user.
 * Why: Every source mutation needs a single derived row for reads and notification jobs,
 * and empty source sets still need a user-specific NONE row.
 */
export async function recomputeCanonical(
  trx: Transaction<Database>,
  userId: string,
  transactionNow?: Date,
): Promise<CanonicalEntitlementState> {
  const now = transactionNow ?? (await getTransactionNow(trx));
  const sourceRows = await selectSourceEntitlementsForUser(trx, userId);
  const canonicalRow = resolveCanonical(
    sourceRows.map((row) => mapSourceEntitlementForDomain(row)),
    now,
  );

  const rowWithUserId = canonicalRow.userId === '' ? { ...canonicalRow, userId } : canonicalRow;

  await upsertCanonicalEntitlement(trx, rowWithUserId);

  return rowWithUserId;
}

/**
 * What: Recompute canonical state and synchronize derived expiry reminders together.
 * Why: Callers should not have to remember the coupled canonical/notification update
 * sequence after every entitlement source change.
 */
export async function recomputeCanonicalAndSyncNotifications(
  trx: Transaction<Database>,
  userId: string,
  transactionNow?: Date,
): Promise<CanonicalEntitlementState> {
  const now = transactionNow ?? (await getTransactionNow(trx));
  const canonicalRow = await recomputeCanonical(trx, userId, now);
  await syncExpiryNotification(trx, canonicalRow, now);

  return canonicalRow;
}
