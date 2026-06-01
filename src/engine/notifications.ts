import type { Transaction } from 'kysely';

import {
  deletePendingExpiryNotifications,
  deletePendingExpiryNotificationsExcept,
  insertExpiryNotificationOnce,
} from '../db/repositories/notifications.js';
import type { Database } from '../db/schema.js';
import { getTransactionNow } from '../db/transactions.js';
import { EXPIRING_SOON_WINDOW_MS } from '../domain/constants.js';
import type { CanonicalEntitlementState } from './canonical.js';

/**
 * What: Keep the pending expiry reminder in sync with the canonical entitlement.
 * Why: Every entitlement recompute can change access, so scheduling must be idempotent
 * and stale unsent reminders must disappear before workers can send them.
 */
export async function syncExpiryNotification(
  trx: Transaction<Database>,
  canonicalRow: CanonicalEntitlementState,
  transactionNow?: Date,
): Promise<void> {
  const now = transactionNow ?? (await getTransactionNow(trx));

  if (!canonicalRow.active || canonicalRow.expiresAt === null || canonicalRow.expiresAt <= now) {
    await deletePendingExpiryNotifications(trx, canonicalRow.userId);
    return;
  }

  // expires_at is part of the idempotency key, so remove unsent reminders for
  // older expiry instants after a renewal or source switch extends access.
  await deletePendingExpiryNotificationsExcept(trx, canonicalRow.userId, canonicalRow.expiresAt);

  const shouldSchedule =
    canonicalRow.expiresAt.getTime() <= now.getTime() + EXPIRING_SOON_WINDOW_MS;
  if (!shouldSchedule) {
    return;
  }

  // The unique key makes repeated recomputes safe while preserving a separate
  // reminder if a later renewal produces a new expiry instant.
  await insertExpiryNotificationOnce(trx, {
    userId: canonicalRow.userId,
    expiresAt: canonicalRow.expiresAt,
    scheduledFor: new Date(canonicalRow.expiresAt.getTime() - EXPIRING_SOON_WINDOW_MS),
  });
}
