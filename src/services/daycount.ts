export const DAY_COUNT_CONVENTION = "ACT/365F";
export const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

export function remainingTermYears(
  valuationTime: string,
  maturityDate: string,
): number {
  const valuation = new Date(valuationTime).getTime();
  const maturity = new Date(`${maturityDate}T00:00:00Z`).getTime();
  const diffMs = maturity - valuation;
  return Math.max(0, diffMs / MS_PER_YEAR);
}
