import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrations/runner.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

describe('database schema guarantees', () => {
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

  it('runs migrations idempotently against an already migrated database', async () => {
    await expect(runMigrations(requireHarness(harness).db)).resolves.toBeUndefined();
  });

  it('rejects invalid entitlement source and reason values at the database boundary', async () => {
    const currentHarness = requireHarness(harness);
    const changedAt = new Date('2026-01-01T00:00:00.000Z');

    await expect(
      sql`
        insert into source_entitlements
          (user_id, source, active, expires_at, last_changed_at, reason)
        values
          ('user_invalid_source', 'PARTNER', true, null, ${changedAt}, 'CARRIER_ACTIVE')
      `.execute(currentHarness.db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into canonical_entitlements
          (user_id, active, source, expires_at, last_changed_at, reason)
        values
          ('user_invalid_reason', false, 'NONE', null, ${changedAt}, 'UNKNOWN_REASON')
      `.execute(currentHarness.db),
    ).rejects.toThrow();
  });

  it('enforces source-specific store event metadata fields', async () => {
    const currentHarness = requireHarness(harness);
    const changedAt = new Date('2026-01-01T00:00:00.000Z');

    await expect(
      sql`
        insert into source_entitlements
          (user_id, source, active, expires_at, last_changed_at, reason)
        values
          ('user_store_missing_event_fields', 'STORE', true, ${changedAt}, ${changedAt}, 'RENEWAL')
      `.execute(currentHarness.db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into source_entitlements
          (user_id, source, active, expires_at, last_changed_at, reason, last_event_ms, last_event_id)
        values
          ('user_carrier_with_event_fields', 'CARRIER', true, null, ${changedAt}, 'CARRIER_ACTIVE', 1716700000000, 'evt_carrier')
      `.execute(currentHarness.db),
    ).rejects.toThrow();
  });

  it('rejects invalid store event types and products at the database boundary', async () => {
    const currentHarness = requireHarness(harness);

    await expect(
      sql`
        insert into store_events
          (event_id, user_id, type, event_time_ms, product_id)
        values
          ('evt_invalid_type', 'user_invalid_store_type', 'PAUSE', 1716700000000, 'premium_monthly')
      `.execute(currentHarness.db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into store_events
          (event_id, user_id, type, event_time_ms, product_id)
        values
          ('evt_invalid_product', 'user_invalid_store_product', 'RENEWAL', 1716700000000, 'premium_yearly')
      `.execute(currentHarness.db),
    ).rejects.toThrow();
  });

  it('enforces notification type, expiry presence, and per-expiry uniqueness', async () => {
    const currentHarness = requireHarness(harness);
    const expiresAt = new Date('2026-06-10T00:00:00.000Z');
    const scheduledFor = new Date('2026-06-09T00:00:00.000Z');

    await expect(
      sql`
        insert into notifications
          (user_id, type, expires_at, scheduled_for, sent_at)
        values
          ('user_invalid_notification_type', 'WELCOME', ${expiresAt}, ${scheduledFor}, null)
      `.execute(currentHarness.db),
    ).rejects.toThrow();

    await expect(
      sql`
        insert into notifications
          (user_id, type, expires_at, scheduled_for, sent_at)
        values
          ('user_missing_notification_expiry', 'PREMIUM_EXPIRES_SOON', null, ${scheduledFor}, null)
      `.execute(currentHarness.db),
    ).rejects.toThrow();

    await currentHarness.db
      .insertInto('notifications')
      .values({
        user_id: 'user_duplicate_notification',
        type: 'PREMIUM_EXPIRES_SOON',
        expires_at: expiresAt,
        scheduled_for: scheduledFor,
        sent_at: null,
      })
      .execute();

    await expect(
      currentHarness.db
        .insertInto('notifications')
        .values({
          user_id: 'user_duplicate_notification',
          type: 'PREMIUM_EXPIRES_SOON',
          expires_at: expiresAt,
          scheduled_for: scheduledFor,
          sent_at: null,
        })
        .execute(),
    ).rejects.toThrow();
  });
});
