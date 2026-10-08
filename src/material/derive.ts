/** Derived quantities that need a sanity bound before they are safe to print. */

/**
 * Annualise a per-period funding rate.
 *
 * A single extreme settlement period annualises to a number that is arithmetically
 * correct and completely meaningless — -0.5% per 8h reads as -555%, and -0.53% on a
 * thin new listing can exceed -1000%. Printing that as if it were a signal is worse
 * than printing nothing, so out-of-range results come back as null and the template
 * drops the clause.
 */
export const ANNUALIZED_LIMIT = 300;

export function annualizedFunding(rate: number | null | undefined, intervalHours: number): number | null {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return null;
  if (!(intervalHours > 0 && intervalHours <= 24)) return null;
  const annual = rate * (24 / intervalHours) * 365 * 100;
  if (!Number.isFinite(annual) || Math.abs(annual) > ANNUALIZED_LIMIT) return null;
  return Number(annual.toFixed(1));
}
