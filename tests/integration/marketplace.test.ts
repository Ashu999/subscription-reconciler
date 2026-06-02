import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getTransactionNow } from '../../src/db/transactions.js';
import {
  applyStoreEvent,
  type SeedSourceEntitlementInput,
  upsertSeedSourceEntitlement,
} from '../../src/engine/entitlement.js';
import {
  selectActiveMarketplaceRows,
  selectCanonical,
  selectSource,
} from '../helpers/db-selectors.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface MarketplaceRevokeOkResponse {
  status: 'ok';
  requestedCount: number;
  uniqueUserCount: number;
  revokedCount: number;
}

type MarketplaceInjectPayload = NonNullable<InjectOptions['payload']>;

describe('POST /webhooks/marketplace/revoke', () => {
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

  it('revokes only active MARKETPLACE rows and reports deduplicated counts', async () => {
    const currentHarness = requireHarness(harness);
    await seedSource(currentHarness, marketplaceGrant('user_marketplace_a'));
    await seedSource(currentHarness, marketplaceGrant('user_marketplace_b'));
    await seedSource(currentHarness, carrierGrant('user_carrier_only'));
    await seedStoreEntitlement(currentHarness, 'user_store_only');

    const storeBefore = await selectSource(currentHarness, 'user_store_only', 'STORE');
    const carrierBefore = await selectSource(currentHarness, 'user_carrier_only', 'CARRIER');

    const response = await postMarketplaceRevoke(currentHarness, [
      'user_marketplace_a',
      'user_store_only',
      'user_carrier_only',
      'user_marketplace_b',
      'user_marketplace_a',
    ]);

    expect(response.statusCode).toBe(200);
    expect(response.json<MarketplaceRevokeOkResponse>()).toEqual({
      status: 'ok',
      requestedCount: 5,
      uniqueUserCount: 4,
      revokedCount: 2,
    });

    const revokedA = await selectSource(currentHarness, 'user_marketplace_a', 'MARKETPLACE');
    const revokedB = await selectSource(currentHarness, 'user_marketplace_b', 'MARKETPLACE');
    expect(revokedA.active).toBe(false);
    expect(revokedA.reason).toBe('MARKETPLACE_REVOKE');
    expect(revokedA.expires_at).toBeNull();
    expect(revokedB.active).toBe(false);
    expect(revokedB.reason).toBe('MARKETPLACE_REVOKE');

    expect(await selectSource(currentHarness, 'user_store_only', 'STORE')).toEqual(storeBefore);
    expect(await selectSource(currentHarness, 'user_carrier_only', 'CARRIER')).toEqual(
      carrierBefore,
    );

    const marketplaceCanonical = await selectCanonical(currentHarness, 'user_marketplace_a');
    expect(marketplaceCanonical.active).toBe(false);
    expect(marketplaceCanonical.source).toBe('NONE');
    expect(marketplaceCanonical.reason).toBe('MARKETPLACE_REVOKE');

    const storeCanonical = await selectCanonical(currentHarness, 'user_store_only');
    expect(storeCanonical.active).toBe(true);
    expect(storeCanonical.source).toBe('STORE');

    const carrierCanonical = await selectCanonical(currentHarness, 'user_carrier_only');
    expect(carrierCanonical.active).toBe(true);
    expect(carrierCanonical.source).toBe('CARRIER');
  });

  it('is idempotent when the same revoke request is retried', async () => {
    const currentHarness = requireHarness(harness);
    await seedSource(currentHarness, marketplaceGrant('user_retry'));

    const firstResponse = await postMarketplaceRevoke(currentHarness, ['user_retry']);
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json<MarketplaceRevokeOkResponse>().revokedCount).toBe(1);

    const secondResponse = await postMarketplaceRevoke(currentHarness, ['user_retry']);
    expect(secondResponse.statusCode).toBe(200);
    expect(secondResponse.json<MarketplaceRevokeOkResponse>()).toEqual({
      status: 'ok',
      requestedCount: 1,
      uniqueUserCount: 1,
      revokedCount: 0,
    });

    const source = await selectSource(currentHarness, 'user_retry', 'MARKETPLACE');
    expect(source.active).toBe(false);
    expect(source.reason).toBe('MARKETPLACE_REVOKE');
  });

  it('processes unique users across chunk boundaries', async () => {
    const currentHarness = requireHarness(harness);
    const userIds = Array.from(
      { length: 101 },
      (_, index) => `user_chunk_${String(index).padStart(3, '0')}`,
    );
    await seedSources(
      currentHarness,
      userIds.map((userId) => marketplaceGrant(userId)),
    );

    const duplicateUserId = userIds[0];
    if (duplicateUserId === undefined) {
      throw new Error('chunk test did not create any users');
    }

    const response = await postMarketplaceRevoke(currentHarness, [...userIds, duplicateUserId]);

    expect(response.statusCode).toBe(200);
    expect(response.json<MarketplaceRevokeOkResponse>()).toEqual({
      status: 'ok',
      requestedCount: 102,
      uniqueUserCount: 101,
      revokedCount: 101,
    });
    expect(await selectActiveMarketplaceRows(currentHarness, userIds)).toHaveLength(0);
  });

  it('rejects requests with more than 10000 user IDs before processing', async () => {
    const currentHarness = requireHarness(harness);
    const userIds = Array.from({ length: 10_001 }, (_, index) => `user_${index}`);

    const response = await postMarketplaceRevoke(currentHarness, userIds);

    expect(response.statusCode).toBe(400);
  });

  it('rejects malformed revoke requests before changing marketplace rows', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_marketplace_validation';
    await seedSource(currentHarness, marketplaceGrant(userId));

    const cases: Array<{ name: string; payload: MarketplaceInjectPayload }> = [
      {
        name: 'missing userIds',
        payload: {},
      },
      {
        name: 'userIds is not an array',
        payload: { userIds: userId },
      },
      {
        name: 'blank user ID',
        payload: { userIds: [userId, ''] },
      },
      {
        name: 'unknown property',
        payload: { userIds: [userId], ignored: true },
      },
    ];

    for (const currentCase of cases) {
      const response = await postMarketplaceRevokePayload(currentHarness, currentCase.payload);
      expect(response.statusCode, currentCase.name).toBe(400);
    }

    const source = await selectSource(currentHarness, userId, 'MARKETPLACE');
    expect(source.active).toBe(true);
    expect(source.reason).toBe('MARKETPLACE_GRANT');
  });

  it('falls back to STORE when a dual-source user loses MARKETPLACE access', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_store_marketplace';
    await seedSource(currentHarness, marketplaceGrant(userId));
    await seedStoreEntitlement(currentHarness, userId);

    const before = await selectCanonical(currentHarness, userId);
    expect(before.active).toBe(true);
    expect(before.source).toBe('STORE');

    const response = await postMarketplaceRevoke(currentHarness, [userId]);
    expect(response.statusCode).toBe(200);
    expect(response.json<MarketplaceRevokeOkResponse>().revokedCount).toBe(1);

    const marketplaceSource = await selectSource(currentHarness, userId, 'MARKETPLACE');
    expect(marketplaceSource.active).toBe(false);
    expect(marketplaceSource.reason).toBe('MARKETPLACE_REVOKE');

    const storeSource = await selectSource(currentHarness, userId, 'STORE');
    expect(storeSource.active).toBe(true);

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.reason).toBe('RENEWAL');
  });
});

function postMarketplaceRevoke(
  harness: IntegrationHarness,
  userIds: string[],
): Promise<LightMyRequestResponse> {
  return postMarketplaceRevokePayload(harness, { userIds });
}

function postMarketplaceRevokePayload(
  harness: IntegrationHarness,
  payload: MarketplaceInjectPayload,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: '/webhooks/marketplace/revoke',
    payload,
  });
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
