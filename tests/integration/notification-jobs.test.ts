import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyStoreEvent, type StoreEventInput } from '../../src/engine/entitlement.js';
import { runNotificationScheduler } from '../../src/jobs/notification-scheduler.js';
import { runNotificationWorker } from '../../src/jobs/notification-worker.js';
import { selectCanonical, selectNotifications } from '../helpers/db-selectors.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const MONTH_MS = 30 * ONE_DAY_MS;

describe('expiration notification jobs', () => {
  let harness: IntegrationHarness | undefined;

  beforeAll(async () => {
    harness = await createIntegrationHarness();
  }, 120_000);

  afterEach(async () => {
    await requireHarness(harness).resetDb();
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('does not create a notification while canonical expiry is outside the next 24 hours', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_outside_window';

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'outside-window-initial',
        userId,
        eventTimeMs: Date.now(),
      }),
    );

    expect(await selectNotifications(currentHarness, userId)).toHaveLength(0);

    const result = await runNotificationScheduler({ db: currentHarness.db });

    expect(result.candidateCount).toBe(0);
    expect(await selectNotifications(currentHarness, userId)).toHaveLength(0);
  });

  it('schedules an expiry notification when a canonical expiry is inside the next 24 hours', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_enters_window';
    const eventTimeMs = Date.now() - Math.floor(29.5 * ONE_DAY_MS);
    const expiresAt = new Date(eventTimeMs + MONTH_MS);

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'enters-window-initial',
        userId,
        eventTimeMs,
      }),
    );
    await deleteNotifications(currentHarness, userId);

    const result = await runNotificationScheduler({ db: currentHarness.db });

    expect(result).toMatchObject({ candidateCount: 1, syncedCount: 1 });
    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.expires_at).toEqual(expiresAt);
    expect(notifications[0]?.scheduled_for).toEqual(new Date(expiresAt.getTime() - ONE_DAY_MS));
    expect(notifications[0]?.sent_at).toBeNull();
  });

  it('keeps duplicate webhook delivery to one notification row per expiry instant', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_duplicate_webhook';
    const event = storeEvent({
      eventId: 'duplicate-notification-initial',
      userId,
      eventTimeMs: Date.now() - Math.floor(29.5 * ONE_DAY_MS),
    });

    await applySingleStoreEvent(currentHarness, event);
    await applySingleStoreEvent(currentHarness, event);

    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('PREMIUM_EXPIRES_SOON');
  });

  it('deletes a pending old-expiry notification and schedules the renewed expiry', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_renewed_before_send';
    const initialPurchaseMs = Date.now() - Math.floor(29.5 * ONE_DAY_MS);
    const renewalMs = initialPurchaseMs + 6 * ONE_HOUR_MS;
    const oldExpiresAt = new Date(initialPurchaseMs + MONTH_MS);
    const renewedExpiresAt = new Date(renewalMs + MONTH_MS);

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'renew-before-send-initial',
        userId,
        eventTimeMs: initialPurchaseMs,
      }),
    );
    expect((await selectNotifications(currentHarness, userId))[0]?.expires_at).toEqual(
      oldExpiresAt,
    );

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'renew-before-send-renewal',
        userId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );

    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.expires_at).toEqual(renewedExpiresAt);
    expect(notifications[0]?.expires_at).not.toEqual(oldExpiresAt);
    expect(notifications[0]?.scheduled_for).toEqual(
      new Date(renewedExpiresAt.getTime() - ONE_DAY_MS),
    );
    expect(notifications[0]?.sent_at).toBeNull();
  });

  it('deletes a due notification when recomputation shows the entitlement already expired', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_expired_due';

    await insertStoreCanonicalAndNotification(currentHarness, {
      userId,
      expiresAt: new Date(Date.now() - ONE_HOUR_MS),
    });

    const result = await runNotificationWorker({ db: currentHarness.db });

    expect(result).toMatchObject({ candidateCount: 1, sentCount: 0, deletedStaleCount: 1 });
    expect(await selectNotifications(currentHarness, userId)).toHaveLength(0);

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(false);
    expect(canonical.source).toBe('NONE');
    expect(canonical.reason).toBe('EXPIRATION');
  });

  it('deletes a stale due notification when canonical expiry changed before send', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_stale_due';
    const oldExpiresAt = new Date(Date.now() + ONE_HOUR_MS);
    const renewedExpiresAt = new Date(Date.now() + 12 * ONE_HOUR_MS);

    await insertStoreCanonicalAndNotification(currentHarness, {
      userId,
      expiresAt: renewedExpiresAt,
      notificationExpiresAt: oldExpiresAt,
    });

    const result = await runNotificationWorker({ db: currentHarness.db });

    expect(result).toMatchObject({ candidateCount: 1, sentCount: 0, deletedStaleCount: 1 });
    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.expires_at).toEqual(renewedExpiresAt);
    expect(notifications[0]?.scheduled_for).toEqual(
      new Date(renewedExpiresAt.getTime() - ONE_DAY_MS),
    );
    expect(notifications[0]?.sent_at).toBeNull();
  });

  it('stamps a due notification only once across concurrent worker instances', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_concurrent_workers';

    await insertStoreCanonicalAndNotification(currentHarness, {
      userId,
      expiresAt: new Date(Date.now() + 12 * ONE_HOUR_MS),
    });

    const [firstResult, secondResult] = await Promise.all([
      runNotificationWorker({ db: currentHarness.db }),
      runNotificationWorker({ db: currentHarness.db }),
    ]);

    expect(firstResult.sentCount + secondResult.sentCount).toBe(1);
    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sent_at).toBeInstanceOf(Date);
  });

  it('does not pick up future-scheduled notifications before they are due', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_notification_future_scheduled';

    await insertStoreCanonicalAndNotification(currentHarness, {
      userId,
      expiresAt: new Date(Date.now() + 48 * ONE_HOUR_MS),
      scheduledFor: new Date(Date.now() + 24 * ONE_HOUR_MS),
    });

    const result = await runNotificationWorker({ db: currentHarness.db });

    expect(result.candidateCount).toBe(0);
    const notifications = await selectNotifications(currentHarness, userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.sent_at).toBeNull();
  });
});

function storeEvent(input: {
  eventId: string;
  userId: string;
  type?: StoreEventInput['type'];
  eventTimeMs: number;
}): StoreEventInput {
  return {
    eventId: input.eventId,
    userId: input.userId,
    type: input.type ?? 'INITIAL_PURCHASE',
    eventTimeMs: input.eventTimeMs,
    productId: 'premium_monthly',
  };
}

async function applySingleStoreEvent(
  harness: IntegrationHarness,
  event: StoreEventInput,
): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    await applyStoreEvent(trx, event);
  });
}

async function insertStoreCanonicalAndNotification(
  harness: IntegrationHarness,
  input: {
    userId: string;
    expiresAt: Date;
    notificationExpiresAt?: Date;
    scheduledFor?: Date;
  },
): Promise<void> {
  const lastChangedAt = new Date(input.expiresAt.getTime() - ONE_DAY_MS);
  const notificationExpiresAt = input.notificationExpiresAt ?? input.expiresAt;

  await harness.db
    .insertInto('source_entitlements')
    .values({
      user_id: input.userId,
      source: 'STORE',
      active: true,
      expires_at: input.expiresAt,
      last_changed_at: lastChangedAt,
      reason: 'RENEWAL',
      last_event_ms: lastChangedAt.getTime(),
      last_event_id: `${input.userId}-seed`,
    })
    .execute();

  await harness.db
    .insertInto('canonical_entitlements')
    .values({
      user_id: input.userId,
      active: true,
      source: 'STORE',
      expires_at: input.expiresAt,
      last_changed_at: lastChangedAt,
      reason: 'RENEWAL',
    })
    .execute();

  await harness.db
    .insertInto('notifications')
    .values({
      user_id: input.userId,
      type: 'PREMIUM_EXPIRES_SOON',
      expires_at: notificationExpiresAt,
      scheduled_for: input.scheduledFor ?? new Date(notificationExpiresAt.getTime() - ONE_DAY_MS),
      sent_at: null,
    })
    .execute();
}

async function deleteNotifications(harness: IntegrationHarness, userId: string): Promise<void> {
  await harness.db.deleteFrom('notifications').where('user_id', '=', userId).execute();
}
