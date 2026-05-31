import type { Transaction } from 'kysely';

import type { Database } from '../db/types.js';
import type { CanonicalEntitlementState } from './canonical.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export async function syncExpiryNotification(
  trx: Transaction<Database>,
  canonicalRow: CanonicalEntitlementState,
  transactionNow: Date,
): Promise<void> {
  if (!canonicalRow.active || canonicalRow.expiresAt === null || canonicalRow.expiresAt <= transactionNow) {
    await deletePendingExpiryNotifications(trx, canonicalRow.userId);
    return;
  }

  await trx
    .deleteFrom('notifications')
    .where('user_id', '=', canonicalRow.userId)
    .where('type', '=', 'PREMIUM_EXPIRES_SOON')
    .where('sent_at', 'is', null)
    .where('expires_at', '!=', canonicalRow.expiresAt)
    .execute();

  const shouldSchedule = canonicalRow.expiresAt.getTime() <= transactionNow.getTime() + ONE_DAY_MS;
  if (!shouldSchedule) {
    return;
  }

  await trx
    .insertInto('notifications')
    .values({
      user_id: canonicalRow.userId,
      type: 'PREMIUM_EXPIRES_SOON',
      expires_at: canonicalRow.expiresAt,
      scheduled_for: new Date(canonicalRow.expiresAt.getTime() - ONE_DAY_MS),
      sent_at: null,
    })
    .onConflict((oc) => oc.columns(['user_id', 'type', 'expires_at']).doNothing())
    .execute();
}

async function deletePendingExpiryNotifications(
  trx: Transaction<Database>,
  userId: string,
): Promise<void> {
  await trx
    .deleteFrom('notifications')
    .where('user_id', '=', userId)
    .where('type', '=', 'PREMIUM_EXPIRES_SOON')
    .where('sent_at', 'is', null)
    .execute();
}
