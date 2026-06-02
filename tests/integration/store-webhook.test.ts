import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { CanonicalEntitlementResponse } from '../../src/http/serializers.js';
import {
  selectCanonical,
  selectStoreEventCount,
  selectStoreSource,
} from '../helpers/db-selectors.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * ONE_DAY_MS;
const GRACE_MS = 7 * ONE_DAY_MS;

interface AppliedResponse {
  status: 'applied';
  entitlement: CanonicalEntitlementResponse;
}

interface DuplicateResponse {
  status: 'duplicate';
}

interface StoreWebhookPayload {
  eventId: string;
  userId: string;
  type:
    | 'INITIAL_PURCHASE'
    | 'RENEWAL'
    | 'CANCELLATION'
    | 'BILLING_ISSUE'
    | 'EXPIRATION'
    | 'UN_CANCELLATION';
  eventTimeMs: number;
  productId: string;
}

type StoreInjectPayload = NonNullable<InjectOptions['payload']>;

describe('POST /webhooks/store', () => {
  let harness: IntegrationHarness | undefined;

  beforeAll(async () => {
    harness = await createIntegrationHarness();
  }, 120_000);

  afterEach(async () => {
    await requireHarness(harness).resetDb();
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it('stores a unique event once and returns duplicate for repeated event IDs', async () => {
    const currentHarness = requireHarness(harness);
    const payload = storeEvent({
      eventId: 'duplicate-initial',
      userId: 'user_duplicate',
      type: 'INITIAL_PURCHASE',
      eventTimeMs: futureMs(1),
    });

    const firstResponse = await postStoreWebhook(currentHarness, payload);
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json<AppliedResponse>().status).toBe('applied');
    const canonicalAfterFirst = await selectCanonical(currentHarness, payload.userId);

    const duplicateResponse = await postStoreWebhook(currentHarness, payload);
    expect(duplicateResponse.statusCode).toBe(200);
    expect(duplicateResponse.json<DuplicateResponse>()).toEqual({ status: 'duplicate' });

    expect(await selectStoreEventCount(currentHarness, payload.userId)).toBe(1);
    expect(await selectCanonical(currentHarness, payload.userId)).toEqual(canonicalAfterFirst);
  });

  it('creates STORE source and canonical rows for a first store event', async () => {
    const currentHarness = requireHarness(harness);
    const eventTimeMs = futureMs(1);
    const payload = storeEvent({
      eventId: 'first-event-initial',
      userId: 'user_first_event',
      type: 'INITIAL_PURCHASE',
      eventTimeMs,
    });

    await expectApplied(currentHarness, payload);

    const source = await selectStoreSource(currentHarness, payload.userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('INITIAL_PURCHASE');
    expect(source.expires_at).toEqual(new Date(eventTimeMs + MONTH_MS));
    expect(source.last_event_ms).toBe(String(eventTimeMs));
    expect(source.last_event_id).toBe(payload.eventId);

    const canonical = await selectCanonical(currentHarness, payload.userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.expires_at).toEqual(new Date(eventTimeMs + MONTH_MS));
  });

  it('replays late out-of-order events before applying cancellation semantics', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_late_out_of_order';
    const renewalMs = futureMs(2);
    const cancellationMs = renewalMs + ONE_DAY_MS;

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'late-cancellation',
        userId,
        type: 'CANCELLATION',
        eventTimeMs: cancellationMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'late-renewal',
        userId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('CANCELLATION');
    expect(source.expires_at).toEqual(new Date(renewalMs + MONTH_MS));
    expect(source.last_changed_at).toEqual(new Date(cancellationMs));
    expect(source.last_event_ms).toBe(String(cancellationMs));
    expect(source.last_event_id).toBe('late-cancellation');

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.reason).toBe('CANCELLATION');
  });

  it('reactivates access when a renewal is later than an expiration in event time', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_renewal_after_expiration';
    const expirationMs = futureMs(3);
    const renewalMs = expirationMs + ONE_DAY_MS;

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'expiration-first',
        userId,
        type: 'EXPIRATION',
        eventTimeMs: expirationMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'renewal-second',
        userId,
        type: 'RENEWAL',
        eventTimeMs: renewalMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('RENEWAL');
    expect(source.expires_at).toEqual(new Date(renewalMs + MONTH_MS));
  });

  it('uses event IDs as deterministic tie-breakers for same-time events', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_same_time';
    const eventTimeMs = futureMs(4);

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'b-renewal',
        userId,
        type: 'RENEWAL',
        eventTimeMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'a-expiration',
        userId,
        type: 'EXPIRATION',
        eventTimeMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('RENEWAL');
    expect(source.last_event_id).toBe('b-renewal');
  });

  it('serializes concurrent source mutations through the per-user lock', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_concurrent';
    const renewalMs = futureMs(5);
    const cancellationMs = renewalMs + ONE_DAY_MS;

    const [renewalResponse, cancellationResponse] = await Promise.all([
      postStoreWebhook(
        currentHarness,
        storeEvent({
          eventId: 'concurrent-renewal',
          userId,
          type: 'RENEWAL',
          eventTimeMs: renewalMs,
        }),
      ),
      postStoreWebhook(
        currentHarness,
        storeEvent({
          eventId: 'concurrent-cancellation',
          userId,
          type: 'CANCELLATION',
          eventTimeMs: cancellationMs,
        }),
      ),
    ]);

    expect(renewalResponse.statusCode).toBe(200);
    expect(renewalResponse.json<AppliedResponse>().status).toBe('applied');
    expect(cancellationResponse.statusCode).toBe(200);
    expect(cancellationResponse.json<AppliedResponse>().status).toBe('applied');

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('CANCELLATION');
    expect(source.expires_at).toEqual(new Date(renewalMs + MONTH_MS));
    expect(await selectStoreEventCount(currentHarness, userId)).toBe(2);
  });

  it('schedules exactly one due notification for billing grace inside the next 24 hours', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_billing_notification';
    const billingIssueMs = Date.now() - Math.floor(6.5 * ONE_DAY_MS);
    const initialPurchaseMs = billingIssueMs - 29 * ONE_DAY_MS;
    const expiresAt = new Date(billingIssueMs + GRACE_MS);

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'billing-initial-purchase',
        userId,
        type: 'INITIAL_PURCHASE',
        eventTimeMs: initialPurchaseMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'billing-issue',
        userId,
        type: 'BILLING_ISSUE',
        eventTimeMs: billingIssueMs,
      }),
    );

    const duplicateResponse = await postStoreWebhook(
      currentHarness,
      storeEvent({
        eventId: 'billing-issue',
        userId,
        type: 'BILLING_ISSUE',
        eventTimeMs: billingIssueMs,
      }),
    );
    expect(duplicateResponse.json<DuplicateResponse>()).toEqual({ status: 'duplicate' });

    const notifications = await currentHarness.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('PREMIUM_EXPIRES_SOON');
    expect(notifications[0]?.expires_at).toEqual(expiresAt);
    expect(notifications[0]?.scheduled_for).toEqual(new Date(expiresAt.getTime() - ONE_DAY_MS));
    expect(notifications[0]?.sent_at).toBeNull();
  });

  it('does not shorten a later paid-through expiry when a billing issue arrives', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_billing_preserves_paid_through';
    const initialPurchaseMs = Date.now() - 10 * ONE_DAY_MS;
    const billingIssueMs = Date.now() - ONE_DAY_MS;
    const paidThroughExpiresAt = new Date(initialPurchaseMs + MONTH_MS);

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'billing-preserve-initial',
        userId,
        type: 'INITIAL_PURCHASE',
        eventTimeMs: initialPurchaseMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'billing-preserve-issue',
        userId,
        type: 'BILLING_ISSUE',
        eventTimeMs: billingIssueMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('BILLING_ISSUE');
    expect(source.expires_at).toEqual(paidThroughExpiresAt);

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.expires_at).toEqual(paidThroughExpiresAt);

    const notifications = await currentHarness.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(notifications).toHaveLength(0);
  });

  it('preserves paid-through access when an un-cancellation follows a cancellation', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_uncancellation_preserves_access';
    const initialPurchaseMs = futureMs(1);
    const cancellationMs = initialPurchaseMs + ONE_DAY_MS;
    const unCancellationMs = cancellationMs + ONE_DAY_MS;
    const paidThroughExpiresAt = new Date(initialPurchaseMs + MONTH_MS);

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'uncancel-initial',
        userId,
        type: 'INITIAL_PURCHASE',
        eventTimeMs: initialPurchaseMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'uncancel-cancellation',
        userId,
        type: 'CANCELLATION',
        eventTimeMs: cancellationMs,
      }),
    );
    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'uncancel-restored',
        userId,
        type: 'UN_CANCELLATION',
        eventTimeMs: unCancellationMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(true);
    expect(source.reason).toBe('UN_CANCELLATION');
    expect(source.expires_at).toEqual(paidThroughExpiresAt);
    expect(source.last_changed_at).toEqual(new Date(unCancellationMs));
    expect(source.last_event_ms).toBe(String(unCancellationMs));
    expect(source.last_event_id).toBe('uncancel-restored');

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.reason).toBe('UN_CANCELLATION');
    expect(canonical.expires_at).toEqual(paidThroughExpiresAt);
  });

  it('treats un-cancellation as inactive when there is no paid-through access to restore', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_uncancellation_no_paid_through';
    const unCancellationMs = futureMs(6);

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'uncancel-without-history',
        userId,
        type: 'UN_CANCELLATION',
        eventTimeMs: unCancellationMs,
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(false);
    expect(source.reason).toBe('UN_CANCELLATION');
    expect(source.expires_at).toBeNull();
    expect(source.last_changed_at).toEqual(new Date(unCancellationMs));

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(false);
    expect(canonical.source).toBe('NONE');
    expect(canonical.reason).toBe('UN_CANCELLATION');

    const notifications = await currentHarness.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(notifications).toHaveLength(0);
  });

  it('treats billing issue as an inactive no-op when it is the first store event', async () => {
    const currentHarness = requireHarness(harness);
    const userId = 'user_initial_billing_issue';

    await expectApplied(
      currentHarness,
      storeEvent({
        eventId: 'initial-billing-issue',
        userId,
        type: 'BILLING_ISSUE',
        eventTimeMs: futureMs(6),
      }),
    );

    const source = await selectStoreSource(currentHarness, userId);
    expect(source.active).toBe(false);
    expect(source.reason).toBe('BILLING_ISSUE');
    expect(source.expires_at).toBeNull();

    const canonical = await selectCanonical(currentHarness, userId);
    expect(canonical.active).toBe(false);
    expect(canonical.source).toBe('NONE');
    expect(canonical.reason).toBe('BILLING_ISSUE');

    const notifications = await currentHarness.db
      .selectFrom('notifications')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(notifications).toHaveLength(0);
  });

  it('rejects unknown products before storing raw events', async () => {
    const currentHarness = requireHarness(harness);
    const payload = storeEvent({
      eventId: 'unknown-product',
      userId: 'user_unknown_product',
      type: 'INITIAL_PURCHASE',
      eventTimeMs: futureMs(7),
      productId: 'premium_yearly',
    });

    const response = await postStoreWebhook(currentHarness, payload);
    expect(response.statusCode).toBe(400);

    const rows = await currentHarness.db
      .selectFrom('store_events')
      .selectAll()
      .where('event_id', '=', payload.eventId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('rejects malformed store webhook requests before storing raw events', async () => {
    const currentHarness = requireHarness(harness);
    const validPayload = storeEvent({
      eventId: 'validation-base',
      userId: 'user_store_validation',
      type: 'INITIAL_PURCHASE',
      eventTimeMs: futureMs(8),
    });
    const cases: Array<{ name: string; payload: StoreInjectPayload }> = [
      {
        name: 'missing eventId',
        payload: omit(validPayload, 'eventId'),
      },
      {
        name: 'empty userId',
        payload: { ...validPayload, eventId: 'validation-empty-user', userId: '' },
      },
      {
        name: 'invalid event type',
        payload: { ...validPayload, eventId: 'validation-invalid-type', type: 'PAUSE' },
      },
      {
        name: 'non-integer event time',
        payload: { ...validPayload, eventId: 'validation-decimal-time', eventTimeMs: 1.5 },
      },
      {
        name: 'out-of-range event time',
        payload: { ...validPayload, eventId: 'validation-out-of-range-time', eventTimeMs: 1e20 },
      },
      {
        name: 'unknown property',
        payload: { ...validPayload, eventId: 'validation-extra-field', ignored: true },
      },
    ];

    for (const currentCase of cases) {
      const response = await postStoreWebhook(currentHarness, currentCase.payload);
      expect(response.statusCode, currentCase.name).toBe(400);
    }

    const rows = await currentHarness.db
      .selectFrom('store_events')
      .selectAll()
      .where('user_id', '=', validPayload.userId)
      .execute();
    expect(rows).toHaveLength(0);
  });
});

async function expectApplied(
  harness: IntegrationHarness,
  payload: StoreWebhookPayload,
): Promise<AppliedResponse> {
  const response = await postStoreWebhook(harness, payload);
  expect(response.statusCode).toBe(200);
  const body = response.json<AppliedResponse>();
  expect(body.status).toBe('applied');
  return body;
}

function postStoreWebhook(
  harness: IntegrationHarness,
  payload: StoreInjectPayload,
): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: '/webhooks/store',
    payload,
  });
}

function storeEvent(overrides: Partial<StoreWebhookPayload>): StoreWebhookPayload {
  return {
    eventId: 'event-id',
    userId: 'user-id',
    type: 'RENEWAL',
    eventTimeMs: futureMs(10),
    productId: 'premium_monthly',
    ...overrides,
  };
}

function futureMs(daysFromNow: number): number {
  return Date.now() + daysFromNow * ONE_DAY_MS;
}

function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _removed, ...rest } = value;
  return rest;
}
