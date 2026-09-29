import { evaluateTree } from "./binomial.ts";
import type { PricingInputs } from "./types.ts";

export interface SensitivitySpec {
  key: string;
  field: keyof PricingInputs;
  bumpAbsolute: number;
  relative: boolean;
}

export interface SensitivityResult {
  key: string;
  field: string;
  method: "central-finite-difference";
  bumpAbsolute: number;
  bumpDescription: string;
  basePrice: number;
  upPrice: number;
  downPrice: number;
  value: number;
  recomputation: "full CRR backward induction rebuilt for each bumped input";
  boundaryInstable: boolean;
  note: string;
}

export const DEFAULT_BUMPS: SensitivitySpec[] = [
  { key: "delta", field: "underlyingPrice", bumpAbsolute: 1, relative: false },
  { key: "gamma", field: "underlyingPrice", bumpAbsolute: 1, relative: false },
  { key: "vega", field: "volatility", bumpAbsolute: 0.01, relative: false },
  { key: "rho", field: "riskFreeRate", bumpAbsolute: 0.0001, relative: false },
  { key: "theta", field: "remainingTermYears", bumpAbsolute: 1 / 365, relative: false },
];

export function computeSensitivity(
  inputs: PricingInputs,
  spec: SensitivitySpec,
): SensitivityResult {
  const base = evaluateTree(inputs).result.price;
  const baseFieldValue = inputs[spec.field] as number;
  const upInputs: PricingInputs = {
    ...inputs,
    [spec.field]: baseFieldValue + spec.bumpAbsolute,
  };
  const downInputs: PricingInputs = {
    ...inputs,
    [spec.field]: Math.max(0, baseFieldValue - spec.bumpAbsolute),
  };

  const upPrice = evaluateTree(upInputs).result.price;
  let downPrice: number;
  let boundaryInstable = false;
  if (
    spec.field === "remainingTermYears" ||
    spec.field === "volatility" ||
    spec.field === "underlyingPrice"
  ) {
    if (baseFieldValue <= spec.bumpAbsolute) {
      boundaryInstable = true;
      downPrice = evaluateTree({ ...inputs, [spec.field]: 0 }).result.price;
    } else {
      downPrice = evaluateTree(downInputs).result.price;
    }
  } else {
    downPrice = evaluateTree(downInputs).result.price;
  }

  let value: number;
  if (spec.key === "gamma") {
    value = (upPrice - 2 * base + downPrice) / spec.bumpAbsolute ** 2;
  } else {
    value = (upPrice - downPrice) / (2 * spec.bumpAbsolute);
  }

  if (spec.key === "theta") {
    value = -(upPrice - downPrice) / (2 * spec.bumpAbsolute);
  }

  const notes: string[] = [];
  if (boundaryInstable) {
    notes.push(
      "Base value is within one bump of the zero boundary; the downward leg was evaluated at zero and the finite-difference estimate may be one-sided/unstable.",
    );
  }
  if (inputs.volatility <= 1e-12) {
    notes.push("Base volatility is zero: bumped vega crosses the degenerate zero-volatility branch and may be unstable.");
  }
  if (inputs.remainingTermYears <= 1e-12) {
    notes.push("Base term is zero: theta/gamma near expiry are kink-sensitive and may be unstable.");
  }

  return {
    key: spec.key,
    field: spec.field,
    method: "central-finite-difference",
    bumpAbsolute: spec.bumpAbsolute,
    bumpDescription: `${spec.field} ± ${spec.bumpAbsolute} (absolute units, annualized where applicable)`,
    basePrice: base,
    upPrice,
    downPrice,
    value,
    recomputation: "full CRR backward induction rebuilt for each bumped input",
    boundaryInstable,
    note: notes.length > 0 ? notes.join(" ") : "Central difference with two full re-evaluations.",
  };
}

export function computeAllSensitivities(inputs: PricingInputs): SensitivityResult[] {
  return DEFAULT_BUMPS.map((spec) => computeSensitivity(inputs, spec));
}
