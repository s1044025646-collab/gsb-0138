import { evaluateTree } from "./binomial.ts";
import type { PricingInputs } from "./types.ts";

export interface ConvergencePoint {
  steps: number;
  price: number;
  deltaFromPrevious: number | null;
}

export interface ConvergenceReport {
  stepGrid: number[];
  points: ConvergencePoint[];
  referenceSteps: number;
  referencePrice: number;
}

export function convergenceReport(
  base: PricingInputs,
  stepGrid: number[],
): ConvergenceReport {
  const unique = [...new Set(stepGrid)].sort((a, b) => a - b);
  if (unique.length === 0) {
    throw new Error("stepGrid must not be empty");
  }
  const points: ConvergencePoint[] = [];
  let previous: number | null = null;
  for (const steps of unique) {
    const price = evaluateTree({ ...base, steps }).result.price;
    points.push({
      steps,
      price,
      deltaFromPrevious: previous === null ? null : price - previous,
    });
    previous = price;
  }
  const reference = points[points.length - 1]!;
  return {
    stepGrid: unique,
    points,
    referenceSteps: reference.steps,
    referencePrice: reference.price,
  };
}
