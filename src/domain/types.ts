import type {
  CANONICAL_ENTITLEMENT_SOURCES,
  ENTITLEMENT_REASONS,
  ENTITLEMENT_SOURCES,
  NOTIFICATION_TYPES,
  PRODUCT_IDS,
  STORE_EVENT_TYPES,
} from './constants.js';

export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];
export type CanonicalEntitlementSource = (typeof CANONICAL_ENTITLEMENT_SOURCES)[number];
export type StoreEventType = (typeof STORE_EVENT_TYPES)[number];
export type EntitlementReason = (typeof ENTITLEMENT_REASONS)[number];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export type ProductId = (typeof PRODUCT_IDS)[number];

export interface SourceEntitlementForDomain {
  userId: string;
  source: EntitlementSource;
  active: boolean;
  expiresAt: Date | null;
  lastChangedAt: Date;
  reason: EntitlementReason;
}

export interface CanonicalEntitlementForDomain {
  userId: string;
  active: boolean;
  source: CanonicalEntitlementSource;
  expiresAt: Date | null;
  lastChangedAt: Date | null;
  reason: EntitlementReason;
}

export interface StoreEventForDomain {
  eventId: string;
  userId: string;
  type: StoreEventType;
  eventTimeMs: number;
  productId: ProductId;
  receivedAt: Date;
}
