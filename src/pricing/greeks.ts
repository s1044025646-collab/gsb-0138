import { price } from "./crr.js";
import { PricingError, PricingInputs, PricingResult } from "./types.js";

export interface SensitivitySpec {
  /** Input field bumped. */
  parameter: "spot" | "strike" | "volatility" | "riskFreeRate" | "dividendYield" | "maturityYears";
  /** Absolute bump size in the parameter's own units. */
  bump: number;
  /** "central" (default) or "forward"/"backward". */
  scheme?: "central" | "forward" | "backward";
}

export interface SensitivityResult {
  parameter: SensitivitySpec["parameter"];
  bump: number;
  scheme: "central" | "forward" | "backward";
  /** d(price)/d(parameter). */
  value: number;
  /** Standard greek name when applicable. */
  greek: string | null;
  basePrice: number;
  upPrice: number;
  downPrice: number | null;
  /**
   * True when the finite-difference estimate is flagged as potentially
   * unstable at a boundary (e.g. sigma=0 bumped backward, T=0 bumped
   * backward, or any reprice produced a rejected/non-finite result).
   */
  boundaryInstable: boolean;
  notes: string[];
}

const GREEK_NAMES: Record<SensitivitySpec["parameter"], string | null> = {
  spot: "delta",
  volatility: "vega",
  riskFreeRate: "rho",
  maturityYears: "theta-note:-per-year-not-per-day",
  strike: "dPrice/dStrike",
  dividendYield: "dPrice/dDividendYield",
};

function bumped(base: PricingInputs, param: SensitivitySpec["parameter"], delta: number): PricingInputs {
  return { ...base, [param]: (base[param] as number) + delta };
}

/**
 * Price sensitivity by finite differences. Every result records the bump
 * size and the exact reprice convention (same steps, full CRR rebuild).
 * Boundary instability is flagged, never hidden.
 */
export function sensitivity(base: PricingInputs, spec: SensitivitySpec): SensitivityResult {
  const scheme = spec.scheme ?? "central";
  if (!(spec.bump > 0) || !Number.isFinite(spec.bump)) {
    throw new PricingError("INVALID_INPUT", "bump must be a finite number > 0");
  }
  const notes: string[] = [
    `finite-difference ${scheme}; absolute bump=${spec.bump}; both legs reprice a fresh CRR tree with identical steps=${base.steps}.`,
  ];

  const baseRes: PricingResult = price(base);
  let value: number;
  let upPrice: number;
  let downPrice: number | null = null;
  let unstable = false;

  const tryPrice = (inp: PricingInputs): number | null => {
    try {
      return price(inp).price;
    } catch (err) {
      if (err instanceof PricingError) {
        notes.push(`bumped leg rejected (${err.code}: ${err.message}); one-sided fallback used.`);
        return null;
      }
      throw err;
    }
  };

  if (scheme === "central") {
    const pu = tryPrice(bumped(base, spec.parameter, spec.bump));
    const pd = tryPrice(bumped(base, spec.parameter, -spec.bump));
    if (pu !== null && pd !== null) {
      upPrice = pu;
      downPrice = pd;
      value = (pu - pd) / (2 * spec.bump);
    } else if (pu !== null) {
      upPrice = pu;
      value = (pu - baseRes.price) / spec.bump;
      unstable = true;
    } else if (pd !== null) {
      downPrice = pd;
      upPrice = baseRes.price;
      value = (baseRes.price - pd) / spec.bump;
      unstable = true;
    } else {
      throw new PricingError("INVALID_INPUT", "both bumped legs failed to reprice");
    }
  } else if (scheme === "forward") {
    const pu = tryPrice(bumped(base, spec.parameter, spec.bump));
    if (pu === null) throw new PricingError("INVALID_INPUT", "forward bumped leg failed to reprice");
    upPrice = pu;
    value = (pu - baseRes.price) / spec.bump;
  } else {
    const pd = tryPrice(bumped(base, spec.parameter, -spec.bump));
    if (pd === null) throw new PricingError("INVALID_INPUT", "backward bumped leg failed to reprice");
    downPrice = pd;
    upPrice = baseRes.price;
    value = (baseRes.price - pd) / spec.bump;
  }

  // Boundary flags.
  const atZeroBoundary =
    (spec.parameter === "volatility" && base.volatility === 0) ||
    (spec.parameter === "maturityYears" && base.maturityYears === 0) ||
    (spec.parameter === "dividendYield" && base.dividendYield === 0);
  if (atZeroBoundary && scheme === "central") {
    unstable = true;
    notes.push(`central difference at ${spec.parameter}=0 crosses a hard domain boundary; treat estimate with caution.`);
  }

  return {
    parameter: spec.parameter,
    bump: spec.bump,
    scheme,
    value,
    greek: GREEK_NAMES[spec.parameter],
    basePrice: baseRes.price,
    upPrice,
    downPrice,
    boundaryInstable: unstable,
    notes,
  };
}

export interface ConvergencePoint {
  steps: number;
  price: number;
  rejected: boolean;
  errorCode?: string;
}

/**
 * Reprice across increasing step counts using one frozen input snapshot.
 * Rejected (steps, parameter) combinations are recorded, not thrown, so a
 * scan can show exactly where probability feasibility fails.
 */
export function convergence(
  base: PricingInputs,
  stepCounts: number[],
): { points: ConvergencePoint[]; accepted: ConvergencePoint[] } {
  const points = stepCounts.map((steps) => {
    try {
      const r = price({ ...base, steps });
      return { steps, price: r.price, rejected: false } satisfies ConvergencePoint;
    } catch (err) {
      if (err instanceof PricingError) {
        return { steps, price: NaN, rejected: true, errorCode: err.code } satisfies ConvergencePoint;
      }
      throw err;
    }
  });
  return { points, accepted: points.filter((p) => !p.rejected) };
}
