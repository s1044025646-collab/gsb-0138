import type {
  ExerciseStyle,
  OptionType,
  PricingInputs,
} from "./types.ts";
import { AppError } from "./errors.ts";

export const MAX_STEPS = 2000;

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' must be a finite number`,
      { field, received: String(value) },
    );
  }
  return value;
}

export function nonNegativeNumber(value: unknown, field: string): number {
  const num = finiteNumber(value, field);
  if (num < 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' must be non-negative`,
      { field, received: num },
    );
  }
  return num;
}

export function positiveNumber(value: unknown, field: string): number {
  const num = finiteNumber(value, field);
  if (num <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' must be strictly positive`,
      { field, received: num },
    );
  }
  return num;
}

export function optionType(value: unknown): OptionType {
  if (value !== "call" && value !== "put") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Field 'optionType' must be 'call' or 'put'",
      { received: String(value) },
    );
  }
  return value;
}

export function exerciseStyle(value: unknown): ExerciseStyle {
  if (value !== "european" && value !== "american") {
    throw new AppError(
      "VALIDATION_ERROR",
      "Field 'style' must be 'european' or 'american'",
      { received: String(value) },
    );
  }
  return value;
}

export function validateDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' must be an ISO calendar date (YYYY-MM-DD)`,
      { received: String(value) },
    );
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' is not a valid calendar date`,
      { received: String(value) },
    );
  }
  return value;
}

export function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' must be an ISO 8601 timestamp string`,
      { received: String(value) },
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field '${field}' is not a valid ISO 8601 timestamp`,
      { received: value },
    );
  }
  return parsed.toISOString();
}

export function validateSteps(value: unknown): number {
  const steps = finiteNumber(value, "steps");
  if (!Number.isInteger(steps) || steps <= 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Field 'steps' must be a positive integer",
      { received: value },
    );
  }
  if (steps > MAX_STEPS) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Field 'steps' must not exceed ${MAX_STEPS}`,
      { received: steps, max: MAX_STEPS },
    );
  }
  return steps;
}

export function validatePricingInputs(input: unknown): PricingInputs {
  if (typeof input !== "object" || input === null) {
    throw new AppError("VALIDATION_ERROR", "Pricing inputs must be an object");
  }
  const record = input as Record<string, unknown>;
  const steps = validateSteps(record.steps);
  return {
    optionType: optionType(record.optionType),
    style: exerciseStyle(record.style),
    strike: positiveNumber(record.strike, "strike"),
    remainingTermYears: nonNegativeNumber(
      record.remainingTermYears,
      "remainingTermYears",
    ),
    underlyingPrice: nonNegativeNumber(
      record.underlyingPrice,
      "underlyingPrice",
    ),
    riskFreeRate: finiteNumber(record.riskFreeRate, "riskFreeRate"),
    volatility: nonNegativeNumber(record.volatility, "volatility"),
    continuousDividendYield: nonNegativeNumber(
      record.continuousDividendYield,
      "continuousDividendYield",
    ),
    steps,
  };
}

export function validatePagination(
  query: URLSearchParams,
): { limit: number; offset: number } {
  const limitRaw = query.get("limit") ?? "50";
  const offsetRaw = query.get("offset") ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (
    !Number.isInteger(limit) ||
    !Number.isInteger(offset) ||
    limit <= 0 ||
    limit > 200 ||
    offset < 0
  ) {
    throw new AppError(
      "INVALID_PAGINATION",
      "Query params require 1 <= limit <= 200 and offset >= 0, both integers",
      { limit: limitRaw, offset: offsetRaw },
    );
  }
  return { limit, offset };
}
