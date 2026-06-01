import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../../db/schema.js';
import { MARKETPLACE_REVOKE_MAX_USER_IDS } from '../../domain/constants.js';
import {
  MarketplaceRevokePartialFailureError,
  revokeMarketplaceEntitlements,
} from '../../engine/marketplace-entitlement.js';

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
      maxItems: MARKETPLACE_REVOKE_MAX_USER_IDS,
      items: { type: 'string', minLength: 1 },
    },
  },
} as const;

/**
 * What: Register the marketplace bulk revoke endpoint.
 * Why: Marketplace revokes can be large and partially committed in chunks, so the route
 * translates retryable partial failures into the documented response shape.
 */
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
          // Earlier chunks are already committed; callers can safely retry the
          // whole request because revoking an already-inactive row is idempotent.
          reply.code(500);
          return error.response;
        }

        throw error;
      }
    },
  );
}
