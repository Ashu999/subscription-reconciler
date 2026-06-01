import type { Kysely, Transaction } from 'kysely';

import { revokeActiveMarketplaceEntitlements } from '../db/repositories/source-entitlements.js';
import type { Database } from '../db/schema.js';
import { acquireUserEntitlementLock, getTransactionNow } from '../db/transactions.js';
import { MARKETPLACE_REVOKE_CHUNK_SIZE } from '../domain/constants.js';
import { recomputeCanonicalAndSyncNotifications } from './recompute.js';

export interface MarketplaceRevokeResult {
  status: 'ok';
  requestedCount: number;
  uniqueUserCount: number;
  revokedCount: number;
}

export interface MarketplaceRevokePartialFailureResponse {
  status: 'partial_failure';
  revokedCount: number;
  retryable: true;
}

export class MarketplaceRevokePartialFailureError extends Error {
  readonly response: MarketplaceRevokePartialFailureResponse;

  constructor(response: MarketplaceRevokePartialFailureResponse, options: { cause: unknown }) {
    super('Marketplace revoke failed after one or more chunks committed', options);
    this.name = 'MarketplaceRevokePartialFailureError';
    this.response = response;
  }
}

/**
 * What: Revoke marketplace access for up to a large request set in safe chunks.
 * Why: Chunking keeps lock lifetimes bounded while idempotent counts let callers retry
 * a full request after partial progress.
 */
export async function revokeMarketplaceEntitlements(
  db: Kysely<Database>,
  userIds: readonly string[],
): Promise<MarketplaceRevokeResult> {
  // Sorting gives overlapping bulk requests the same lock order and avoids
  // deadlocks when they touch some of the same users.
  const uniqueUserIds = [...new Set(userIds)].sort(compareLexicographically);
  let revokedCount = 0;

  for (
    let chunkStart = 0;
    chunkStart < uniqueUserIds.length;
    chunkStart += MARKETPLACE_REVOKE_CHUNK_SIZE
  ) {
    const chunkUserIds = uniqueUserIds.slice(
      chunkStart,
      chunkStart + MARKETPLACE_REVOKE_CHUNK_SIZE,
    );

    try {
      const chunkRevokedCount = await db
        .transaction()
        .execute((trx) => revokeMarketplaceChunk(trx, chunkUserIds));
      revokedCount += chunkRevokedCount;
    } catch (error) {
      if (chunkStart > 0) {
        // Earlier chunks already committed, so the only safe contract is a
        // retryable partial failure; retrying the full request is idempotent.
        throw new MarketplaceRevokePartialFailureError(
          {
            status: 'partial_failure',
            revokedCount,
            retryable: true,
          },
          { cause: error },
        );
      }

      throw error;
    }
  }

  return {
    status: 'ok',
    requestedCount: userIds.length,
    uniqueUserCount: uniqueUserIds.length,
    revokedCount,
  };
}

/**
 * What: Revoke one sorted chunk of marketplace users in a transaction.
 * Why: Each chunk must lock users before mutation, then recompute only users whose
 * active marketplace rows actually changed.
 */
async function revokeMarketplaceChunk(
  trx: Transaction<Database>,
  chunkUserIds: readonly string[],
): Promise<number> {
  if (chunkUserIds.length === 0) {
    return 0;
  }

  const transactionNow = await getTransactionNow(trx);
  for (const userId of chunkUserIds) {
    await acquireUserEntitlementLock(trx, userId);
  }

  const revokedUserIds = (
    await revokeActiveMarketplaceEntitlements(trx, chunkUserIds, transactionNow)
  ).sort(compareLexicographically);
  for (const userId of revokedUserIds) {
    await recomputeCanonicalAndSyncNotifications(trx, userId, transactionNow);
  }

  return revokedUserIds.length;
}

/**
 * What: Provide stable ascending string order for IDs.
 * Why: Locking users in the same order across workers reduces deadlock risk and makes
 * chunk processing deterministic.
 */
function compareLexicographically(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
