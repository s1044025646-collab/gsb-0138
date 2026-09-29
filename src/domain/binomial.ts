import { AppError } from "./errors.ts";
import type {
  ExerciseRegionLayer,
  PricingInputs,
  PricingResult,
} from "./types.ts";

const EPS = 1e-12;

export interface NodeExplanation {
  step: number;
  upMoves: number;
  timeYears: number;
  stockPrice: number;
  continuationValue: number | null;
  exerciseValue: number;
  optionValue: number;
  optimallyExercised: boolean;
}

export interface TreeEvaluation {
  result: PricingResult;
  stock: Float64Array[];
  values: Float64Array[];
  exercise: Uint8Array[];
  inputs: PricingInputs;
}

export function intrinsicValue(
  optionType: PricingInputs["optionType"],
  stock: number,
  strike: number,
): number {
  return optionType === "call"
    ? Math.max(0, stock - strike)
    : Math.max(0, strike - stock);
}

export function evaluateTree(inputs: PricingInputs): TreeEvaluation {
  const {
    optionType,
    style,
    strike,
    underlyingPrice,
    riskFreeRate,
    volatility,
    continuousDividendYield: q,
    steps: n,
  } = inputs;
  const T = inputs.remainingTermYears;
  const dt = T / n;
  const disc = Math.exp(-riskFreeRate * dt);
  const isZeroTime = T <= EPS;
  const isZeroVol = volatility <= EPS;

  let u: number;
  let d: number;
  let a: number;
  let p: number;
  let degenerate = false;

  if (isZeroTime) {
    u = 1;
    d = 1;
    a = 1;
    p = NaN;
    degenerate = true;
  } else if (isZeroVol) {
    u = Math.exp((riskFreeRate - q) * dt);
    d = u;
    a = u;
    p = NaN;
    degenerate = true;
  } else {
    u = Math.exp(volatility * Math.sqrt(dt));
    d = 1 / u;
    a = Math.exp((riskFreeRate - q) * dt);
    p = (a - d) / (u - d);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      throw new AppError(
        "INVALID_PROBABILITY",
        "Risk-neutral up probability falls outside (0, 1); the parameter and step combination is rejected without clipping",
        {
          riskNeutralProbability: Number.isFinite(p) ? p : null,
          upFactor: u,
          downFactor: d,
          growthFactor: a,
          dt,
        },
      );
    }
  }

  const stock: Float64Array[] = new Array(n + 1);
  const values: Float64Array[] = new Array(n + 1);
  const exercise: Uint8Array[] = new Array(n + 1);

  for (let i = 0; i <= n; i += 1) {
    const width = i + 1;
    const stockLayer = new Float64Array(width);
    for (let j = 0; j <= i; j += 1) {
      stockLayer[j] = underlyingPrice * u ** j * d ** (i - j);
    }
    stock[i] = stockLayer;
    values[i] = new Float64Array(width);
    exercise[i] = new Uint8Array(width);
  }

  const terminal = values[n]!;
  const terminalExercise = exercise[n]!;
  for (let j = 0; j <= n; j += 1) {
    const payoff = intrinsicValue(optionType, stock[n]![j]!, strike);
    terminal[j] = payoff;
    if (payoff > 0) {
      terminalExercise[j] = 1;
    }
  }

  for (let i = n - 1; i >= 0; i -= 1) {
    const layer = values[i]!;
    const next = values[i + 1]!;
    const exFlags = exercise[i]!;
    for (let j = 0; j <= i; j += 1) {
      let continuation: number;
      if (degenerate) {
        continuation = disc * next[j + 1]!;
      } else {
        continuation = disc * (p * next[j + 1]! + (1 - p) * next[j]!);
      }
      const sNow = stock[i]![j]!;
      const immediate = intrinsicValue(optionType, sNow, strike);
      if (style === "american" && immediate > continuation) {
        layer[j] = immediate;
        exFlags[j] = 1;
      } else {
        layer[j] = continuation;
      }
    }
  }

  const layers: ExerciseRegionLayer[] = [];
  for (let i = 0; i <= n; i += 1) {
    const nodes: number[] = [];
    for (let j = 0; j <= i; j += 1) {
      if (exercise[i]![j] === 1) {
        nodes.push(j);
      }
    }
    let range: ExerciseRegionLayer["range"] = null;
    if (nodes.length > 0) {
      range = {
        fromIndex: nodes[0]!,
        toIndex: nodes[nodes.length - 1]!,
      };
    }
    layers.push({
      step: i,
      timeYears: i * dt,
      exerciseNodes: nodes,
      range,
      count: nodes.length,
    });
  }

  const rootStock = stock[0]![0]!;
  const rootExerciseValue = intrinsicValue(optionType, rootStock, strike);
  const rootContinuation =
    n === 0
      ? rootExerciseValue
      : degenerate
        ? disc * values[1]![1]!
        : disc * (p * values[1]![1]! + (1 - p) * values[1]![0]!);

  const price = values[0]![0]!;

  return {
    result: {
      price,
      continuationValueAtRoot: rootContinuation,
      exerciseValueAtRoot: rootExerciseValue,
      exercisedAtRoot: exercise[0]![0] === 1,
      riskNeutralProbability: Number.isFinite(p) ? p : null,
      upFactor: u,
      downFactor: d,
      growthFactor: a,
      discountFactor: disc,
      dt,
      layers,
      degenerateZeroVolatility: degenerate,
    },
    stock,
    values,
    exercise,
    inputs,
  };
}

export function explainNode(
  evaluation: TreeEvaluation,
  step: number,
  upMoves: number,
): NodeExplanation {
  const { inputs, stock, values, exercise } = evaluation;
  const n = inputs.steps;
  if (!Number.isInteger(step) || step < 0 || step > n) {
    throw new AppError("VALIDATION_ERROR", "Node step is out of range", {
      step,
      maxStep: n,
    });
  }
  if (!Number.isInteger(upMoves) || upMoves < 0 || upMoves > step) {
    throw new AppError(
      "VALIDATION_ERROR",
      "upMoves must satisfy 0 <= upMoves <= step",
      { step, upMoves },
    );
  }
  const exerciseValue = intrinsicValue(
    inputs.optionType,
    stock[step]![upMoves]!,
    inputs.strike,
  );
  let continuation: number | null = null;
  if (step < n) {
    if (evaluation.result.degenerateZeroVolatility) {
      continuation = evaluation.result.discountFactor * values[step + 1]![upMoves + 1]!;
    } else {
      const p = evaluation.result.riskNeutralProbability;
      if (p === null) {
        throw new AppError(
          "INVALID_PROBABILITY",
          "Internal inconsistency: non-degenerate tree missing risk-neutral probability",
        );
      }
      continuation =
        evaluation.result.discountFactor *
        (p * values[step + 1]![upMoves + 1]! + (1 - p) * values[step + 1]![upMoves]!);
    }
  }
  return {
    step,
    upMoves,
    timeYears: step * evaluation.result.dt,
    stockPrice: stock[step]![upMoves]!,
    continuationValue: continuation,
    exerciseValue,
    optionValue: values[step]![upMoves]!,
    optimallyExercised: exercise[step]![upMoves] === 1,
  };
}
