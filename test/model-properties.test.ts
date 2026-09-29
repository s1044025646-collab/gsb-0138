import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTree } from "../src/domain/binomial.ts";
import { computeAllSensitivities } from "../src/domain/greeks.ts";
import { convergenceReport } from "../src/domain/convergence.ts";
import type { PricingInputs } from "../src/domain/types.ts";

const shared = (overrides: Partial<PricingInputs>): PricingInputs => ({
  optionType: "call",
  style: "european",
  strike: 100,
  remainingTermYears: 1,
  underlyingPrice: 100,
  riskFreeRate: 0.04,
  volatility: 0.2,
  continuousDividendYield: 0.03,
  steps: 400,
  ...overrides,
});

function blackScholes(inputs: PricingInputs): number {
  const { underlyingPrice: S, strike: K, riskFreeRate: r, volatility: sigma, continuousDividendYield: q, remainingTermYears: T, optionType } = inputs;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
  if (optionType === "call") {
    return S * Math.exp(-q * T) * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
  }
  return K * Math.exp(-r * T) * cdf(-d2) - S * Math.exp(-q * T) * cdf(-d1);
}

function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  const abs = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * abs);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs);
  return sign * y;
}

describe("parity, convergence, sensitivities and scans", () => {
  it("satisfies put-call parity for European options on the same snapshot", () => {
    const callInputs = shared({});
    const putInputs = shared({ optionType: "put" });
    const call = evaluateTree(callInputs).result.price;
    const put = evaluateTree(putInputs).result.price;
    const lhs = call - put;
    const rhs =
      callInputs.underlyingPrice * Math.exp(-callInputs.continuousDividendYield) -
      callInputs.strike * Math.exp(-callInputs.riskFreeRate);
    assert.ok(Math.abs(lhs - rhs) < 1e-8, `parity gap ${lhs - rhs}`);
  });

  it("converges toward the Black-Scholes value as steps grow", () => {
    const inputs = shared({});
    const bs = blackScholes(inputs);
    const report = convergenceReport(inputs, [10, 25, 50, 100, 200, 400]);
    const coarse = Math.abs(report.points[0]!.price - bs);
    const fine = Math.abs(report.points[report.points.length - 1]!.price - bs);
    assert.ok(fine < coarse);
    assert.ok(fine < 0.01, `fine error ${fine}`);
  });

  it("records bump sizes and full-recomputation method for sensitivities", () => {
    const results = computeAllSensitivities(shared({ steps: 100 }));
    const byKey = new Map(results.map((item) => [item.key, item]));
    for (const item of results) {
      assert.equal(item.method, "central-finite-difference");
      assert.ok(item.bumpAbsolute > 0);
      assert.match(item.recomputation, /full CRR/);
      assert.ok(Number.isFinite(item.value));
    }
    assert.ok((byKey.get("delta")!.value ?? 0) > 0.3);
    assert.ok((byKey.get("vega")!.value ?? 0) > 0);
  });

  it("flags boundary instability for zero-term sensitivities", () => {
    const results = computeAllSensitivities(shared({ remainingTermYears: 0, steps: 50 }));
    assert.ok(results.some((item) => item.boundaryInstable || /unstable/.test(item.note)));
  });

  it("parameter scan is monotone-ish in spot for a call and never NaN", () => {
    const spots = [50, 75, 100, 125, 150];
    const prices = spots.map((spot) => evaluateTree(shared({ underlyingPrice: spot, steps: 60 })).result.price);
    for (let i = 1; i < prices.length; i += 1) {
      assert.ok(prices[i]! >= prices[i - 1]! - 1e-9);
      assert.ok(Number.isFinite(prices[i]!));
    }
  });
});
