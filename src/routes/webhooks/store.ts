import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database, ProductId, StoreEventType } from '../../db/types.js';
import { serializeCanonicalEntitlementForResponse } from '../../db/types.js';
import { applyStoreEvent } from '../../engine/entitlement.js';

const STORE_EVENT_TYPES = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'CANCELLATION',
  'BILLING_ISSUE',
  'EXPIRATION',
  'UN_CANCELLATION',
] as const satisfies readonly StoreEventType[];
const PRODUCT_IDS = ['premium_monthly'] as const satisfies readonly ProductId[];
const MIN_JS_DATE_MS = -8_640_000_000_000_000;
const MAX_JS_DATE_MS = 8_640_000_000_000_000;

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
