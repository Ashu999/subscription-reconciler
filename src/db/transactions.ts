import { sql, type Transaction } from 'kysely';

import type { Database } from './schema.js';

/**
 * What: Serialize entitlement mutations for one user inside the current transaction.
 * Why: Source, canonical, and notification rows must move together without concurrent
 * workers observing or writing conflicting user state.
 */
export async function acquireUserEntitlementLock(
  trx: Transaction<Database>,
  userId: string,
): Promise<void> {
  // Let Postgres derive the lock key so every process uses the same stable hash.
  await sql`select pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`.execute(trx);
}

/**
 * What: Attempt the same per-user lock without waiting.
 * Why: Background jobs can skip busy users and let the request or worker that already
 * owns the state finish first.
 */
export async function tryAcquireUserEntitlementLock(
  trx: Transaction<Database>,
  userId: string,
): Promise<boolean> {
  const result = await sql<{ locked: boolean }>`
    select pg_try_advisory_xact_lock(hashtextextended(${userId}::text, 0)) as locked
  `.execute(trx);

  return result.rows[0]?.locked ?? false;
}

/**
 * What: Read the transaction timestamp from Postgres.
 * Why: Recompute paths should use one database clock value so expiry comparisons,
 * row timestamps, and notifications agree.
 */
export async function getTransactionNow(trx: Transaction<Database>): Promise<Date> {
  const result = await sql<{ now: Date }>`select now() as now`.execute(trx);
  const now = result.rows[0]?.now;
  if (now === undefined) {
    throw new Error('Postgres did not return transaction timestamp');
  }

  return now;
}
