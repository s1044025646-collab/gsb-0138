export type OptionType = "call" | "put";
export type ExerciseStyle = "european" | "american";

export interface Contract {
  id: string;
  idempotencyKey: string | null;
  code: string;
  optionType: OptionType;
  style: ExerciseStyle;
  strike: number;
  maturityDate: string;
  continuousDividendYield: number;
  contractUnit: number;
  note: string | null;
  createdAt: string;
}

export interface MarketSnapshot {
  id: string;
  idempotencyKey: string | null;
  contractId: string;
  valuationTime: string;
  underlyingPrice: number;
  riskFreeRate: number;
  volatility: number;
  steps: number;
  note: string | null;
  createdAt: string;
}

export interface PricingInputs {
  optionType: OptionType;
  style: ExerciseStyle;
  strike: number;
  remainingTermYears: number;
  underlyingPrice: number;
  riskFreeRate: number;
  volatility: number;
  continuousDividendYield: number;
  steps: number;
}

export interface ExerciseRegionLayer {
  step: number;
  timeYears: number;
  exerciseNodes: number[];
  range: { fromIndex: number; toIndex: number } | null;
  count: number;
}

export interface PricingResult {
  price: number;
  continuationValueAtRoot: number;
  exerciseValueAtRoot: number;
  exercisedAtRoot: boolean;
  riskNeutralProbability: number | null;
  upFactor: number;
  downFactor: number;
  growthFactor: number;
  discountFactor: number;
  dt: number;
  layers: ExerciseRegionLayer[];
  degenerateZeroVolatility: boolean;
}
