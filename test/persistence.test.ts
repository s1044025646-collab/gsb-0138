import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/db/migrations.ts";
import { DatabaseSync as SQLiteDatabase } from "node:sqlite";
import { closeDatabase, openDatabase, type Clock } from "../src/db/database.ts";
import { Repository } from "../src/services/repository.ts";
import { PricingService } from "../src/services/pricing-service.ts";
import { AppError } from "../src/domain/errors.ts";

function fakeClock(startIso: string): Clock & { tick(ms: number): void } {
  let current = new Date(startIso);
  let counter = 0;
  return {
    now: () => new Date(current.getTime()),
    randomUUID: () => `uuid-${(counter += 1)}`,
    tick(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}

const contractInput = {
  code: "T-CALL-1",
  optionType: "call" as const,
  style: "american" as const,
  strike: 100,
  maturityDate: "2027-09-29",
  continuousDividendYield: 0,
  contractUnit: 1,
  note: "test",
};

describe("repository idempotency, rollback and persistence", () => {
  it("replays contract creation with the same idempotency key", () => {
    const db = new SQLiteDatabase(":memory:");
    applyMigrations(db);
    const clock = fakeClock("2026-09-29T00:00:00Z");
    const repo = new Repository(db, clock);

    const first = repo.createContract({ ...contractInput, idempotencyKey: "key-1" });
    const second = repo.createContract({ ...contractInput, idempotencyKey: "key-1" });
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(first.contract.id, second.contract.id);
    assert.equal(repo.listContracts(100, 0).total, 1);

    assert.throws(
      () => repo.createContract({ ...contractInput, idempotencyKey: null }),
      (error: unknown) => error instanceof AppError && error.code === "CONFLICT",
    );
    db.close();
  });

  it("rolls back a failed transaction without partial writes", () => {
    const db = new SQLiteDatabase(":memory:");
    applyMigrations(db);
    const clock = fakeClock("2026-09-29T00:00:00Z");
    const repo = new Repository(db, clock);
    repo.createContract({ ...contractInput, idempotencyKey: "c1" });
    const before = (db.prepare("SELECT COUNT(*) AS c FROM contracts").get() as { c: number }).c;

    db.exec("BEGIN");
    assert.throws(() => {
      db.prepare(
        "INSERT INTO contracts (id, idempotency_key, code, option_type, style, strike, maturity_date, continuous_dividend_yield, contract_unit, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("x", null, "BAD-DUP", "future", "european", 100, "2027-01-01", 0, 1, null, "t");
    });
    db.exec("ROLLBACK");

    const after = (db.prepare("SELECT COUNT(*) AS c FROM contracts").get() as { c: number }).c;
    assert.equal(after, before);
    db.close();
  });

  const fileDbPath = join("data", "persist-test.sqlite");
  let db: DatabaseSync;
  let clock: ReturnType<typeof fakeClock>;
  let snapshotId = "";
  let price = 0;

  before(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(fileDbPath + suffix, { force: true });
    }
    db = openDatabase(fileDbPath);
    clock = fakeClock("2026-09-29T00:00:00Z");
  });

  after(() => {
    closeDatabase(db);
  });

  it("creates, freezes and prices deterministically with injected time", () => {
    const repo = new Repository(db, clock);
    const { contract } = repo.createContract({ ...contractInput, idempotencyKey: "persist-contract" });
    const { snapshot } = repo.createSnapshot({
      contractId: contract.id,
      valuationTime: "2026-09-29T00:00:00Z",
      underlyingPrice: 100,
      riskFreeRate: 0.05,
      volatility: 0.25,
      steps: 120,
      note: null,
      idempotencyKey: "persist-snapshot",
    });
    snapshotId = snapshot.id;
    const valuation = new PricingService(db, clock).priceSnapshot(snapshot.id);
    price = valuation.price as number;
    assert.ok(Number.isFinite(price) && price > 0);
  });

  it("reproduces the identical price from the same frozen snapshot", () => {
    const pricing = new PricingService(db, clock);
    const again = pricing.priceSnapshot(snapshotId);
    assert.equal(again.price, price);
  });

  it("survives close and restart with persisted state", () => {
    closeDatabase(db);
    const reopened = openDatabase(fileDbPath);
    const repo2 = new Repository(reopened, fakeClock("2030-01-01T00:00:00Z"));
    const snapshot = repo2.getSnapshot(snapshotId);
    const valuation = new PricingService(reopened, fakeClock("2030-01-01T00:00:00Z")).priceSnapshot(snapshot.id);
    assert.equal(valuation.price, price);
    closeDatabase(reopened);
    db = openDatabase(fileDbPath);
  });

  it("migrations are repeatable on an existing database", () => {
    assert.doesNotThrow(() => applyMigrations(db));
    assert.doesNotThrow(() => applyMigrations(db));
  });
});
