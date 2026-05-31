import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  CanonicalEntitlementResponse,
  EntitlementSource,
  SourceEntitlement,
} from '../../src/db/types.js';
import {
  applyStoreEvent,
  getTransactionNow,
  type SeedSourceEntitlementInput,
  type StoreEventInput,
  upsertSeedSourceEntitlement,
} from '../../src/engine/entitlement.js';
import { runCarrierPoller } from '../../src/jobs/carrier-poller.js';
import { FakeCarrierClient } from '../helpers/fake-carrier-client.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness } from '../helpers/integration.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * ONE_DAY_MS;

describe('GET /users/:id/entitlement', () => {
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

  it('returns an inactive NONE entitlement for unknown users', async () => {
    const response = await getEntitlement(requireHarness(harness), 'unknown_user');

    expect(response.statusCode).toBe(200);
    expect(response.json<CanonicalEntitlementResponse>()).toEqual({
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: null,
      reason: 'NO_ENTITLEMENT',
    });
  });

  it('reads canonical state after STORE, MARKETPLACE, and CARRIER writes', async () => {
    const currentHarness = requireHarness(harness);
    const storeUserId = 'user_read_store';
    const marketplaceUserId = 'user_read_marketplace';
    const carrierUserId = 'user_read_carrier';
    const renewalMs = Date.now() + ONE_DAY_MS;

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'read-store-renewal',
        userId: storeUserId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );
    await seedSource(currentHarness, marketplaceGrant(marketplaceUserId));
    await seedSource(currentHarness, carrierGrant(carrierUserId));

    expect(
      (await getEntitlement(currentHarness, storeUserId)).json<CanonicalEntitlementResponse>(),
    ).toEqual({
      active: true,
      source: 'STORE',
      expiresAt: new Date(renewalMs + MONTH_MS).toISOString(),
      lastChangedAt: new Date(renewalMs).toISOString(),
      reason: 'RENEWAL',
    });
    expect(
      (
        await getEntitlement(currentHarness, marketplaceUserId)
      ).json<CanonicalEntitlementResponse>(),
    ).toMatchObject({
      active: true,
      source: 'MARKETPLACE',
      expiresAt: null,
      reason: 'MARKETPLACE_GRANT',
    });
    expect(
      (await getEntitlement(currentHarness, carrierUserId)).json<CanonicalEntitlementResponse>(),
    ).toMatchObject({
      active: true,
      source: 'CARRIER',
      expiresAt: null,
      reason: 'CARRIER_ACTIVE',
    });

    const carrierClient = new FakeCarrierClient(new Map([[carrierUserId, 'inactive']]));
    await runCarrierPoller({
      db: currentHarness.db,
      carrierClient,
      workerId: 'read-endpoint-carrier',
    });

    expect(
      (await getEntitlement(currentHarness, carrierUserId)).json<CanonicalEntitlementResponse>(),
    ).toMatchObject({
      active: false,
      source: 'NONE',
      expiresAt: null,
      reason: 'CARRIER_INACTIVE',
    });

    const revokeResponse = await postMarketplaceRevoke(currentHarness, [marketplaceUserId]);
    expect(revokeResponse.statusCode).toBe(200);
    expect(
      (
        await getEntitlement(currentHarness, marketplaceUserId)
      ).json<CanonicalEntitlementResponse>(),
    ).toMatchObject({
      active: false,
      source: 'NONE',
      expiresAt: null,
      reason: 'MARKETPLACE_REVOKE',
    });
  });

  it('refreshes expired canonical rows before returning a response', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_read_expired_guard';
    const purchaseMs = Date.now() - 31 * ONE_DAY_MS;
    const expiresAt = new Date(purchaseMs + MONTH_MS);

    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'read-guard-initial-purchase',
        userId,
        type: 'INITIAL_PURCHASE',
        eventTimeMs: purchaseMs,
      }),
    );
    await markCanonicalAsExpiredStore(currentHarness, {
      userId,
      purchaseMs,
      expiresAt,
    });
    await insertPendingExpiryNotification(currentHarness, userId, expiresAt);

    const response = await getEntitlement(currentHarness, userId);

    expect(response.statusCode).toBe(200);
    expect(response.json<CanonicalEntitlementResponse>()).toEqual({
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: expiresAt.toISOString(),
      reason: 'EXPIRATION',
    });
    expect(await selectNotifications(currentHarness, userId)).toHaveLength(0);

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(false);
    expect(canonical.source).toBe('NONE');
    expect(canonical.reason).toBe('EXPIRATION');
    expect(canonical.last_changed_at).toEqual(expiresAt);
  });

  it('returns STORE after marketplace revoke when both sources were active', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_read_store_marketplace';
    const renewalMs = Date.now() + ONE_DAY_MS;

    await seedSource(currentHarness, marketplaceGrant(userId));
    await applySingleStoreEvent(
      currentHarness,
      storeEvent({
        eventId: 'read-fallback-renewal',
        userId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );

    const before = await getEntitlement(currentHarness, userId);
    expect(before.json<CanonicalEntitlementResponse>()).toMatchObject({
      active: true,
      source: 'STORE',
      reason: 'RENEWAL',
    });

    const revokeResponse = await postMarketplaceRevoke(currentHarness, [userId]);
    expect(revokeResponse.statusCode).toBe(200);

    expect(
      (await getEntitlement(currentHarness, userId)).json<CanonicalEntitlementResponse>(),
    ).toEqual({
      active: true,
      source: 'STORE',
      expiresAt: new Date(renewalMs + MONTH_MS).toISOString(),
      lastChangedAt: new Date(renewalMs).toISOString(),
      reason: 'RENEWAL',
    });

    const marketplaceSource = await selectSource(currentHarness, userId, 'MARKETPLACE');
    expect(marketplaceSource.active).toBe(false);
    expect(marketplaceSource.reason).toBe('MARKETPLACE_REVOKE');
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

function getEntitlement(harness: IntegrationHarness, userId: string) {
  return harness.app.inject({
    method: 'GET',
    url: `/users/${encodeURIComponent(userId)}/entitlement`,
  });
}

function postMarketplaceRevoke(harness: IntegrationHarness, userIds: string[]) {
  return harness.app.inject({
    method: 'POST',
    url: '/webhooks/marketplace/revoke',
    payload: { userIds },
  });
}

async function applySingleStoreEvent(
  harness: IntegrationHarness,
  event: StoreEventInput,
): Promise<void> {
  await harness.db.transaction().execute(async (trx) => {
    await applyStoreEvent(trx, event);
  });
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

function marketplaceGrant(userId: string): SeedSourceEntitlementInput {
  return {
    userId,
    source: 'MARKETPLACE',
    active: true,
    expiresAt: null,
    reason: 'MARKETPLACE_GRANT',
  };
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

async function selectNotifications(harness: IntegrationHarness, userId: string) {
  return harness.db
    .selectFrom('notifications')
    .selectAll()
    .where('user_id', '=', userId)
    .orderBy('expires_at', 'asc')
    .execute();
}
