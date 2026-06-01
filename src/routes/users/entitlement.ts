import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { selectCanonicalEntitlementForRead } from '../../db/repositories/canonical-entitlements.js';
import type { Database } from '../../db/schema.js';
import { acquireUserEntitlementLock } from '../../db/transactions.js';
import { recomputeCanonicalAndSyncNotifications } from '../../engine/recompute.js';
import {
  serializeCanonicalEntitlementForResponse,
  serializeCanonicalEntitlementRowForResponse,
} from '../../http/serializers.js';

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

/**
 * What: Register the entitlement read endpoint for a user.
 * Why: Clients need one canonical answer, and expired stored rows should be refreshed
 * before the response is returned.
 */
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

      // Refresh on read closes the small gap between an expiry timestamp passing
      // and the background reconciler's next run.
      return serializeCanonicalEntitlementForResponse(
        await refreshCanonicalEntitlementForRead(db, request.params.id),
      );
    },
  );
}

/**
 * What: Recompute a user's canonical entitlement during a read request.
 * Why: A per-user lock keeps this refresh consistent with webhooks and background jobs
 * that may update the same entitlement state.
 */
async function refreshCanonicalEntitlementForRead(db: Kysely<Database>, userId: string) {
  return db.transaction().execute(async (trx) => {
    await acquireUserEntitlementLock(trx, userId);

    return recomputeCanonicalAndSyncNotifications(trx, userId);
  });
}
