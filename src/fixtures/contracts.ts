/**
 * Fully fictitious contracts and market quotes for numerical demonstration.
 * Nothing here is a real instrument or a live market price.
 */
export interface FixtureContract {
  code: string;
  optionType: "call" | "put";
  style: "european" | "american";
  strike: number;
  /** ISO date; demo anchors valuation at FIXED_NOW. */
  maturityDate: string;
  annualVolatility: number;
  continuousDividendYield: number;
}

export interface FixtureSnapshot {
  contractCode: string;
  label: string;
  spot: number;
  riskFreeRate: number;
}

/** Fixed valuation instant so the demo is fully reproducible. */
export const FIXED_NOW = "2026-01-01T00:00:00.000Z";

export const FIXTURE_CONTRACTS: FixtureContract[] = [
  // Non-dividend-paying American call -> never early exercise (fixture 1).
  {
    code: "FAKE-AMCALL-NODIV",
    optionType: "call",
    style: "american",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.2,
    continuousDividendYield: 0,
  },
  // American put -> clear early-exercise region (fixture 2).
  {
    code: "FAKE-AMPUT-ITM",
    optionType: "put",
    style: "american",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.25,
    continuousDividendYield: 0,
  },
  // European pair for put-call parity checks (same T, q).
  {
    code: "FAKE-EUCALL",
    optionType: "call",
    style: "european",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.2,
    continuousDividendYield: 0.03,
  },
  {
    code: "FAKE-EUPUT",
    optionType: "put",
    style: "european",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.2,
    continuousDividendYield: 0.03,
  },
  // At-expiry contract: maturity == valuation instant.
  {
    code: "FAKE-EXPIRED-CALL",
    optionType: "call",
    style: "european",
    strike: 100,
    maturityDate: "2026-01-01",
    annualVolatility: 0.2,
    continuousDividendYield: 0,
  },
  // Zero volatility.
  {
    code: "FAKE-ZEROVOL-PUT",
    optionType: "put",
    style: "european",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0,
    continuousDividendYield: 0,
  },
];

export const FIXTURE_SNAPSHOTS: FixtureSnapshot[] = [
  { contractCode: "FAKE-AMCALL-NODIV", label: "at-the-money demo quote", spot: 100, riskFreeRate: 0.05 },
  { contractCode: "FAKE-AMPUT-ITM", label: "deep ITM put demo quote", spot: 60, riskFreeRate: 0.05 },
  { contractCode: "FAKE-EUCALL", label: "parity quote", spot: 100, riskFreeRate: 0.04 },
  { contractCode: "FAKE-EUPUT", label: "parity quote", spot: 100, riskFreeRate: 0.04 },
  { contractCode: "FAKE-EXPIRED-CALL", label: "expiry ITM quote", spot: 110, riskFreeRate: 0.05 },
  { contractCode: "FAKE-EXPIRED-CALL", label: "expiry OTM quote", spot: 90, riskFreeRate: 0.05 },
  { contractCode: "FAKE-ZEROVOL-PUT", label: "deterministic quote", spot: 90, riskFreeRate: 0.03 },
];
