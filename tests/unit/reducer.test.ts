import { describe, expect, it } from 'vitest';

import type { StoreEventForDomain, StoreEventType } from '../../src/db/types.js';
import {
  applyStoreEventType,
  EMPTY_STORE_PROJECTION,
  reduceStoreEvents,
  type StoreProjection,
} from '../../src/engine/reducer.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * ONE_DAY_MS;
const GRACE_MS = 7 * ONE_DAY_MS;
const BASE_MS = Date.UTC(2026, 0, 1);

describe('applyStoreEventType', () => {
  it('activates an initial purchase for the product duration from business time', () => {
    const projection = applyStoreEventType(
      'INITIAL_PURCHASE',
      BASE_MS,
      'premium_monthly',
      EMPTY_STORE_PROJECTION,
    );

    expect(projection).toEqual({
      active: true,
      reason: 'INITIAL_PURCHASE',
      expiresAt: new Date(BASE_MS + MONTH_MS),
      lastChangedAt: new Date(BASE_MS),
    });
  });

  it('activates a renewal for the product duration from business time', () => {
    const projection = applyStoreEventType(
      'RENEWAL',
      BASE_MS + ONE_DAY_MS,
      'premium_monthly',
      EMPTY_STORE_PROJECTION,
    );

    expect(projection.active).toBe(true);
    expect(projection.reason).toBe('RENEWAL');
    expect(projection.expiresAt).toEqual(new Date(BASE_MS + ONE_DAY_MS + MONTH_MS));
    expect(projection.lastChangedAt).toEqual(new Date(BASE_MS + ONE_DAY_MS));
  });

  it('preserves paid-through access on cancellation', () => {
    const previous = activeProjection('RENEWAL', BASE_MS, BASE_MS + MONTH_MS);
    const projection = applyStoreEventType(
      'CANCELLATION',
      BASE_MS + ONE_DAY_MS,
      'premium_monthly',
      previous,
    );

    expect(projection).toEqual({
      active: true,
      reason: 'CANCELLATION',
      expiresAt: previous.expiresAt,
      lastChangedAt: new Date(BASE_MS + ONE_DAY_MS),
    });
  });

  it('does not grant cancellation access without a paid-through expiry', () => {
    const projection = applyStoreEventType(
      'CANCELLATION',
      BASE_MS,
      'premium_monthly',
      EMPTY_STORE_PROJECTION,
    );

    expect(projection).toEqual({
      active: false,
      reason: 'CANCELLATION',
      expiresAt: null,
      lastChangedAt: new Date(BASE_MS),
    });
  });

  it('adds billing grace only when previous access exists and never shortens expiry', () => {
    const previous = activeProjection('RENEWAL', BASE_MS, BASE_MS + MONTH_MS);

    const preserved = applyStoreEventType(
      'BILLING_ISSUE',
      BASE_MS + ONE_DAY_MS,
      'premium_monthly',
      previous,
    );
    expect(preserved.active).toBe(true);
    expect(preserved.reason).toBe('BILLING_ISSUE');
    expect(preserved.expiresAt).toEqual(previous.expiresAt);

    const extended = applyStoreEventType(
      'BILLING_ISSUE',
      BASE_MS + 29 * ONE_DAY_MS,
      'premium_monthly',
      previous,
    );
    expect(extended.active).toBe(true);
    expect(extended.expiresAt).toEqual(new Date(BASE_MS + 29 * ONE_DAY_MS + GRACE_MS));
  });

  it('treats an initial billing issue as inactive', () => {
    const projection = applyStoreEventType(
      'BILLING_ISSUE',
      BASE_MS,
      'premium_monthly',
      EMPTY_STORE_PROJECTION,
    );

    expect(projection).toEqual({
      active: false,
      reason: 'BILLING_ISSUE',
      expiresAt: null,
      lastChangedAt: new Date(BASE_MS),
    });
  });

  it('preserves future expiry on un-cancellation and does not grant without one', () => {
    const previous = activeProjection('CANCELLATION', BASE_MS, BASE_MS + MONTH_MS);

    const preserved = applyStoreEventType(
      'UN_CANCELLATION',
      BASE_MS + ONE_DAY_MS,
      'premium_monthly',
      previous,
    );
    expect(preserved.active).toBe(true);
    expect(preserved.expiresAt).toEqual(previous.expiresAt);

    const fresh = applyStoreEventType(
      'UN_CANCELLATION',
      BASE_MS + MONTH_MS + ONE_DAY_MS,
      'premium_monthly',
      previous,
    );
    expect(fresh).toEqual({
      active: false,
      reason: 'UN_CANCELLATION',
      expiresAt: null,
      lastChangedAt: new Date(BASE_MS + MONTH_MS + ONE_DAY_MS),
    });
  });

  it('lets a renewal after a billing issue establish the renewed paid-through expiry', () => {
    const initial = activeProjection('INITIAL_PURCHASE', BASE_MS, BASE_MS + MONTH_MS);
    const billingIssueMs = BASE_MS + 29 * ONE_DAY_MS;
    const renewalMs = billingIssueMs + ONE_DAY_MS;
    const billingIssue = applyStoreEventType(
      'BILLING_ISSUE',
      billingIssueMs,
      'premium_monthly',
      initial,
    );

    const renewal = applyStoreEventType('RENEWAL', renewalMs, 'premium_monthly', billingIssue);

    expect(renewal).toEqual({
      active: true,
      reason: 'RENEWAL',
      expiresAt: new Date(renewalMs + MONTH_MS),
      lastChangedAt: new Date(renewalMs),
    });
  });

  it('removes access on expiration', () => {
    const previous = activeProjection('RENEWAL', BASE_MS, BASE_MS + MONTH_MS);
    const projection = applyStoreEventType(
      'EXPIRATION',
      BASE_MS + MONTH_MS,
      'premium_monthly',
      previous,
    );

    expect(projection).toEqual({
      active: false,
      reason: 'EXPIRATION',
      expiresAt: null,
      lastChangedAt: new Date(BASE_MS + MONTH_MS),
    });
  });
});

describe('reduceStoreEvents', () => {
  it('replays out-of-order events by event time before applying cancellation semantics', () => {
    const renewal = storeEvent('renewal', 'RENEWAL', BASE_MS);
    const cancellation = storeEvent('cancellation', 'CANCELLATION', BASE_MS + ONE_DAY_MS);

    const projection = reduceStoreEvents([cancellation, renewal]);

    expect(projection.active).toBe(true);
    expect(projection.reason).toBe('CANCELLATION');
    expect(projection.expiresAt).toEqual(new Date(BASE_MS + MONTH_MS));
    expect(projection.lastChangedAt).toEqual(new Date(BASE_MS + ONE_DAY_MS));
    expect(projection.lastEventMs).toBe(BASE_MS + ONE_DAY_MS);
    expect(projection.lastEventId).toBe('cancellation');
  });

  it('uses event id as a deterministic tie-breaker for equal event times', () => {
    const expiration = storeEvent('a-expiration', 'EXPIRATION', BASE_MS);
    const renewal = storeEvent('b-renewal', 'RENEWAL', BASE_MS);

    const projection = reduceStoreEvents([renewal, expiration]);

    expect(projection.active).toBe(true);
    expect(projection.reason).toBe('RENEWAL');
    expect(projection.expiresAt).toEqual(new Date(BASE_MS + MONTH_MS));
    expect(projection.lastEventId).toBe('b-renewal');
  });
});

function activeProjection(
  reason: StoreEventType,
  lastChangedAtMs: number,
  expiresAtMs: number,
): StoreProjection {
  return {
    active: true,
    reason,
    expiresAt: new Date(expiresAtMs),
    lastChangedAt: new Date(lastChangedAtMs),
  };
}

function storeEvent(
  eventId: string,
  type: StoreEventType,
  eventTimeMs: number,
): StoreEventForDomain {
  return {
    eventId,
    userId: 'user_1',
    type,
    eventTimeMs,
    productId: 'premium_monthly',
    receivedAt: new Date(BASE_MS),
  };
}
