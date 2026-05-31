import { readConfig } from '../src/config.js';
import { createDb } from '../src/db/factory.js';
import { runMigrations } from '../src/db/migrations/runner.js';
import {
  getTransactionNow,
  upsertSeedSourceEntitlement,
  type SeedSourceEntitlementInput,
} from '../src/engine/entitlement.js';

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

async function main(): Promise<void> {
  const config = readConfig();
  const db = createDb(config.databaseUrl);

  try {
    await runMigrations(db);

    for (const fixture of fixtures) {
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
