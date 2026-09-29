/**
 * Domain types for the CRR binomial pricer.
 *
 * Conventions (stated explicitly throughout the codebase):
 * - Volatility `sigma` is a per-annum decimal (e.g. 0.20 = 20%).
 * - Risk-free rate `r` is continuously compounded, per annum, decimal.
 *   Negative rates are allowed.
 * - Dividend yield `q` is a continuous, continuously compounded per-annum
 *   decimal. Discrete cash dividends are NOT supported and must never be
 *   encoded into `q`.
 * - Time to expiry `T` is in years, ACT/365 fixed day count (days / 365).
 * - Discounting uses exp(-r * dt) on every one-step backward induction.
 * - The CRR lattice uses u = exp(sigma sqrt(dt)), d = 1/u and the
 *   risk-neutral up probability p = (exp((r - q) dt) - d) / (u - d).
 */

export type OptionType = "call" | "put";
export type ExerciseStyle = "european" | "american";

export interface PricingInputs {
  /** Spot price of the underlying, S0 > 0. */
  spot: number;
  /** Strike, K > 0. */
  strike: number;
  /** Time to expiry in years, T >= 0. */
  maturityYears: number;
  /** Continuously compounded risk-free rate (annual, decimal); may be < 0. */
  riskFreeRate: number;
  /** Continuous dividend yield (annual, decimal), q >= 0. */
  dividendYield: number;
  /** Annual volatility, decimal; sigma >= 0. */
  volatility: number;
  optionType: OptionType;
  style: ExerciseStyle;
  /** Number of binomial steps, integer >= 1 (>=2 allowed for T=0 grids). */
  steps: number;
}

/** A single node addressed by (time layer i, up-move count j). */
export interface NodeAddress {
  /** Time layer, 0 = today, n = expiry. */
  layer: number;
  /** Number of up moves from root, 0 <= j <= i. */
  upMoves: number;
}

export interface NodeExplanation extends NodeAddress {
  /** Underlying price S(i,j) = S0 u^j d^(i-j). */
  underlyingPrice: number;
  /** Continuation (discounted expectation) value at the node. */
  continuationValue: number;
  /** Immediate exercise payoff (intrinsic) at the node. */
  exerciseValue: number;
  /** Value actually carried backward: max for American, continuation for European. */
  nodeValue: number;
  /** True only when American and exerciseValue > continuationValue. */
  earlyExercise: boolean;
}

/** Early-exercise region for one time layer. */
export interface LayerExerciseRegion {
  layer: number;
  /** Time in years for this layer. */
  timeYears: number;
  /**
   * Indices j (up moves) where immediate exercise is strictly optimal.
   * Empty array means "no early-exercise nodes in this layer" and is an
   * explicit, meaningful result (never null/undefined).
   */
  exerciseNodes: number[];
  /** Underlying prices at the exercise nodes, same order. */
  exercisePrices: number[];
  /** True when the exercised nodes form a single contiguous block. */
  contiguous: boolean;
}

export interface PricingResult {
  price: number;
  /** CRR lattice parameters. */
  up: number;
  down: number;
  dt: number;
  /** One-step discount factor exp(-r dt). */
  discount: number;
  /** Risk-neutral up probability. */
  riskNeutralProbability: number;
  exerciseRegions: LayerExerciseRegion[];
  /** Total count of nodes where early exercise is optimal (American only). */
  earlyExerciseNodeCount: number;
  /** Terminal payoff values at expiry layer, length n+1. */
  terminalValues: number[];
  /** Full node grid, indexed [i][j], available for node explanation. */
  nodes: NodeExplanation[][];
  meta: {
    optionType: OptionType;
    style: ExerciseStyle;
    steps: number;
    /** "standard-crr" | "zero-volatility-degenerate". */
    latticeMode: "standard-crr" | "zero-volatility-degenerate";
  };
}

/** Error with a stable machine-readable code. */
export class PricingError extends Error {
 constructor(
    public code:
      | "INVALID_INPUT"
      | "INVALID_PROBABILITY"
      | "NODE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "PricingError";
  }
}
