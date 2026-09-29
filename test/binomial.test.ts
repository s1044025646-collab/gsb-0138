import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTree, explainNode } from "../src/domain/binomial.ts";
import { AppError } from "../src/domain/errors.ts";
import type { PricingInputs } from "../src/domain/types.ts";

const base = (overrides: Partial<PricingInputs> = {}): PricingInputs => ({
  optionType: "call",
  style: "european",
  strike: 100,
  remainingTermYears: 1,
  underlyingPrice: 100,
  riskFreeRate: 0.05,
  volatility: 0.2,
  continuousDividendYield: 0,
  steps: 1,
  ...overrides,
});

describe("CRR binomial engine", () => {
  it("matches a hand-computed one-step European call tree", () => {
    const evaluation = evaluateTree(base({ steps: 1 }));
    const { result, values, stock } = evaluation;
    const u = Math.exp(0.2);
    const d = 1 / u;
    const p = (Math.exp(0.05) - d) / (u - d);
    assert.ok(p > 0 && p < 1);
    assert.ok(Math.abs(result.upFactor - u) < 1e-12);
    assert.ok(Math.abs(result.downFactor - d) < 1e-12);
    assert.ok(Math.abs(result.riskNeutralProbability! - p) < 1e-12);

    const upPayoff = 100 * u - 100;
    const downPayoff = 0;
    const expected = Math.exp(-0.05) * (p * upPayoff + (1 - p) * downPayoff);
    assert.ok(Math.abs(values[1]![1]! - upPayoff) < 1e-10);
    assert.ok(Math.abs(values[1]![0]! - downPayoff) < 1e-10);
    assert.ok(Math.abs(result.price - expected) < 1e-10);
    assert.ok(Math.abs(stock[1]![1]! - 100 * u) < 1e-10);
    assert.ok(!Number.isNaN(result.price));
  });

  it("hand-computes a two-step American put including the early-exercise comparison", () => {
    const K = 100;
    const S0 = 90;
    const r = 0.05;
    const sigma = 0.3;
    const T = 1;
    const inputs = base({
      optionType: "put",
      style: "american",
      underlyingPrice: S0,
      riskFreeRate: r,
      volatility: sigma,
      steps: 2,
    });
    const evaluation = evaluateTree(inputs);
    const dt = T / 2;
    const u = Math.exp(sigma * Math.sqrt(dt));
    const d = 1 / u;
    const disc = Math.exp(-r * dt);
    const p = (Math.exp(r * dt) - d) / (u - d);

    const sUU = S0 * u * u;
    const sUD = S0;
    const sDD = S0 * d * d;
    const vUU = Math.max(0, K - sUU);
    const vUD = Math.max(0, K - sUD);
    const vDD = Math.max(0, K - sDD);

    const contU = disc * (p * vUU + (1 - p) * vUD);
    const exU = Math.max(0, K - S0 * u);
    const vU = Math.max(contU, exU);
    const contD = disc * (p * vUD + (1 - p) * vDD);
    const exD = Math.max(0, K - S0 * d);
    const vD = Math.max(contD, exD);
    const root = disc * (p * vU + (1 - p) * vD);

    assert.ok(Math.abs(evaluation.result.price - root) < 1e-10);
    assert.ok(Math.abs(evaluation.values[1]![0]! - vD) < 1e-10);
    assert.equal(exD > contD, evaluation.exercise[1]![0] === 1);
    if (exD > contD) {
      assert.deepEqual(evaluation.result.layers[1]!.exerciseNodes, [0]);
    }
  });

  it("values zero remaining term as intrinsic value for every style/type", () => {
    for (const optionType of ["call", "put"] as const) {
      for (const style of ["european", "american"] as const) {
        const result = evaluateTree(
          base({ optionType, style, remainingTermYears: 0, underlyingPrice: 103, steps: 5 }),
        ).result;
        const intrinsic = optionType === "call" ? 3 : 0;
        assert.ok(Math.abs(result.price - intrinsic) < 1e-10, `${optionType}-${style}`);
        assert.equal(result.riskNeutralProbability, null);
      }
    }
  });

  it("handles zero volatility with a deterministic branch and never returns NaN", () => {
    const call = evaluateTree(base({ volatility: 0, steps: 4 })).result;
    const forward = 100 * Math.exp(0.05);
    const expected = Math.exp(-0.05) * Math.max(0, forward - 100);
    assert.ok(Math.abs(call.price - expected) < 1e-10);
    assert.equal(call.riskNeutralProbability, null);
    assert.equal(call.degenerateZeroVolatility, true);

    const deepPut = evaluateTree(
      base({ volatility: 0, optionType: "put", underlyingPrice: 50, riskFreeRate: -0.02, steps: 4 }),
    ).result;
    assert.ok(Number.isFinite(deepPut.price));
    assert.ok(deepPut.price > 0);
  });

  it("supports negative interest rates and deep ITM/OTM without NaN", () => {
    const itm = evaluateTree(base({ riskFreeRate: -0.03, underlyingPrice: 200, steps: 10 })).result;
    const otm = evaluateTree(base({ riskFreeRate: -0.03, underlyingPrice: 1, steps: 10 })).result;
    assert.ok(Number.isFinite(itm.price) && itm.price > 90);
    assert.ok(Number.isFinite(otm.price) && otm.price >= 0 && otm.price < 1);
  });

  it("rejects parameter/step combinations that push p out of (0,1) without clipping", () => {
    const invalid = base({ riskFreeRate: -0.8, volatility: 0.01, steps: 1 });
    assert.throws(
      () => evaluateTree(invalid),
      (error: unknown) => error instanceof AppError && error.code === "INVALID_PROBABILITY",
    );
  });

  it("American call without dividends equals the European call and shows no early-exercise region before maturity", () => {
    const common = { continuousDividendYield: 0, steps: 50 };
    const european = evaluateTree(base({ ...common, style: "european" })).result;
    const american = evaluateTree(base({ ...common, style: "american" })).result;
    assert.ok(Math.abs(american.price - european.price) < 1e-10);
    for (let i = 0; i < 50; i += 1) {
      assert.equal(american.layers[i]!.count, 0, `layer ${i} should have no exercise nodes`);
      assert.equal(american.layers[i]!.range, null);
    }
  });

  it("American options respect the intrinsic-value lower bound and European counterpart", () => {
    const inputs = {
      optionType: "put" as const,
      underlyingPrice: 70,
      volatility: 0.35,
      continuousDividendYield: 0.04,
      steps: 100,
    };
    const american = evaluateTree(base({ ...inputs, style: "american" })).result;
    const european = evaluateTree(base({ ...inputs, style: "european" })).result;
    assert.ok(american.price >= european.price - 1e-10);
    assert.ok(american.price >= 30 - 1e-10);
  });

  it("explains a node with continuation, exercise value and decision", () => {
    const evaluation = evaluateTree(
      base({ optionType: "put", style: "american", underlyingPrice: 70, steps: 8 }),
    );
    const node = explainNode(evaluation, 0, 0);
    assert.equal(node.step, 0);
    assert.ok(node.continuationValue !== null);
    assert.ok(Math.abs(node.optionValue - evaluation.result.price) < 1e-10);
    const terminal = explainNode(evaluation, 8, 0);
    assert.equal(terminal.continuationValue, null);
    assert.throws(() => explainNode(evaluation, 9, 0), AppError);
    assert.throws(() => explainNode(evaluation, 2, 5), AppError);
  });
});
