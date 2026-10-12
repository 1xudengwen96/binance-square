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

/**
 * The funding rate nobody chose.
 *
 * Binance's default is 0.01% per 8h and Hyperliquid's is 0.00125% per hour; both annualise to the
 * same 10.95%. A contract sitting on that number has no crowd on either side — the exchange's
 * interest-rate component is simply showing through — and 80% of the Hyperliquid rows in the
 * live database were exactly this. «多头在付费» on such a row is true of every contract on the
 * venue at once, so it is not an observation about the coin. Compare on the annualised figure so
 * 8h and 1h settlement land on the same number.
 */
export const FUNDING_BASELINE_ANNUALIZED = 10.95;

export function fundingIsBaseline(annualized: number | null | undefined): boolean {
  return typeof annualized === 'number' && Number.isFinite(annualized) && Math.abs(annualized - FUNDING_BASELINE_ANNUALIZED) < 1.5;
}

/** Who pays, or '' when the rate is the default and nobody in particular does. */
export function fundingPayer(funding: number | null | undefined, annualized: number | null | undefined): '多头' | '空头' | '' {
  if (typeof funding !== 'number' || !Number.isFinite(funding) || funding === 0) return '';
  if (fundingIsBaseline(annualized)) return '';
  return funding > 0 ? '多头' : '空头';
}
