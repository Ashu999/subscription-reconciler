import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { selectSource } from '../helpers/db-selectors.js';
import type { IntegrationHarness } from '../helpers/integration.js';
import { createIntegrationHarness, requireHarness } from '../helpers/integration.js';

describe('audit timestamps', () => {
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

  it('preserves created_at and lets the Postgres trigger advance updated_at', async () => {
    const currentHarness = requireHarness(harness);
    const auditTimestamp = new Date('2025-01-01T00:00:00.000Z');
    const lastChangedAt = new Date('2026-01-01T00:00:00.000Z');

    await currentHarness.db
      .insertInto('source_entitlements')
      .values({
        user_id: 'user_audit_timestamps',
        source: 'STORE',
        active: true,
        expires_at: new Date('2026-02-01T00:00:00.000Z'),
        last_changed_at: lastChangedAt,
        reason: 'INITIAL_PURCHASE',
        last_event_ms: lastChangedAt.getTime(),
        last_event_id: 'audit-initial',
        created_at: auditTimestamp,
        updated_at: auditTimestamp,
      })
      .execute();

    await currentHarness.db
      .updateTable('source_entitlements')
      .set({
        active: false,
        expires_at: null,
        last_changed_at: new Date('2026-01-02T00:00:00.000Z'),
        reason: 'CANCELLATION',
      })
      .where('user_id', '=', 'user_audit_timestamps')
      .where('source', '=', 'STORE')
      .execute();

    const source = await selectSource(currentHarness, 'user_audit_timestamps', 'STORE');

    expect(source.created_at).toEqual(auditTimestamp);
    expect(source.updated_at.getTime()).toBeGreaterThan(auditTimestamp.getTime());
  });
});
