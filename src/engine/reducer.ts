import { ONE_DAY_MS } from '../domain/constants.js';
import type {
  EntitlementReason,
  ProductId,
  StoreEventForDomain,
  StoreEventType,
} from '../domain/types.js';

// Billing issues keep access alive briefly so a transient payment failure does
// not immediately remove a paid subscriber.
const BILLING_GRACE_MS = 7 * ONE_DAY_MS;
const PRODUCT_DURATIONS_MS: Record<ProductId, number> = {
  premium_monthly: 30 * ONE_DAY_MS,
};

export interface StoreProjection {
  active: boolean;
  reason: EntitlementReason;
  expiresAt: Date | null;
  lastChangedAt: Date | null;
}

export interface ReducedStoreProjection extends StoreProjection {
  lastEventMs: number | null;
  lastEventId: string | null;
}

export const EMPTY_STORE_PROJECTION: StoreProjection = {
  active: false,
  reason: 'NO_ENTITLEMENT',
  expiresAt: null,
  lastChangedAt: null,
};

/**
 * What: Apply one store lifecycle event to the current STORE projection.
 * Why: Keeping this pure lets webhook replay use business event time, not delivery
 * order or wall-clock time, for repeatable entitlement results.
 */
export function applyStoreEventType(
  type: StoreEventType,
  eventTimeMs: number,
  productId: ProductId,
  previousStoreProjection: StoreProjection,
): StoreProjection {
  const eventTime = dateFromEpochMs(eventTimeMs);
  const productExpiry = () => dateFromEpochMs(eventTimeMs + subscriptionDurationMs(productId));
  const withEvent = (active: boolean, expiresAt: Date | null): StoreProjection => ({
    active,
    expiresAt,
    lastChangedAt: eventTime,
    reason: type,
  });

  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
      return withEvent(true, productExpiry());
    case 'UN_CANCELLATION': {
      // Un-cancellation only restores an existing paid-through period; without
      // one, a purchase/renewal event must establish the next entitlement.
      const paidThroughExpiry = previousPaidThroughExpiry(previousStoreProjection, eventTimeMs);
      return paidThroughExpiry === null
        ? withEvent(false, null)
        : withEvent(true, paidThroughExpiry);
    }
    case 'BILLING_ISSUE':
      return applyBillingIssue(eventTimeMs, previousStoreProjection, withEvent);
    case 'CANCELLATION': {
      const paidThroughExpiry = previousPaidThroughExpiry(previousStoreProjection, eventTimeMs);
      return paidThroughExpiry === null
        ? withEvent(false, null)
        : withEvent(true, paidThroughExpiry);
    }
    case 'EXPIRATION':
      return withEvent(false, null);
  }
}

/**
 * What: Replay a user's raw store events into the final STORE entitlement projection.
 * Why: Late, duplicated, or out-of-order webhooks must converge to the same state as
 * an ordered event stream.
 */
export function reduceStoreEvents(events: readonly StoreEventForDomain[]): ReducedStoreProjection {
  const sortedEvents = [...events].sort(compareStoreEvents);
  let projection: StoreProjection = EMPTY_STORE_PROJECTION;
  let lastEvent: StoreEventForDomain | undefined;

  for (const event of sortedEvents) {
    projection = applyStoreEventType(event.type, event.eventTimeMs, event.productId, projection);
    lastEvent = event;
  }

  return {
    ...projection,
    lastEventMs: lastEvent?.eventTimeMs ?? null,
    lastEventId: lastEvent?.eventId ?? null,
  };
}

/**
 * What: Look up how long a product grants access after a purchase-like event.
 * Why: Duration is product policy, so callers should not duplicate hard-coded math.
 */
export function subscriptionDurationMs(productId: ProductId): number {
  return PRODUCT_DURATIONS_MS[productId];
}

/**
 * What: Apply billing grace without accidentally creating free access.
 * Why: Payment failures should preserve or briefly extend existing paid access, but a
 * billing issue alone is not a purchase.
 */
function applyBillingIssue(
  eventTimeMs: number,
  previousStoreProjection: StoreProjection,
  withEvent: (active: boolean, expiresAt: Date | null) => StoreProjection,
): StoreProjection {
  const hasPreviousState =
    previousStoreProjection.active ||
    previousPaidThroughExpiry(previousStoreProjection, eventTimeMs) !== null;

  if (!hasPreviousState) {
    return withEvent(false, null);
  }

  const graceExpiry = dateFromEpochMs(eventTimeMs + BILLING_GRACE_MS);
  const previousExpiry = previousStoreProjection.expiresAt;
  if (previousExpiry === null || previousExpiry < graceExpiry) {
    return withEvent(true, graceExpiry);
  }

  // A billing issue should never shorten access that was already paid through
  // beyond the grace window.
  return withEvent(true, previousExpiry);
}

/**
 * What: Find a paid-through expiry that is still valid at the event's business time.
 * Why: Cancellation and un-cancellation preserve existing access only when the replayed
 * event happens before that access has expired.
 */
function previousPaidThroughExpiry(projection: StoreProjection, eventTimeMs: number): Date | null {
  // "Future" is relative to the event being replayed, not wall clock, so late
  // webhooks project the same state regardless of delivery order.
  if (projection.expiresAt === null || projection.expiresAt.getTime() <= eventTimeMs) {
    return null;
  }

  return projection.expiresAt;
}

/**
 * What: Order store events by business time and then event id.
 * Why: The event id tie-breaker makes equal-timestamp webhooks deterministic across
 * databases, workers, and test runs.
 */
function compareStoreEvents(left: StoreEventForDomain, right: StoreEventForDomain): number {
  const timeComparison = left.eventTimeMs - right.eventTimeMs;
  if (timeComparison !== 0) {
    return timeComparison;
  }

  return left.eventId.localeCompare(right.eventId);
}

/**
 * What: Convert epoch milliseconds into a valid Date.
 * Why: Rejecting unsafe or invalid timestamps keeps the reducer from persisting
 * impossible entitlement dates.
 */
function dateFromEpochMs(epochMs: number): Date {
  const date = new Date(epochMs);
  if (!Number.isSafeInteger(epochMs) || Number.isNaN(date.getTime())) {
    throw new Error('store event time must be a safe JavaScript epoch millisecond');
  }

  return date;
}
