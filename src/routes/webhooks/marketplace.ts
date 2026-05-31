import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/types.js';
import {
  MarketplaceRevokePartialFailureError,
  revokeMarketplaceEntitlements,
} from '../../engine/entitlement.js';

interface MarketplaceRevokeBody {
  userIds: string[];
}

const marketplaceRevokeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userIds'],
  properties: {
    userIds: {
      type: 'array',
      maxItems: 10_000,
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;

export async function registerMarketplaceWebhookRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
): Promise<void> {
  app.post<{ Body: MarketplaceRevokeBody }>(
    '/webhooks/marketplace/revoke',
    {
      schema: {
        body: marketplaceRevokeBodySchema,
      },
    },
    async (request, reply) => {
      try {
        return await revokeMarketplaceEntitlements(db, request.body.userIds);
      } catch (error) {
        if (error instanceof MarketplaceRevokePartialFailureError) {
          reply.code(500);
          return error.response;
        }

        throw error;
      }
    },
  );
}
