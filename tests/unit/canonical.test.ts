import { describe, expect, it } from 'vitest';

import type {
  EntitlementReason,
  EntitlementSource,
  SourceEntitlementForDomain,
} from '../../src/db/types.js';
import { resolveCanonical } from '../../src/engine/canonical.js';

const BASE_MS = Date.UTC(2026, 0, 1);
const NOW = new Date(BASE_MS);
const FUTURE = new Date(BASE_MS + 60_000);
const PAST = new Date(BASE_MS - 60_000);

describe('resolveCanonical', () => {
  it('chooses STORE over other active sources', () => {
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'CARRIER', true, null, 'CARRIER_ACTIVE'),
        sourceRow('user_1', 'STORE', true, FUTURE, 'RENEWAL'),
        sourceRow('user_1', 'MARKETPLACE', true, null, 'MARKETPLACE_GRANT'),
      ],
      NOW,
    );

    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('STORE');
    expect(canonical.reason).toBe('RENEWAL');
    expect(canonical.expiresAt).toEqual(FUTURE);
  });

  it('chooses CARRIER over MARKETPLACE when STORE is absent', () => {
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'MARKETPLACE', true, null, 'MARKETPLACE_GRANT'),
        sourceRow('user_1', 'CARRIER', true, null, 'CARRIER_ACTIVE'),
      ],
      NOW,
    );

    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('CARRIER');
    expect(canonical.reason).toBe('CARRIER_ACTIVE');
  });

  it('returns a single active source', () => {
    const canonical = resolveCanonical(
      [sourceRow('user_1', 'MARKETPLACE', true, null, 'MARKETPLACE_GRANT')],
      NOW,
    );

    expect(canonical).toEqual({
      userId: 'user_1',
      active: true,
      source: 'MARKETPLACE',
      expiresAt: null,
      lastChangedAt: new Date(BASE_MS),
      reason: 'MARKETPLACE_GRANT',
    });
  });

  it('ignores expired active rows and falls through to a lower active source', () => {
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'STORE', true, PAST, 'RENEWAL'),
        sourceRow('user_1', 'CARRIER', true, null, 'CARRIER_ACTIVE'),
      ],
      NOW,
    );

    expect(canonical.active).toBe(true);
    expect(canonical.source).toBe('CARRIER');
  });

  it('uses EXPIRATION and the latest expired paid-through time when all access expired', () => {
    const latestExpired = new Date(BASE_MS - 1_000);
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'STORE', true, new Date(BASE_MS - 10_000), 'RENEWAL'),
        sourceRow('user_1', 'CARRIER', true, latestExpired, 'CARRIER_ACTIVE'),
      ],
      NOW,
    );

    expect(canonical).toEqual({
      userId: 'user_1',
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: latestExpired,
      reason: 'EXPIRATION',
    });
  });

  it('uses NO_ENTITLEMENT with null lastChangedAt when there are no source rows', () => {
    const canonical = resolveCanonical([], NOW);

    expect(canonical).toEqual({
      userId: '',
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: null,
      reason: 'NO_ENTITLEMENT',
    });
  });

  it('uses the most recent inactive source row when no row is active or expired', () => {
    const latestChange = new Date(BASE_MS + 1_000);
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'MARKETPLACE', false, null, 'MARKETPLACE_REVOKE'),
        sourceRow('user_1', 'CARRIER', false, null, 'CARRIER_INACTIVE', latestChange),
      ],
      NOW,
    );

    expect(canonical).toEqual({
      userId: 'user_1',
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: latestChange,
      reason: 'CARRIER_INACTIVE',
    });
  });

  it('breaks inactive lastChangedAt ties by fixed source precedence', () => {
    const sameChangeTime = new Date(BASE_MS + 1_000);
    const canonical = resolveCanonical(
      [
        sourceRow('user_1', 'MARKETPLACE', false, null, 'MARKETPLACE_REVOKE', sameChangeTime),
        sourceRow('user_1', 'STORE', false, null, 'EXPIRATION', sameChangeTime),
      ],
      NOW,
    );

    expect(canonical.active).toBe(false);
    expect(canonical.reason).toBe('EXPIRATION');
    expect(canonical.lastChangedAt).toEqual(sameChangeTime);
  });
});

function sourceRow(
  userId: string,
  source: EntitlementSource,
  active: boolean,
  expiresAt: Date | null,
  reason: EntitlementReason,
  lastChangedAt = new Date(BASE_MS),
): SourceEntitlementForDomain {
  return {
    userId,
    source,
    active,
    expiresAt,
    lastChangedAt,
    reason,
  };
}
