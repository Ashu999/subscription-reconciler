import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';

import type { AppConfig } from './config.js';
import type { Database } from './db/types.js';
import { registerMarketplaceWebhookRoutes } from './routes/webhooks/marketplace.js';
import { registerStoreWebhookRoutes } from './routes/webhooks/store.js';

export async function buildApp(db: Kysely<Database>, config: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
  });

  await app.register(sensible);

  app.get('/health', async () => {
    await sql`select 1`.execute(db);
    return { status: 'ok' };
  });

  await registerStoreWebhookRoutes(app, db);
  await registerMarketplaceWebhookRoutes(app, db);

  return app;
}
