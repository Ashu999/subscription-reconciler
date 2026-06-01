import { readConfig } from '../src/config.js';
import { createDb } from '../src/db/factory.js';
import { runMigrations } from '../src/db/migrations/runner.js';
import { getTransactionNow } from '../src/db/transactions.js';
import {
  type SeedSourceEntitlementInput,
  upsertSeedSourceEntitlement,
} from '../src/engine/seed-entitlement.js';

const fixtures: SeedSourceEntitlementInput[] = [
  {
    userId: 'u_carrier_active',
    source: 'CARRIER',
    active: true,
    expiresAt: null,
    reason: 'CARRIER_ACTIVE',
  },
  {
    userId: 'u_marketplace_active',
    source: 'MARKETPLACE',
    active: true,
    expiresAt: null,
    reason: 'MARKETPLACE_GRANT',
  },
  {
    userId: 'u_dual_source',
    source: 'MARKETPLACE',
    active: true,
    expiresAt: null,
    reason: 'MARKETPLACE_GRANT',
  },
  {
    userId: 'u_dual_source',
    source: 'CARRIER',
    active: true,
    expiresAt: null,
    reason: 'CARRIER_ACTIVE',
  },
];

/**
 * What: Seed representative carrier and marketplace entitlements.
 * Why: Local runs need quick sample users that exercise source precedence and carrier
 * polling without calling the public webhooks first.
 */
async function main(): Promise<void> {
  const config = readConfig();
  const db = createDb(config.databaseUrl);

  try {
    await runMigrations(db);

    for (const fixture of fixtures) {
      // Use the same locked mutation path as production updates so seed data also
      // produces canonical rows, notifications, and carrier poll locks.
      const canonical = await db.transaction().execute(async (trx) => {
        const now = await getTransactionNow(trx);
        return upsertSeedSourceEntitlement(trx, fixture, now);
      });
      console.info(
        `Seeded ${fixture.source} grant for ${fixture.userId}; canonical source=${canonical.source}`,
      );
    }
  } finally {
    await db.destroy();
  }
}

// Keep the script friendly for one-off CLI use by printing failures and setting
// the process exit code instead of swallowing errors.
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
