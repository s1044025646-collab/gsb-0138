import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../db/database.ts";
import { Repository } from "../services/repository.ts";

export interface FixtureContract {
  code: string;
  optionType: "call" | "put";
  style: "european" | "american";
  strike: number;
  maturityDate: string;
  continuousDividendYield: number;
  contractUnit: number;
  note: string | null;
}

export interface FixtureSnapshot {
  contractCode: string;
  valuationTime: string;
  underlyingPrice: number;
  riskFreeRate: number;
  volatility: number;
  steps: number;
  note: string | null;
}

export interface Fixtures {
  disclaimer: string;
  contracts: FixtureContract[];
  snapshots: FixtureSnapshot[];
}

export function loadFixtures(path: string): Fixtures {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Fixtures;
  return parsed;
}

export function seedFixtures(
  db: DatabaseSync,
  clock: Clock,
  fixtures: Fixtures,
): Map<string, string> {
  const repo = new Repository(db, clock);
  const ids = new Map<string, string>();
  for (const contract of fixtures.contracts) {
    const { contract: created } = repo.createContract({
      ...contract,
      idempotencyKey: `fixture:${contract.code}`,
    });
    ids.set(contract.code, created.id);
  }
  for (const snapshot of fixtures.snapshots) {
    const contractId = ids.get(snapshot.contractCode);
    if (!contractId) {
      throw new Error(`Fixture snapshot references unknown contract ${snapshot.contractCode}`);
    }
    const { snapshot: createdSnapshot } = repo.createSnapshot({
      contractId,
      valuationTime: snapshot.valuationTime,
      underlyingPrice: snapshot.underlyingPrice,
      riskFreeRate: snapshot.riskFreeRate,
      volatility: snapshot.volatility,
      steps: snapshot.steps,
      note: snapshot.note,
      idempotencyKey: `fixture:${snapshot.contractCode}:${snapshot.valuationTime}:${snapshot.steps}`,
    });
    ids.set(`${snapshot.contractCode}:snapshot`, createdSnapshot.id);
  }
  return ids;
}
