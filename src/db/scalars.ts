import { MAX_JS_DATE_MS, MIN_JS_DATE_MS } from '../domain/constants.js';

const MIN_SAFE_INTEGER_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * What: Parse a database bigint value as safe epoch milliseconds.
 * Why: Store event replay relies on JavaScript Date, so values outside Date's range or
 * integer precision must be rejected.
 */
export function parseDbBigIntAsSafeEpochMs(
  value: string | number | bigint,
  columnName: string,
): number {
  const parsed = parseDbBigIntAsSafeNumber(value, columnName);

  if (parsed < MIN_JS_DATE_MS || parsed > MAX_JS_DATE_MS) {
    throw new Error(`${columnName} must be within the JavaScript Date epoch millisecond range`);
  }

  return parsed;
}

/**
 * What: Convert a bigint-like database value into a safe JavaScript number.
 * Why: Database drivers can return bigint columns differently, but reducer arithmetic
 * requires a precise number.
 */
function parseDbBigIntAsSafeNumber(value: string | number | bigint, columnName: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${columnName} must be a safe integer`);
    }

    return value;
  }

  const parsed = typeof value === 'bigint' ? value : parseDbBigIntString(value, columnName);

  if (parsed < MIN_SAFE_INTEGER_BIGINT || parsed > MAX_SAFE_INTEGER_BIGINT) {
    throw new Error(`${columnName} must fit in a safe JavaScript integer`);
  }

  return Number(parsed);
}

/**
 * What: Parse an integer string into a bigint.
 * Why: Strict parsing prevents whitespace, decimals, or malformed driver output from
 * silently becoming the wrong event time.
 */
function parseDbBigIntString(value: string, columnName: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`${columnName} must be an integer string`);
  }

  return BigInt(trimmed);
}
