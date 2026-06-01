import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '../../db/schema.js';
import {
  MAX_JS_DATE_MS,
  MIN_JS_DATE_MS,
  PRODUCT_IDS,
  STORE_EVENT_TYPES,
} from '../../domain/constants.js';
import type { ProductId, StoreEventType } from '../../domain/types.js';
import { applyStoreEvent } from '../../engine/store-entitlement.js';
import { serializeCanonicalEntitlementForResponse } from '../../http/serializers.js';

interface StoreWebhookBody {
  eventId: string;
  userId: string;
  type: StoreEventType;
  eventTimeMs: number;
  productId: ProductId;
}

const storeWebhookBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['eventId', 'userId', 'type', 'eventTimeMs', 'productId'],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    userId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: STORE_EVENT_TYPES },
    eventTimeMs: {
      type: 'integer',
      minimum: MIN_JS_DATE_MS,
      maximum: MAX_JS_DATE_MS,
    },
    productId: { type: 'string', enum: PRODUCT_IDS },
  },
} as const;

/**
 * What: Register store webhook ingestion.
 * Why: Store delivery is at-least-once and unordered, so accepted events are persisted
 * and replayed in a transaction before returning canonical state.
 */
export async function registerStoreWebhookRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
): Promise<void> {
  app.post<{ Body: StoreWebhookBody }>(
    '/webhooks/store',
    {
      schema: {
        body: storeWebhookBodySchema,
      },
    },
    async (request) => {
      // The transaction keeps raw event idempotency, source recompute, canonical
      // recompute, and notification sync as one committed change.
      const result = await db.transaction().execute((trx) => applyStoreEvent(trx, request.body));

      if (result.status === 'duplicate') {
        return { status: 'duplicate' };
      }

      return {
        status: 'applied',
        entitlement: serializeCanonicalEntitlementForResponse(result.canonicalRow),
      };
    },
  );
}
