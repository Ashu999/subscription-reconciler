import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';

import type { CanonicalEntitlement, Database } from '../../db/types.js';
import {
  serializeCanonicalEntitlementForResponse,
  serializeCanonicalEntitlementRowForResponse,
} from '../../db/types.js';
import {
  acquireUserEntitlementLock,
  getTransactionNow,
  recomputeCanonical,
} from '../../engine/entitlement.js';
import { syncExpiryNotification } from '../../engine/notifications.js';

interface EntitlementParams {
  id: string;
}

const entitlementParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1 },
  },
} as const;

const unknownEntitlementResponse = {
  active: false,
  source: 'NONE',
  expiresAt: null,
  lastChangedAt: null,
  reason: 'NO_ENTITLEMENT',
} as const;

export async function registerUserEntitlementRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
): Promise<void> {
  app.get<{ Params: EntitlementParams }>(
    '/users/:id/entitlement',
    {
      schema: {
        params: entitlementParamsSchema,
      },
    },
    async (request) => {
      const canonicalRow = await selectCanonicalEntitlementForRead(db, request.params.id);
      if (canonicalRow === undefined) {
        return unknownEntitlementResponse;
      }

      if (!canonicalRow.needs_refresh) {
        return serializeCanonicalEntitlementRowForResponse(canonicalRow);
      }

      return serializeCanonicalEntitlementForResponse(
        await refreshCanonicalEntitlementForRead(db, request.params.id),
      );
    },
  );
}

interface CanonicalEntitlementReadRow extends CanonicalEntitlement {
  needs_refresh: boolean;
}

async function selectCanonicalEntitlementForRead(
  db: Kysely<Database>,
  userId: string,
): Promise<CanonicalEntitlementReadRow | undefined> {
  return db
    .selectFrom('canonical_entitlements')
    .selectAll()
    .select(
      sql<boolean>`
        active = true
        and expires_at is not null
        and expires_at <= now()
      `.as('needs_refresh'),
    )
    .where('user_id', '=', userId)
    .executeTakeFirst();
}

async function refreshCanonicalEntitlementForRead(db: Kysely<Database>, userId: string) {
  return db.transaction().execute(async (trx) => {
    await acquireUserEntitlementLock(trx, userId);

    const transactionNow = await getTransactionNow(trx);
    const canonicalRow = await recomputeCanonical(trx, userId, transactionNow);
    await syncExpiryNotification(trx, canonicalRow, transactionNow);

    return canonicalRow;
  });
}
