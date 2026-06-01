import type {
  CanonicalEntitlement,
  CarrierPollLock,
  EntitlementSource,
  Notification,
  SourceEntitlement,
} from '../../src/db/types.js';
import type { IntegrationHarness } from './integration.js';

export async function selectSource(
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

export async function selectStoreSource(
  harness: IntegrationHarness,
  userId: string,
): Promise<SourceEntitlement> {
  return selectSource(harness, userId, 'STORE');
}

export async function selectCanonical(
  harness: IntegrationHarness,
  userId: string,
): Promise<CanonicalEntitlement> {
  return harness.db
    .selectFrom('canonical_entitlements')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

export async function selectNotifications(
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

export async function selectStoreEventCount(
  harness: IntegrationHarness,
  userId: string,
): Promise<number> {
  const rows = await harness.db
    .selectFrom('store_events')
    .selectAll()
    .where('user_id', '=', userId)
    .execute();
  return rows.length;
}

export async function selectCarrierPollLock(
  harness: IntegrationHarness,
  userId: string,
): Promise<CarrierPollLock> {
  return harness.db
    .selectFrom('carrier_poll_locks')
    .selectAll()
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
}

export async function selectActiveMarketplaceRows(
  harness: IntegrationHarness,
  userIds: readonly string[],
): Promise<SourceEntitlement[]> {
  return harness.db
    .selectFrom('source_entitlements')
    .selectAll()
    .where('user_id', 'in', userIds)
    .where('source', '=', 'MARKETPLACE')
    .where('active', '=', true)
    .execute();
}
