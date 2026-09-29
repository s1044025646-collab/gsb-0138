/**
 * Repeatable end-to-end demo against a project-local database.
 * Run: npm run demo  (uses data/demo.db; safe to re-run, fixtures are idempotent)
 * All contracts/quotes are fictitious; output is numerical demonstration only.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/db/database.js";
import { OptionService } from "../src/core/service.js";
import type { Clock } from "../src/core/clock.js";
import { seedFixtures } from "../src/fixtures/seed.js";
import { FIXED_NOW } from "../src/fixtures/contracts.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixedClock: Clock = { now: () => new Date(FIXED_NOW) };

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function main() {
  const db = openDatabase(join(root, "data", "demo.db"));
  const svc = new OptionService(db, fixedClock);

  section("seed fictitious fixtures (idempotent)");
  const seed = seedFixtures(svc);
  console.log("contracts:", Object.keys(seed.contracts).join(", "));

  const amCallCid = seed.contracts["FAKE-AMCALL-NODIV"]!.id;
  const amCallSid = seed.snapshots.find((s) => s.contractCode === "FAKE-AMCALL-NODIV")!.id;
  const amPutCid = seed.contracts["FAKE-AMPUT-ITM"]!.id;
  const amPutSid = seed.snapshots.find((s) => s.contractCode === "FAKE-AMPUT-ITM")!.id;
  const euCallSid = seed.snapshots.find((s) => s.contractCode === "FAKE-EUCALL")!.id;
  const euPutSid = seed.snapshots.find((s) => s.contractCode === "FAKE-EUPUT")!.id;
  const expiredCid = seed.contracts["FAKE-EXPIRED-CALL"]!.id;
  const expiryItmSid = seed.snapshots.find((s) => s.label === "expiry ITM quote")!.id;
  const expiryOtmSid = seed.snapshots.find((s) => s.label === "expiry OTM quote")!.id;
  const zeroVolCid = seed.contracts["FAKE-ZEROVOL-PUT"]!.id;
  const zeroVolSid = seed.snapshots.find((s) => s.contractCode === "FAKE-ZEROVOL-PUT")!.id;

  section("1) non-dividend American call: no early-exercise region expected");
  const amCallVal = svc.runValuation({
    idempotencyKey: "demo-amcall-100",
    contractId: amCallCid,
    snapshotId: amCallSid,
    steps: 100,
    valuationTime: FIXED_NOW,
  }) as Record<string, unknown>;
  console.log("price =", amCallVal.price, "earlyExerciseNodes =", amCallVal.early_exercise_node_count);

  section("2) American put: early-exercise region present");
  const amPutVal = svc.runValuation({
    idempotencyKey: "demo-amput-100",
    contractId: amPutCid,
    snapshotId: amPutSid,
    steps: 12,
    valuationTime: FIXED_NOW,
  }) as { id: number };
  const report = svc.getReport(amPutVal.id)[0]!.payload as {
    exerciseRegions: { layer: number; exerciseNodes: number[]; exercisePrices: number[] }[];
  };
  for (const layer of report.exerciseRegions) {
    if (layer.exerciseNodes.length > 0) {
      console.log(
        `layer ${layer.layer}: exercise j=${layer.exerciseNodes.join(",")} at S=${layer.exercisePrices
          .map((x) => x.toFixed(2))
          .join(",")}`,
      );
    }
  }
  console.log("node (0,0) explanation:", JSON.stringify(svc.explainNode(amPutVal.id, 0, 0)));

  section("3) European put-call parity: C - P = S e^{-qT} - K e^{-rT}");
  const cval = svc.runValuation({
    idempotencyKey: "demo-eucall-200",
    contractId: seed.contracts["FAKE-EUCALL"]!.id,
    snapshotId: euCallSid,
    steps: 200,
    valuationTime: FIXED_NOW,
  }) as { price: number };
  const pval = svc.runValuation({
    idempotencyKey: "demo-euput-200",
    contractId: seed.contracts["FAKE-EUPUT"]!.id,
    snapshotId: euPutSid,
    steps: 200,
    valuationTime: FIXED_NOW,
  }) as { price: number };
  const T = 1;
  const rhs = 100 * Math.exp(-0.03 * T) - 100 * Math.exp(-0.04 * T);
  console.log("C-P =", cval.price - pval.price, " S e^-qT - K e^-rT =", rhs);

  section("4) expiry: value is pure intrinsic (ITM and OTM)");
  const itm = svc.runValuation({
    idempotencyKey: "demo-expiry-itm",
    contractId: expiredCid,
    snapshotId: expiryItmSid,
    steps: 5,
    valuationTime: FIXED_NOW,
  }) as { price: number; time_to_expiry_years: number };
  const otm = svc.runValuation({
    idempotencyKey: "demo-expiry-otm",
    contractId: expiredCid,
    snapshotId: expiryOtmSid,
    steps: 5,
    valuationTime: FIXED_NOW,
  }) as { price: number };
  console.log("ITM call at T=0:", itm.price, "(expect 10), T=", itm.time_to_expiry_years);
  console.log("OTM call at T=0:", otm.price, "(expect 0)");

  section("5) zero volatility: deterministic, finite result");
  const zv = svc.runValuation({
    idempotencyKey: "demo-zerovol",
    contractId: zeroVolCid,
    snapshotId: zeroVolSid,
    steps: 10,
    valuationTime: FIXED_NOW,
  }) as Record<string, unknown>;
  console.log("price =", zv.price, "mode =", zv.lattice_mode, "p =", zv.risk_neutral_probability);

  section("6) step convergence and rejected probability combination");
  const conv = svc.runConvergence(amPutCid, amPutSid, [5, 10, 25, 50, 100, 200], FIXED_NOW);
  console.log(conv.points.map((p) => `n=${p.steps}:${p.rejected ? "REJECTED(" + p.errorCode + ")" : p.price.toFixed(4)}`).join("  "));

  section("7) sensitivity (finite difference; bump + reprice convention recorded)");
  const delta = svc.runSensitivity(amPutCid, amPutSid, 100, { parameter: "spot", bump: 1 }, FIXED_NOW);
  console.log("delta ~", delta.value, "| scheme", delta.scheme, "bump", delta.bump, "| flagged:", delta.boundaryInstable);

  db.close();
  console.log("\ndemo complete; data written to data/demo.db");
}

main();
