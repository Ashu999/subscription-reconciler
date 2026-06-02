import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';

import type { AppConfig } from './config.js';
import type { Database } from './db/schema.js';
import { registerUserEntitlementRoutes } from './routes/users/entitlement.js';
import { registerMarketplaceWebhookRoutes } from './routes/webhooks/marketplace.js';
import { registerStoreWebhookRoutes } from './routes/webhooks/store.js';

/**
 * What: Build the Fastify app with shared plugins, health checks, and routes.
 * Why: Tests and server startup should exercise the same wiring without duplicating
 * route registration or app configuration.
 */
export async function buildApp(db: Kysely<Database>, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
      },
    },
  });

  await app.register(sensible);

  // The health endpoint checks Postgres because entitlement reads and writes are
  // only useful when the backing database is reachable.
  app.get('/health', async () => {
    await sql`select 1`.execute(db);
    return { status: 'ok' };
  });

  await registerStoreWebhookRoutes(app, db);
  await registerMarketplaceWebhookRoutes(app, db);
  await registerUserEntitlementRoutes(app, db);

  return app;
}
