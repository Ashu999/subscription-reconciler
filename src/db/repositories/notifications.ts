import { type Kysely, sql, type Transaction } from 'kysely';

import type { Database } from '../schema.js';

export interface DueNotificationCandidate {
  id: string;
  user_id: string;
  expires_at: Date;
}

export type LockedDueNotification = DueNotificationCandidate;

/**
 * What: Remove all unsent expiry reminders for a user.
 * Why: Once a user is inactive, expired, or open-ended, pending expiry reminders are stale.
 */
export async function deletePendingExpiryNotifications(
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

/**
 * What: Remove pending reminders for older expiry instants.
 * Why: Renewals and source switches can replace the expiry timestamp while preserving access.
 */
export async function deletePendingExpiryNotificationsExcept(
  trx: Transaction<Database>,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await trx
    .deleteFrom('notifications')
    .where('user_id', '=', userId)
    .where('type', '=', 'PREMIUM_EXPIRES_SOON')
    .where('sent_at', 'is', null)
    .where('expires_at', '!=', expiresAt)
    .execute();
}

/**
 * What: Insert one pending expiry reminder if it does not already exist.
 * Why: The unique key keeps repeated canonical recomputes idempotent.
 */
export async function insertExpiryNotificationOnce(
  trx: Transaction<Database>,
  input: { userId: string; expiresAt: Date; scheduledFor: Date },
): Promise<void> {
  await trx
    .insertInto('notifications')
    .values({
      user_id: input.userId,
      type: 'PREMIUM_EXPIRES_SOON',
      expires_at: input.expiresAt,
      scheduled_for: input.scheduledFor,
      sent_at: null,
    })
    .onConflict((oc) => oc.columns(['user_id', 'type', 'expires_at']).doNothing())
    .execute();
}

/**
 * What: Select a bounded batch of unsent notifications due now.
 * Why: Ordered batches keep worker runs short and retries deterministic.
 */
export async function selectDueNotificationCandidates(
  db: Kysely<Database>,
  batchSize: number,
): Promise<DueNotificationCandidate[]> {
  const rows = await sql<DueNotificationCandidate>`
    select id, user_id, expires_at
    from notifications
    where scheduled_for <= now()
      and sent_at is null
    order by scheduled_for asc, id asc
    limit ${batchSize}
  `.execute(db);

  return rows.rows;
}

/**
 * What: Lock a due notification row for processing if it is still unsent.
 * Why: SKIP LOCKED lets multiple workers process different reminders without waiting.
 */
export async function selectDueNotificationForUpdate(
  trx: Transaction<Database>,
  notificationId: string,
): Promise<LockedDueNotification | undefined> {
  const rows = await sql<LockedDueNotification>`
    select id, user_id, expires_at
    from notifications
    where id = ${notificationId}
      and sent_at is null
    for update skip locked
  `.execute(trx);

  return rows.rows[0];
}

/**
 * What: Mark an unsent notification as sent.
 * Why: Notification delivery state should be changed by one focused repository operation.
 */
export async function markNotificationSent(
  trx: Transaction<Database>,
  notificationId: string,
  sentAt: Date,
): Promise<void> {
  await trx
    .updateTable('notifications')
    .set({ sent_at: sentAt })
    .where('id', '=', notificationId)
    .where('sent_at', 'is', null)
    .execute();
}

/**
 * What: Delete one unsent notification by id.
 * Why: Stale reminder cleanup should share the same sent guard as worker claiming.
 */
export async function deleteUnsentNotification(
  trx: Transaction<Database>,
  notificationId: string,
): Promise<void> {
  await trx
    .deleteFrom('notifications')
    .where('id', '=', notificationId)
    .where('sent_at', 'is', null)
    .execute();
}
