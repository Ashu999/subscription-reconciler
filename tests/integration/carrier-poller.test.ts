import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  EntitlementSource,
  SourceEntitlement,
} from '../../src/db/types.js';
import {
  applyStoreEvent,
  getTransactionNow,
  upsertSeedSourceEntitlement,
  type SeedSourceEntitlementInput,
} from '../../src/engine/entitlement.js';
import { runCarrierPoller } from '../../src/jobs/carrier-poller.js';
import { FakeCarrierClient } from '../helpers/fake-carrier-client.js';
import type { FakeCarrierOutcome } from '../helpers/fake-carrier-client.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness } from '../helpers/integration.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

describe('carrier poller', () => {
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

  it('self-heals missing poll locks and polls CARRIER rows hidden behind STORE', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_hidden_carrier';
    await seedSource(currentHarness, carrierGrant(userId));
    await seedStoreEntitlement(currentHarness, userId);
    await deleteCarrierPollLock(currentHarness, userId);

    const before = new Date();
    const carrierClient = new FakeCarrierClient();
    const result = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient,
      workerId: 'worker-hidden',
    });

    expect(result.claimedCount).toBe(1);
    expect(carrierClient.calls).toEqual([userId]);

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');

    const lock = await selectCarrierPollLock(currentHarness, userId);
    expect(lock.locked_by).toBeNull();
    expect(lock.lease_until).toBeNull();
    expect(lock.last_polled_at?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(lock.next_poll_at.getTime()).toBeGreaterThan(before.getTime());
  });

  it('deactivates inactive CARRIER sources, recomputes canonical state, and removes poll locks', async () => {
    const currentHarness = requireHarness(harness);
    const carrierOnlyUserId = 'user_carrier_inactive';
    const hiddenCarrierUserId = 'user_hidden_carrier_inactive';
    await seedSource(currentHarness, carrierGrant(carrierOnlyUserId));
    await seedSource(currentHarness, carrierGrant(hiddenCarrierUserId));
    await seedStoreEntitlement(currentHarness, hiddenCarrierUserId);

    const carrierClient = new FakeCarrierClient(
      new Map([
        [carrierOnlyUserId, 'inactive'],
        [hiddenCarrierUserId, 'inactive'],
      ]),
    );
    const result = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient,
      workerId: 'worker-inactive',
    });

    expect(result.inactiveCount).toBe(2);

    const carrierOnlySource = await selectSource(currentHarness, carrierOnlyUserId, 'CARRIER');
    expect(carrierOnlySource.active).toBe(false);
    expect(carrierOnlySource.reason).toBe('CARRIER_INACTIVE');
    expect(carrierOnlySource.expires_at).toBeNull();
    await expectNoCarrierPollLock(currentHarness, carrierOnlyUserId);

    const carrierOnlyCanonical = await selectCanonical(currentHarness, carrierOnlyUserId);
    expect(carrierOnlyCanonical.active).toBe(false);
    expect(carrierOnlyCanonical.source).toBe('NONE');
    expect(carrierOnlyCanonical.reason).toBe('CARRIER_INACTIVE');

    const hiddenCarrierSource = await selectSource(currentHarness, hiddenCarrierUserId, 'CARRIER');
    expect(hiddenCarrierSource.active).toBe(false);
    expect(hiddenCarrierSource.reason).toBe('CARRIER_INACTIVE');
    await expectNoCarrierPollLock(currentHarness, hiddenCarrierUserId);

    const hiddenCanonical = await selectCanonical(currentHarness, hiddenCarrierUserId);
    expect(hiddenCanonical.active).toBe(true);
    expect(hiddenCanonical.source).toBe('STORE');
  });

  it('leaves entitlement state unchanged for api_error and thrown carrier failures', async () => {
    const currentHarness = requireHarness(harness);
    const apiErrorUserId = 'user_carrier_api_error';
    const thrownErrorUserId = 'user_carrier_timeout';
    await seedSource(currentHarness, carrierGrant(apiErrorUserId));
    await seedSource(currentHarness, carrierGrant(thrownErrorUserId));

    const apiErrorSourceBefore = await selectSource(currentHarness, apiErrorUserId, 'CARRIER');
    const thrownSourceBefore = await selectSource(currentHarness, thrownErrorUserId, 'CARRIER');
    const apiErrorCanonicalBefore = await selectCanonical(currentHarness, apiErrorUserId);
    const thrownCanonicalBefore = await selectCanonical(currentHarness, thrownErrorUserId);

    const carrierClient = new FakeCarrierClient(
      new Map<string, FakeCarrierOutcome>([
        [apiErrorUserId, 'api_error'],
        [thrownErrorUserId, new Error('carrier request timed out')],
      ]),
    );
    const result = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient,
      workerId: 'worker-api-error',
    });

    expect(result.apiErrorCount).toBe(2);
    expect(await selectSource(currentHarness, apiErrorUserId, 'CARRIER')).toEqual(
      apiErrorSourceBefore,
    );
    expect(await selectSource(currentHarness, thrownErrorUserId, 'CARRIER')).toEqual(
      thrownSourceBefore,
    );
    expect(await selectCanonical(currentHarness, apiErrorUserId)).toEqual(apiErrorCanonicalBefore);
    expect(await selectCanonical(currentHarness, thrownErrorUserId)).toEqual(thrownCanonicalBefore);
    await expectReleasedAndAdvancedLock(currentHarness, apiErrorUserId);
    await expectReleasedAndAdvancedLock(currentHarness, thrownErrorUserId);
  });

  it('claims disjoint user sets across concurrent poller workers', async () => {
    const currentHarness = requireHarness(harness);
    const userIds = Array.from(
      { length: 60 },
      (_, index) => `user_concurrent_carrier_${String(index).padStart(2, '0')}`,
    );
    await seedSources(
      currentHarness,
      userIds.map((userId) => carrierGrant(userId)),
    );

    const carrierClient = new FakeCarrierClient(new Map(), { delayMs: 20 });
    const [firstResult, secondResult] = await Promise.all([
      runCarrierPoller({
        db: currentHarness.db,
        carrierClient,
        workerId: 'worker-concurrent-a',
      }),
      runCarrierPoller({
        db: currentHarness.db,
        carrierClient,
        workerId: 'worker-concurrent-b',
      }),
    ]);

    expect(firstResult.claimedCount + secondResult.claimedCount).toBe(60);
    expect(carrierClient.calls).toHaveLength(60);
    expect(new Set(carrierClient.calls).size).toBe(60);
  });

  it('limits each poller worker to 10 in-flight carrier calls', async () => {
    const currentHarness = requireHarness(harness);
    const userIds = Array.from(
      { length: 12 },
      (_, index) => `user_concurrency_limit_${String(index).padStart(2, '0')}`,
    );
    await seedSources(
      currentHarness,
      userIds.map((userId) => carrierGrant(userId)),
    );

    const carrierClient = new FakeCarrierClient(new Map(), { delayMs: 20 });
    const result = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient,
      workerId: 'worker-limit',
    });

    expect(result.claimedCount).toBe(12);
    expect(carrierClient.calls).toHaveLength(12);
    expect(carrierClient.maxInFlight).toBeLessThanOrEqual(10);
  });

  it('recovers expired leases without stealing unexpired leases', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_lease_recovery';
    await seedSource(currentHarness, carrierGrant(userId));
    await setCarrierPollLease(currentHarness, userId, {
      lockedBy: 'old-worker',
      leaseUntil: new Date(Date.now() + ONE_DAY_MS),
      nextPollAt: new Date(Date.now() - ONE_DAY_MS),
    });

    const unexpiredLeaseClient = new FakeCarrierClient();
    const unexpiredResult = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient: unexpiredLeaseClient,
      workerId: 'worker-lease-current',
    });
    expect(unexpiredResult.claimedCount).toBe(0);
    expect(unexpiredLeaseClient.calls).toHaveLength(0);

    await setCarrierPollLease(currentHarness, userId, {
      lockedBy: 'old-worker',
      leaseUntil: new Date(Date.now() - ONE_DAY_MS),
      nextPollAt: new Date(Date.now() - ONE_DAY_MS),
    });

    const expiredLeaseClient = new FakeCarrierClient();
    const expiredResult = await runCarrierPoller({
      db: currentHarness.db,
      carrierClient: expiredLeaseClient,
      workerId: 'worker-lease-recovery',
    });

    expect(expiredResult.claimedCount).toBe(1);
    expect(expiredLeaseClient.calls).toEqual([userId]);
    await expectReleasedAndAdvancedLock(currentHarness, userId);
  });

  it('creates carrier poll locks when seeding active CARRIER grants', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_seeded_carrier_lock';
    await seedSource(currentHarness, carrierGrant(userId));

    const lock = await selectCarrierPollLock(currentHarness, userId);
    expect(lock.user_id).toBe(userId);
    expect(lock.locked_by).toBeNull();
    expect(lock.lease_until).toBeNull();
    expect(lock.last_polled_at).toBeNull();
  });
});

function requireHarness(harness: IntegrationHarness | undefined): IntegrationHarness {
  if (harness === undefined) {
    throw new Error('integration harness was not initialized');
  }

  return harness;
}

async function seedSource(
  harness: IntegrationHarness,
  input: SeedSourceEntitlementInput,
): Promise<void> {
  await seedSources(harness, [input]);
}

async function seedSources(
  harness: IntegrationHarness,
  inputs: readonly SeedSourceEntitlementInput[],
): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    const transactionNow = await getTransactionNow(trx);
    for (const input of inputs) {
      await upsertSeedSourceEntitlement(trx, input, transactionNow);
    }
  });
}

async function seedStoreEntitlement(harness: IntegrationHarness, userId: string): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    await applyStoreEvent(trx, {
      eventId: `${userId}-renewal`,
      userId,
      type: 'RENEWAL',
      eventTimeMs: Date.now() + ONE_DAY_MS,
      productId: 'premium_monthly',
    });
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

async function selectCarrierPollLock(harness: IntegrationHarness, userId: string) {
  return harness.db
    .selectFrom('carrier_poll_locks')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

async function deleteCarrierPollLock(
  harness: IntegrationHarness,
  userId: string,
): Promise<void> {
  await harness.db
    .deleteFrom('carrier_poll_locks')
    .where('user_id', '=', userId)
    .execute();
}

async function expectNoCarrierPollLock(
  harness: IntegrationHarness,
  userId: string,
): Promise<void> {
  const row = await harness.db
    .selectFrom('carrier_poll_locks')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirst();
  expect(row).toBeUndefined();
}

async function expectReleasedAndAdvancedLock(
  harness: IntegrationHarness,
  userId: string,
): Promise<void> {
  const lock = await selectCarrierPollLock(harness, userId);
  expect(lock.locked_by).toBeNull();
  expect(lock.lease_until).toBeNull();
  expect(lock.last_polled_at).toBeInstanceOf(Date);
  expect(lock.next_poll_at.getTime()).toBeGreaterThan(lock.last_polled_at?.getTime() ?? 0);
}

async function setCarrierPollLease(
  harness: IntegrationHarness,
  userId: string,
  input: { lockedBy: string; leaseUntil: Date; nextPollAt: Date },
): Promise<void> {
  await harness.db
    .updateTable('carrier_poll_locks')
    .set({
      locked_by: input.lockedBy,
      lease_until: input.leaseUntil,
      next_poll_at: input.nextPollAt,
    })
    .where('user_id', '=', userId)
    .execute();
}
