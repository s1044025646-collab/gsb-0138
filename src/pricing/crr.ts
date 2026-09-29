import {
  NodeAddress,
  NodeExplanation,
  PricingError,
  PricingInputs,
  PricingResult,
} from "./types.js";

const EPS = 1e-12;

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Validate pricing inputs. Throws PricingError("INVALID_INPUT") for domain
 * violations and PricingError("INVALID_PROBABILITY") when the CRR risk
 * neutral probability falls outside [0,1]. Probabilities are never silently
 * clipped.
 */
export function validateInputs(input: PricingInputs): void {
  const errors: string[] = [];
  const requireNonNeg = (name: keyof PricingInputs) => {
    const v = input[name];
    if (!finiteNumber(v) || (v as number) < 0) errors.push(`${String(name)} must be a finite number >= 0`);
  };
  const requirePos = (name: keyof PricingInputs) => {
    const v = input[name];
    if (!finiteNumber(v) || (v as number) <= 0) errors.push(`${String(name)} must be a finite number > 0`);
  };

  requirePos("spot");
  requirePos("strike");
  requireNonNeg("maturityYears");
  if (!finiteNumber(input.riskFreeRate)) errors.push("riskFreeRate must be a finite number (negative allowed)");
  requireNonNeg("dividendYield");
  requireNonNeg("volatility");
  if (!Number.isInteger(input.steps) || input.steps < 1) {
    errors.push("steps must be an integer >= 1");
  }
  if (input.optionType !== "call" && input.optionType !== "put") {
    errors.push("optionType must be 'call' or 'put'");
  }
  if (input.style !== "european" && input.style !== "american") {
    errors.push("style must be 'european' or 'american'");
  }
  if (errors.length > 0) throw new PricingError("INVALID_INPUT", errors.join("; "));

  // Probability feasibility. At T=0 (dt=0) there is no live transition so the
  // p check is skipped: the value is pure intrinsic.
  const { maturityYears: T, volatility: sigma, riskFreeRate: r, dividendYield: q, steps: n } = input;
  if (T > 0 && sigma > 0) {
    const dt = T / n;
    const u = Math.exp(sigma * Math.sqrt(dt));
    const d = 1 / u;
    const a = Math.exp((r - q) * dt);
    const p = (a - d) / (u - d);
    if (!Number.isFinite(p) || p < -EPS || p > 1 + EPS) {
      throw new PricingError(
        "INVALID_PROBABILITY",
        `risk-neutral probability p=${p} is outside [0,1] for steps=${n}; ` +
          `reject this (steps, parameter) combination instead of clipping. ` +
          `Typical cause: dt too large relative to |r-q|, i.e. too few steps for the rate/yield level.`,
      );
    }
  }
}

export function payoff(optionType: "call" | "put", s: number, k: number): number {
  return optionType === "call" ? Math.max(0, s - k) : Math.max(0, k - s);
}

/**
 * Build the CRR lattice and backward-induct.
 *
 * Special cases with explainable, finite results:
 * - T = 0: value is intrinsic today; a degenerate flat grid is still emitted
 *   (u = d = 1, p reported as null-equivalent 0.5 placeholder via mode flag).
 * - sigma = 0 with T > 0: deterministic drift grid u = d = exp((r-q) dt).
 *   Backward induction still applies; p is undefined for a degenerate tree
 *   and is reported as 1 (all mass follows the single deterministic branch),
 *   but the node value equals discounted expected value either way.
 */
export function price(input: PricingInputs): PricingResult {
  validateInputs(input);
  const {
    spot: S0,
    strike: K,
    maturityYears: T,
    riskFreeRate: r,
    dividendYield: q,
    volatility: sigma,
    optionType,
    style,
    steps: n,
  } = input;

  const dt = T / n;
  const isAmerican = style === "american";

  let u: number;
  let d: number;
  let p: number;
  let mode: "standard-crr" | "zero-volatility-degenerate";

  if (T === 0 || sigma === 0) {
    mode = "zero-volatility-degenerate";
    // Deterministic gross drift per step; for T=0 dt=0 so u=d=1.
    u = Math.exp((r - q) * dt);
    d = u;
    // Degenerate tree: both children coincide. p carries no economic meaning;
    // report 0.5 (any value gives the same expectation since u=d).
    p = 0.5;
  } else {
    mode = "standard-crr";
    u = Math.exp(sigma * Math.sqrt(dt));
    d = 1 / u;
    p = (Math.exp((r - q) * dt) - d) / (u - d);
    // Defensive: validateInputs already rejected out-of-range p.
    if (p < 0 || p > 1) {
      throw new PricingError("INVALID_PROBABILITY", `p=${p} outside [0,1]`);
    }
  }

  const disc = Math.exp(-r * dt);

 // Grid of carried values V[i][j].
  const V: number[][] = Array.from({ length: n + 1 }, () => new Array<number>());
  const cont: number[][] = Array.from({ length: n + 1 }, () => new Array<number>());
  const exVal: number[][] = Array.from({ length: n + 1 }, () => new Array<number>());
  const S: number[][] = Array.from({ length: n + 1 }, () => new Array<number>());

  // Terminal layer i = n.
  for (let j = 0; j <= n; j++) {
    const s = S0 * Math.pow(u, j) * Math.pow(d, n - j);
    S[n]![j] = s;
    const intrinsic = payoff(optionType, s, K);
    V[n]![j] = intrinsic;
    cont[n]![j] = intrinsic;
    exVal[n]![j] = intrinsic;
  }

  // Backward induction.
  for (let i = n - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const s = S0 * Math.pow(u, j) * Math.pow(d, i - j);
      S[i]![j] = s;
      const upVal = V[i + 1]![j + 1]!;
      const dnVal = V[i + 1]![j]!;
      const continuation = disc * (p * upVal + (1 - p) * dnVal);
      const exercise = payoff(optionType, s, K);
      cont[i]![j] = continuation;
      exVal[i]![j] = exercise;
      // American: compare continuation vs immediate exercise node by node.
      // European: never exercise before expiry (no blanket European formula
      // applied to American nodes).
      V[i]![j] = isAmerican ? Math.max(continuation, exercise) : continuation;
    }
  }

  // Build node explanations and exercise regions.
  const nodes: NodeExplanation[][] = [];
  const exerciseRegions = [];
  let earlyCount = 0;
  for (let i = 0; i <= n; i++) {
    const layerNodes: NodeExplanation[] = [];
    const exNodes: number[] = [];
    const exPrices: number[] = [];
    for (let j = 0; j <= i; j++) {
      const cv = cont[i]![j]!;
      const ev = exVal[i]![j]!;
      const carried = V[i]![j]!;
      // Strict comparison: exercise only when it beats continuation by a
      // meaningful margin. Equality -> continue (no spurious exercise region).
      const early = isAmerican && i < n && ev > cv + 1e-12 && ev > 0;
      if (early) {
        exNodes.push(j);
        exPrices.push(S[i]![j]!);
        earlyCount++;
      }
      layerNodes.push({
        layer: i,
        upMoves: j,
        underlyingPrice: S[i]![j]!,
        continuationValue: cv,
        exerciseValue: ev,
        nodeValue: carried,
        earlyExercise: early,
      });
    }
    nodes.push(layerNodes);
    let contiguous = exNodes.length <= 1;
    if (exNodes.length > 1) {
      contiguous = exNodes.every((jj, idx) => idx === 0 || jj === exNodes[idx - 1]! + 1);
    }
    exerciseRegions.push({
      layer: i,
      timeYears: i * dt,
      exerciseNodes: exNodes,
      exercisePrices: exPrices,
      contiguous,
    });
  }

  return {
    price: V[0]![0]!,
    up: u,
    down: d,
    dt,
    discount: disc,
    riskNeutralProbability: p,
    exerciseRegions,
    earlyExerciseNodeCount: earlyCount,
    terminalValues: V[n]!,
    nodes,
    meta: { optionType, style, steps: n, latticeMode: mode },
  };
}

export function explainNode(result: PricingResult, addr: NodeAddress): NodeExplanation {
  const layer = result.nodes[addr.layer];
  const node = layer?.[addr.upMoves];
  if (!node) {
    throw new PricingError(
      "NODE_NOT_FOUND",
      `node (layer=${addr.layer}, upMoves=${addr.upMoves}) does not exist; ` +
        `layer must be 0..${result.meta.steps} and upMoves 0..layer.`,
    );
  }
  return node;
}
