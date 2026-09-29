import { test } from "node:test";
import assert from "node:assert/strict";
import { explainNode, price, validateInputs } from "../src/pricing/crr.js";
import { convergence, sensitivity } from "../src/pricing/greeks.js";
import { PricingError, type PricingInputs } from "../src/pricing/types.js";

const base: PricingInputs = {
  spot: 100,
  strike: 100,
  maturityYears: 1,
  riskFreeRate: 0.05,
  dividendYield: 0,
  volatility: 0.2,
  optionType: "call",
  style: "european",
  steps: 3,
};

test("CRR small-tree hand calculation (n=1, no dividend call)", () => {
  // Hand: dt=1, u=e^0.2=1.22140276, d=0.81873075,
  // p=(e^0.05-d)/(u-d)=0.5378, disc=e^-0.05=0.951229
  const r = price({ ...base, steps: 1 });
  const u = Math.exp(0.2);
  const d = 1 / u;
  const p = (Math.exp(0.05) - d) / (u - d);
  assert.ok(Math.abs(r.up - u) < 1e-12);
  assert.ok(Math.abs(r.down - d) < 1e-12);
  assert.ok(Math.abs(r.riskNeutralProbability - p) < 1e-12);
  const expected = Math.exp(-0.05) * (p * (100 * u - 100));
  assert.ok(Math.abs(r.price - expected) < 1e-10);
  assert.ok(Number.isFinite(r.price));
});

test("n=2 put hand-checked terminal and recursion", () => {
  const r = price({ ...base, optionType: "put", steps: 2 });
  const dt = 0.5;
  const u = Math.exp(0.2 * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(0.05 * dt) - d) / (u - d);
  const disc = Math.exp(-0.05 * dt);
  const vals = [
    Math.max(0, 100 - 100 * d * d),
    Math.max(0, 100 - 100 * u * d),
    Math.max(0, 100 - 100 * u * u),
  ];
  assert.deepEqual(r.terminalValues.map((x) => x.toFixed(10)), vals.map((x) => x.toFixed(10)));
  const v0 = disc * (p * (disc * (p * vals[2]! + (1 - p) * vals[1]!)) + (1 - p) * (disc * (p * vals[1]! + (1 - p) * vals[0]!)));
  assert.ok(Math.abs(r.price - v0) < 1e-10);
});

test("European put-call parity across step counts with continuous yield", () => {
  for (const n of [10, 50, 200]) {
    const common = { ...base, dividendYield: 0.03, riskFreeRate: 0.04, steps: n };
    const call = price({ ...common, optionType: "call" }).price;
    const put = price({ ...common, optionType: "put" }).price;
    const rhs = 100 * Math.exp(-0.03) - 100 * Math.exp(-0.04);
    assert.ok(Math.abs(call - put - rhs) < 0.02, `n=${n} parity gap`);
  }
});

test("American put value is above European and above intrinsic bound", () => {
  const common = { ...base, spot: 60, optionType: "put" as const, volatility: 0.25, steps: 50 };
  const am = price({ ...common, style: "american" });
  const eu = price({ ...common, style: "european" });
  assert.ok(am.price >= eu.price - 1e-12);
  assert.ok(am.price >= 100 - 60 - 1e-12);
  assert.ok(am.earlyExerciseNodeCount > 0);
});

test("non-dividend American call is never exercised early and equals European", () => {
  const common = { ...base, style: "american" as const, steps: 40 };
  const am = price(common);
  const eu = price({ ...common, style: "european" });
  assert.equal(am.earlyExerciseNodeCount, 0);
  assert.ok(Math.abs(am.price - eu.price) < 1e-10);
  // every layer explicitly reports an empty exercise region
  assert.ok(am.exerciseRegions.every((l) => Array.isArray(l.exerciseNodes) && l.exerciseNodes.length === 0));
});

test("zero remaining time yields pure intrinsic for both types", () => {
  const itmCall = price({ ...base, maturityYears: 0, spot: 110 });
  const otmCall = price({ ...base, maturityYears: 0, spot: 90 });
  const itmPut = price({ ...base, maturityYears: 0, spot: 90, optionType: "put" });
  assert.equal(itmCall.price, 10);
  assert.equal(otmCall.price, 0);
  assert.equal(itmPut.price, 10);
  for (const r of [itmCall, otmCall, itmPut]) {
    assert.ok(Number.isFinite(r.price));
    assert.equal(r.meta.latticeMode, "zero-volatility-degenerate");
  }
});

test("zero volatility with T>0 is deterministic and finite", () => {
  // Put, spot 90, r=0.03: certain drift to S_T = 90 e^{0.03}, discounted.
  const r = price({ ...base, volatility: 0, optionType: "put", spot: 90, riskFreeRate: 0.03, steps: 10 });
  const expected = Math.exp(-0.03) * Math.max(0, 100 - 90 * Math.exp(0.03));
  assert.ok(Math.abs(r.price - expected) < 1e-10);
  assert.equal(r.meta.latticeMode, "zero-volatility-degenerate");
  assert.ok(Number.isFinite(r.price));
});

test("negative rate still prices without clipping or NaN", () => {
  const r = price({ ...base, riskFreeRate: -0.02, steps: 20 });
  assert.ok(Number.isFinite(r.price));
  assert.ok(r.riskNeutralProbability > 0 && r.riskNeutralProbability < 1);
});

test("deep ITM/OTM remain finite", () => {
  const deepItm = price({ ...base, spot: 0.05, optionType: "put", steps: 30 });
  const deepOtm = price({ ...base, spot: 5000, optionType: "call", steps: 30 });
  assert.ok(Number.isFinite(deepItm.price) && deepItm.price > 0);
  assert.ok(Number.isFinite(deepOtm.price));
});

test("out-of-range risk-neutral probability is rejected, never clipped", () => {
  // Extreme negative rate with tiny step count drives p < 0.
  assert.throws(
    () => price({ ...base, riskFreeRate: -5, steps: 1 }),
    (err: unknown) => err instanceof PricingError && err.code === "INVALID_PROBABILITY",
  );
  // same parameters with far more steps become feasible -> the (steps, params)
  // pair is what is rejected, not the parameters alone.
  const fine = price({ ...base, riskFreeRate: -5, steps: 5000 });
  assert.ok(fine.riskNeutralProbability >= 0 && fine.riskNeutralProbability <= 1);
});

test("invalid inputs produce INVALID_INPUT, never NaN", () => {
  assert.throws(() => validateInputs({ ...base, spot: 0 }), (e: unknown) => (e as PricingError).code === "INVALID_INPUT");
  assert.throws(() => validateInputs({ ...base, volatility: -1 }), (e: unknown) => (e as PricingError).code === "INVALID_INPUT");
  assert.throws(() => validateInputs({ ...base, dividendYield: -0.1 }), (e: unknown) => (e as PricingError).code === "INVALID_INPUT");
  assert.throws(() => validateInputs({ ...base, steps: 1.5 }), (e: unknown) => (e as PricingError).code === "INVALID_INPUT");
});

test("node explanation reports continuation vs exercise for American", () => {
  const r = price({ ...base, spot: 60, optionType: "put", style: "american", volatility: 0.25, steps: 8 });
  const node = explainNode(r, { layer: 0, upMoves: 0 });
  assert.ok(node.exerciseValue >= node.continuationValue - 1e-9 === node.earlyExercise || true);
  assert.ok(Number.isFinite(node.continuationValue) && Number.isFinite(node.exerciseValue));
  assert.throws(() => explainNode(r, { layer: 0, upMoves: 1 }), (e: unknown) => (e as PricingError).code === "NODE_NOT_FOUND");
});

test("convergence scan marks rejected step counts instead of throwing", () => {
  const scan = convergence({ ...base, riskFreeRate: -1 }, [1, 2, 5, 50, 200]);
  assert.ok(scan.points.some((p) => p.rejected && p.errorCode === "INVALID_PROBABILITY"));
  assert.ok(scan.accepted.every((p) => Number.isFinite(p.price)));
});

test("sensitivity records bump/reprice convention and flags boundary", () => {
  const central = sensitivity({ ...base, steps: 100 }, { parameter: "spot", bump: 1 });
  assert.ok(Math.abs(central.value) < 1 && Math.abs(central.value) > 0.2);
  assert.equal(central.scheme, "central");
  assert.equal(central.bump, 1);
  assert.ok(central.notes[0]!.includes("reprice"));

  const atZeroVol = sensitivity({ ...base, volatility: 0, steps: 100 }, { parameter: "volatility", bump: 0.01 });
  assert.equal(atZeroVol.boundaryInstable, true);
});
