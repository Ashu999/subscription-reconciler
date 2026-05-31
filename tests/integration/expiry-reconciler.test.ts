import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { EntitlementSource, Notification, SourceEntitlement } from '../../src/db/types.js';
import {
  acquireUserEntitlementLock,
  applyStoreEvent,
  getTransactionNow,
  type SeedSourceEntitlementInput,
  type StoreEventInput,
  upsertSeedSourceEntitlement,
} from '../../src/engine/entitlement.js';
import { runExpiryReconciler } from '../../src/jobs/expiry-reconciler.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness } from '../helpers/integration.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const MONTH_MS = 30 * ONE_DAY_MS;

describe('expiry reconciler', () => {
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

  it('refreshes expired canonical rows, syncs notifications, and preserves STORE metadata', async () => {
    const currentHarness = requireHarness(harness);
    const storeOnlyUserId = 'user_expiry_reconciler_store_only';
    const carrierFallbackUserId = 'user_expiry_reconciler_carrier_fallback';

    const storeOnlyCandidate = await seedExpiredStoreCandidate(currentHarness, storeOnlyUserId);
    const carrierFallbackCandidate = await seedExpiredStoreCandidate(
      currentHarness,
      carrierFallbackUserId,
    );
    await seedSource(currentHarness, carrierGrant(carrierFallbackUserId));
    await markCanonicalAsExpiredStore(currentHarness, carrierFallbackCandidate);
    await insertPendingExpiryNotification(
      currentHarness,
      storeOnlyUserId,
      storeOnlyCandidate.expiresAt,
    );
    await insertPendingExpiryNotification(
      currentHarness,
      carrierFallbackUserId,
      carrierFallbackCandidate.expiresAt,
    );

    const storeOnlySourceBefore = await selectSource(currentHarness, storeOnlyUserId, 'STORE');
    const carrierFallbackStoreSourceBefore = await selectSource(
      currentHarness,
      carrierFallbackUserId,
      'STORE',
    );

    const result = await runExpiryReconciler({ db: currentHarness.db });

    expect(result).toEqual({ candidateCount: 2, reconciledCount: 2, skippedBusyCount: 0 });

    const storeOnlyCanonical = await selectCanonical(currentHarness, storeOnlyUserId);
    expect(storeOnlyCanonical.active).toBe(false);
    expect(storeOnlyCanonical.source).toBe('NONE');
    expect(storeOnlyCanonical.reason).toBe('EXPIRATION');
    expect(storeOnlyCanonical.last_changed_at).toEqual(storeOnlyCandidate.expiresAt);

    const carrierFallbackCanonical = await selectCanonical(currentHarness, carrierFallbackUserId);
    expect(carrierFallbackCanonical.active).toBe(true);
    expect(carrierFallbackCanonical.source).toBe('CARRIER');
    expect(carrierFallbackCanonical.expires_at).toBeNull();
    expect(carrierFallbackCanonical.reason).toBe('CARRIER_ACTIVE');

    expect(await selectSource(currentHarness, storeOnlyUserId, 'STORE')).toEqual(
      storeOnlySourceBefore,
    );
    expect(await selectSource(currentHarness, carrierFallbackUserId, 'STORE')).toEqual(
      carrierFallbackStoreSourceBefore,
    );
    expect(await selectNotifications(currentHarness, storeOnlyUserId)).toHaveLength(0);
    expect(await selectNotifications(currentHarness, carrierFallbackUserId)).toHaveLength(0);
  });

  it('allows a late RENEWAL to reactivate STORE after reconciliation', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_expiry_reconciler_late_renewal';
    const expiredCandidate = await seedExpiredStoreCandidate(currentHarness, userId);

    const reconcileResult = await runExpiryReconciler({ db: currentHarness.db });
    expect(reconcileResult).toMatchObject({ candidateCount: 1, reconciledCount: 1 });
    expect((await selectCanonical(currentHarness, userId)).source).toBe('NONE');

    const renewalMs = expiredCandidate.expiresAt.getTime() + 12 * ONE_HOUR_MS;
    const renewedExpiresAt = new Date(renewalMs + MONTH_MS);
    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'late-renewal-after-reconcile',
        userId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );

    const storeSource = await selectSource(currentHarness, userId, 'STORE');
    expect(storeSource.active).toBe(true);
    expect(storeSource.reason).toBe('RENEWAL');
    expect(storeSource.expires_at).toEqual(renewedExpiresAt);
    expect(storeSource.last_event_ms).toBe(String(renewalMs));
    expect(storeSource.last_event_id).toBe('late-renewal-after-reconcile');

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.expires_at).toEqual(renewedExpiresAt);
  });

  it('skips busy users and handles them on a later run', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_expiry_reconciler_busy_lock';
    await seedExpiredStoreCandidate(currentHarness, userId);

    await withHeldUserLock(currentHarness, userId, async () => {
      const busyResult = await runExpiryReconciler({ db: currentHarness.db });

      expect(busyResult).toEqual({ candidateCount: 1, reconciledCount: 0, skippedBusyCount: 1 });
      const staleCanonical = await selectCanonical(currentHarness, userId);
      expect(staleCanonical.active).toBe(true);
      expect(staleCanonical.source).toBe('STORE');
    });

    const laterResult = await runExpiryReconciler({ db: currentHarness.db });
    expect(laterResult).toEqual({ candidateCount: 1, reconciledCount: 1, skippedBusyCount: 0 });

    const refreshedCanonical = await selectCanonical(currentHarness, userId);
    expect(refreshedCanonical.active).toBe(false);
    expect(refreshedCanonical.source).toBe('NONE');
    expect(refreshedCanonical.reason).toBe('EXPIRATION');
  });
});

interface ExpiredStoreCandidate {
  userId: string;
  purchaseMs: number;
  expiresAt: Date;
}

function requireHarness(harness: IntegrationHarness | undefined): IntegrationHarness {
  if (harness === undefined) {
    throw new Error('integration harness was not initialized');
  }

  return harness;
}

async function seedExpiredStoreCandidate(
  harness: IntegrationHarness,
  userId: string,
): Promise<ExpiredStoreCandidate> {
  const purchaseMs = Date.now() - 31 * ONE_DAY_MS;
  const candidate = {
    userId,
    purchaseMs,
    expiresAt: new Date(purchaseMs + MONTH_MS),
  };

  await applySingleStoreEvent(
    harness,
    storeEvent({
      eventId: `${userId}-initial-purchase`,
      userId,
      type: 'INITIAL_PURCHASE',
      eventTimeMs: purchaseMs,
    }),
  );
  await markCanonicalAsExpiredStore(harness, candidate);

  return candidate;
}

async function markCanonicalAsExpiredStore(
  harness: IntegrationHarness,
  candidate: ExpiredStoreCandidate,
): Promise<void> {
  await harness.db
    .updateTable('canonical_entitlements')
    .set({
      active: true,
      source: 'STORE',
      expires_at: candidate.expiresAt,
      last_changed_at: new Date(candidate.purchaseMs),
      reason: 'INITIAL_PURCHASE',
    })
    .where('user_id', '=', candidate.userId)
    .execute();
}

async function applySingleStoreEvent(
  harness: IntegrationHarness,
  event: StoreEventInput,
): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    await applyStoreEvent(trx, event);
  });
}

function storeEvent(input: {
  eventId: string;
  userId: string;
  type: StoreEventInput['type'];
  eventTimeMs: number;
}): StoreEventInput {
  return {
    eventId: input.eventId,
    userId: input.userId,
    type: input.type,
    eventTimeMs: input.eventTimeMs,
    productId: 'premium_monthly',
  };
}

async function seedSource(
  harness: IntegrationHarness,
  input: SeedSourceEntitlementInput,
): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    const transactionNow = await getTransactionNow(trx);
    await upsertSeedSourceEntitlement(trx, input, transactionNow);
  });
}

function carrierGrant(userId: string): SeedSourceEntitlementInput {
  return {
    userId,
    source: 'CARRIER',
    active: true,
    expiresAt: null,
    reason: 'CARRIER_ACTIVE',
  };
}

async function insertPendingExpiryNotification(
  harness: IntegrationHarness,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await harness.db
    .insertInto('notifications')
    .values({
      user_id: userId,
      type: 'PREMIUM_EXPIRES_SOON',
      expires_at: expiresAt,
      scheduled_for: new Date(expiresAt.getTime() - ONE_DAY_MS),
      sent_at: null,
    })
    .execute();
}

async function withHeldUserLock(
  harness: IntegrationHarness,
  userId: string,
  callback: () => Promise<void>,
): Promise<void> {
  let releaseLock: () => void = () => undefined;
  const releasePromise = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let markLocked: () => void = () => undefined;
  const lockedPromise = new Promise<void>((resolve) => {
    markLocked = resolve;
  });

  const lockTask = harness.db.transaction().execute(async (trx) => {
    await acquireUserEntitlementLock(trx, userId);
    markLocked();
    await releasePromise;
  });

  await lockedPromise;
  try {
    await callback();
  } finally {
    releaseLock();
    await lockTask;
  }
}

async function selectSource(
  harness: IntegrationHarness,
  userId: string,
  source: EntitlementSource,
): Promise<SourceEntitlement> {
  return harness.db
    .selectFrom('source_entitlements')
    .selectAll()
    .where('user_id', '=', userId)
    .where('source', '=', source)
    .executeTakeFirstOrThrow();
}

async function selectCanonical(harness: IntegrationHarness, userId: string) {
  return harness.db
    .selectFrom('canonical_entitlements')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

async function selectNotifications(
  harness: IntegrationHarness,
  userId: string,
): Promise<Notification[]> {
  return harness.db
    .selectFrom('notifications')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('expires_at', 'asc')
    .execute();
}
