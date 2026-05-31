import type {
  CanonicalEntitlementForDomain,
  EntitlementSource,
  SourceEntitlementForDomain,
} from '../db/types.js';

export type SourceEntitlementState = SourceEntitlementForDomain;
export type CanonicalEntitlementState = CanonicalEntitlementForDomain;

const SOURCE_PRECEDENCE: Record<EntitlementSource, number> = {
  STORE: 0,
  CARRIER: 1,
  MARKETPLACE: 2,
};

export function resolveCanonical(
  sourceRows: readonly SourceEntitlementState[],
  asOf: Date,
): CanonicalEntitlementState {
  const activeRows = sourceRows
    .filter((row) => row.active && (row.expiresAt === null || row.expiresAt > asOf))
    .sort((left, right) => SOURCE_PRECEDENCE[left.source] - SOURCE_PRECEDENCE[right.source]);

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

function isDate(value: Date | null): value is Date {
  return value !== null;
}

function maxDate(values: readonly Date[]): Date {
  return new Date(Math.max(...values.map((value) => value.getTime())));
}

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
