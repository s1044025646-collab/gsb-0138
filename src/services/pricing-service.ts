import type { DatabaseSync } from "node:sqlite";
import { evaluateTree, explainNode } from "../domain/binomial.ts";
import { convergenceReport } from "../domain/convergence.ts";
import { computeAllSensitivities } from "../domain/greeks.ts";
import type { PricingInputs } from "../domain/types.ts";
import { remainingTermYears, DAY_COUNT_CONVENTION } from "./daycount.ts";
import { Repository } from "./repository.ts";

export const PRICING_BASIS =
  "CRR binomial lattice; annualized continuously-compounded risk-free rate and dividend yield; " +
  "dt = T/N under ACT/365F remaining term; per-step discount exp(-r*dt); " +
  "u=exp(sigma*sqrt(dt)), d=1/u, p=(exp((r-q)*dt)-d)/(u-d); " +
  "American nodes compare immediate exercise payoff with continuation value; demo numbers only";

export class PricingService {
  private readonly repo: Repository;

  constructor(db: DatabaseSync, clock: ConstructorParameters<typeof Repository>[1]) {
    this.repo = new Repository(db, clock);
  }

  inputsForSnapshot(snapshotId: string): {
    inputs: PricingInputs;
    remainingTermYears: number;
    snapshot: ReturnType<Repository["getSnapshot"]>;
    contract: ReturnType<Repository["getContract"]>;
  } {
    const snapshot = this.repo.getSnapshot(snapshotId);
    const contract = this.repo.getContract(snapshot.contractId);
    const term = remainingTermYears(snapshot.valuationTime, contract.maturityDate);
    return {
      inputs: {
        optionType: contract.optionType,
        style: contract.style,
        strike: contract.strike,
        remainingTermYears: term,
        underlyingPrice: snapshot.underlyingPrice,
        riskFreeRate: snapshot.riskFreeRate,
        volatility: snapshot.volatility,
        continuousDividendYield: contract.continuousDividendYield,
        steps: snapshot.steps,
      },
      remainingTermYears: term,
      snapshot,
      contract,
    };
  }

  priceSnapshot(snapshotId: string): Record<string, unknown> {
    const { inputs, remainingTermYears: term } = this.inputsForSnapshot(snapshotId);
    const evaluation = evaluateTree(inputs);
    const valuationId = this.repo.saveValuation(
      snapshotId,
      term,
      evaluation.result,
      PRICING_BASIS,
    );
    return {
      valuationId,
      snapshotId,
      remainingTermYears: term,
      dayCountConvention: DAY_COUNT_CONVENTION,
      ...this.repo.getValuation(snapshotId),
    };
  }

  explainSnapshotNode(snapshotId: string, step: number, upMoves: number) {
    const { inputs } = this.inputsForSnapshot(snapshotId);
    const evaluation = evaluateTree(inputs);
    const node = explainNode(evaluation, step, upMoves);
    const reportId = this.repo.saveReport(snapshotId, "node", node);
    return { reportId, snapshotId, node };
  }

  sensitivitySnapshot(snapshotId: string) {
    const { inputs } = this.inputsForSnapshot(snapshotId);
    const sensitivities = computeAllSensitivities(inputs);
    const payload = {
      snapshotId,
      method:
        "central finite differences; every bumped input rebuilds the full CRR tree; annualized units",
      sensitivities,
    };
    const reportId = this.repo.saveReport(snapshotId, "sensitivity", payload);
    return { reportId, ...payload };
  }

  convergenceSnapshot(snapshotId: string, stepGrid: number[]) {
    const { inputs } = this.inputsForSnapshot(snapshotId);
    const report = convergenceReport(inputs, stepGrid);
    const payload = { snapshotId, ...report };
    const reportId = this.repo.saveReport(snapshotId, "convergence", payload);
    return { reportId, ...payload };
  }
}
