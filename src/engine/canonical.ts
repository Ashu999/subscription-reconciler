import type {
  CanonicalEntitlementForDomain,
  EntitlementSource,
  SourceEntitlementForDomain,
} from '../domain/types.js';

export type SourceEntitlementState = SourceEntitlementForDomain;
export type CanonicalEntitlementState = CanonicalEntitlementForDomain;

// Product policy: active STORE access wins over CARRIER, which wins over
// MARKETPLACE, even when a lower-priority source changed more recently.
const SOURCE_PRECEDENCE: Record<EntitlementSource, number> = {
  STORE: 0,
  CARRIER: 1,
  MARKETPLACE: 2,
};

/**
 * What: Collapse all source entitlement rows into the single entitlement users see.
 * Why: Callers need deterministic access decisions even when sources disagree, arrive
 * late, or expire at different times.
 */
export function resolveCanonical(
  sourceRows: readonly SourceEntitlementState[],
  asOf: Date,
): CanonicalEntitlementState {
  const activeRows = sourceRows
    .filter((row) => row.active && (row.expiresAt === null || row.expiresAt > asOf))
    .sort(compareActiveSourceRows);

  const winner = activeRows[0];
  if (winner !== undefined) {
    return {
      userId: winner.userId,
      active: true,
      source: winner.source,
      expiresAt: winner.expiresAt,
      lastChangedAt: winner.lastChangedAt,
      reason: winner.reason,
    };
  }

  const userId = sourceRows[0]?.userId ?? '';
  if (sourceRows.length === 0) {
    return {
      userId,
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: null,
      reason: 'NO_ENTITLEMENT',
    };
  }

  const expiredRows = sourceRows.filter((row) => row.expiresAt !== null && row.expiresAt <= asOf);
  if (expiredRows.length > 0) {
    // Surface an expiration reason when all remaining source rows are inactive
    // only because their paid-through timestamps have aged out.
    const latestExpiry = maxDate(expiredRows.map((row) => row.expiresAt).filter(isDate));

    return {
      userId,
      active: false,
      source: 'NONE',
      expiresAt: null,
      lastChangedAt: latestExpiry,
      reason: 'EXPIRATION',
    };
  }

  const latestRow = [...sourceRows].sort(compareSourceRowsByLatestChange)[0];

  return {
    userId,
    active: false,
    source: 'NONE',
    expiresAt: null,
    lastChangedAt: latestRow.lastChangedAt,
    reason: latestRow.reason,
  };
}

/**
 * What: Narrow nullable expiry values to real Date instances.
 * Why: The expiration branch needs to compute a max timestamp without carrying nulls.
 */
function isDate(value: Date | null): value is Date {
  return value !== null;
}

/**
 * What: Return the latest timestamp from a non-empty date list.
 * Why: Inactive canonical rows still need a stable lastChangedAt for auditing and tests.
 */
function maxDate(values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

/**
 * What: Sort source rows by the most recent change, then policy precedence.
 * Why: When no source is active, the canonical reason should explain the latest known
 * state while staying deterministic for equal timestamps.
 */
function compareSourceRowsByLatestChange(
  left: SourceEntitlementState,
  right: SourceEntitlementState,
): number {
  const changedAtComparison = right.lastChangedAt.getTime() - left.lastChangedAt.getTime();
  if (changedAtComparison !== 0) {
    return changedAtComparison;
  }

  return SOURCE_PRECEDENCE[left.source] - SOURCE_PRECEDENCE[right.source];
}

/**
 * What: Sort active sources by product precedence, recency, expiry, then reason.
 * Why: Canonical active access follows business policy first, with deterministic
 * tie-breakers so replaying the same rows always produces the same winner.
 */
function compareActiveSourceRows(
  left: SourceEntitlementState,
  right: SourceEntitlementState,
): number {
  const precedenceComparison = SOURCE_PRECEDENCE[left.source] - SOURCE_PRECEDENCE[right.source];
  if (precedenceComparison !== 0) {
    return precedenceComparison;
  }

  const changedAtComparison = right.lastChangedAt.getTime() - left.lastChangedAt.getTime();
  if (changedAtComparison !== 0) {
    return changedAtComparison;
  }

  const expiryComparison = compareNullableExpiry(left.expiresAt, right.expiresAt);
  if (expiryComparison !== 0) {
    return expiryComparison;
  }

  return left.reason.localeCompare(right.reason);
}

/**
 * What: Compare nullable expiry values with no-expiry access first.
 * Why: A null expiry represents open-ended access and should win over time-limited
 * rows when all higher-priority tie-breakers are equal.
 */
function compareNullableExpiry(left: Date | null, right: Date | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return -1;
  }

  if (right === null) {
    return 1;
  }

  return right.getTime() - left.getTime();
}
