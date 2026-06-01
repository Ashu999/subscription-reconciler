import { mapCanonicalEntitlementForDomain } from '../db/mappers.js';
import type { CanonicalEntitlement } from '../db/schema.js';
import type {
  CanonicalEntitlementForDomain,
  CanonicalEntitlementSource,
  EntitlementReason,
} from '../domain/types.js';

export interface CanonicalEntitlementResponse {
  active: boolean;
  source: CanonicalEntitlementSource;
  expiresAt: string | null;
  lastChangedAt: string | null;
  reason: EntitlementReason;
}

/**
 * What: Serialize a domain entitlement into the public API response shape.
 * Why: API callers should receive ISO strings and nulls, not Date objects.
 */
export function serializeCanonicalEntitlementForResponse(
  row: CanonicalEntitlementForDomain,
): CanonicalEntitlementResponse {
  return {
    active: row.active,
    source: row.source,
    expiresAt: serializeNullableTimestamp(row.expiresAt),
    lastChangedAt: serializeNullableTimestamp(row.lastChangedAt),
    reason: row.reason,
  };
}

/**
 * What: Serialize a database canonical entitlement row for HTTP responses.
 * Why: Read routes can return stored rows without manually mapping and formatting each
 * timestamp field.
 */
export function serializeCanonicalEntitlementRowForResponse(
  row: CanonicalEntitlement,
): CanonicalEntitlementResponse {
  return serializeCanonicalEntitlementForResponse(mapCanonicalEntitlementForDomain(row));
}

/**
 * What: Convert a Date into an ISO timestamp string after validation.
 * Why: Invalid Date values stringify poorly and should fail before reaching an API
 * response.
 */
export function serializeTimestamp(value: Date): string {
  assertValidDate(value, 'timestamp');
  return value.toISOString();
}

/**
 * What: Convert nullable Date values into API-safe timestamp fields.
 * Why: Entitlements may be open-ended or absent, and the response contract uses null
 * for those cases.
 */
export function serializeNullableTimestamp(value: Date | null): string | null {
  return value === null ? null : serializeTimestamp(value);
}

/**
 * What: Assert that a Date object represents a real timestamp.
 * Why: API serialization should fail loudly instead of returning "Invalid Date" style
 * values to clients.
 */
function assertValidDate(value: Date, fieldName: string): void {
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}
