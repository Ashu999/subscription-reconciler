import type {
  EntitlementReason,
  ProductId,
  StoreEventForDomain,
  StoreEventType,
} from '../db/types.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
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
    case 'UN_CANCELLATION':
      return withEvent(
        true,
        previousPaidThroughExpiry(previousStoreProjection, eventTimeMs) ?? productExpiry(),
      );
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

export function subscriptionDurationMs(productId: ProductId): number {
  return PRODUCT_DURATIONS_MS[productId];
}

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

  return withEvent(true, previousExpiry);
}

function previousPaidThroughExpiry(projection: StoreProjection, eventTimeMs: number): Date | null {
  if (projection.expiresAt === null || projection.expiresAt.getTime() <= eventTimeMs) {
    return null;
  }

  return projection.expiresAt;
}

function compareStoreEvents(left: StoreEventForDomain, right: StoreEventForDomain): number {
  const timeComparison = left.eventTimeMs - right.eventTimeMs;
  if (timeComparison !== 0) {
    return timeComparison;
  }

  return left.eventId.localeCompare(right.eventId);
}

function dateFromEpochMs(epochMs: number): Date {
  const date = new Date(epochMs);
  if (!Number.isSafeInteger(epochMs) || Number.isNaN(date.getTime())) {
    throw new Error('store event time must be a safe JavaScript epoch millisecond');
  }

  return date;
}
