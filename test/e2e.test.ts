import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { openDatabase } from "../src/db/database.js";
import { OptionService } from "../src/core/service.js";
import { buildApp } from "../src/server/app.js";
import { seedFixtures } from "../src/fixtures/seed.js";
import { FIXED_NOW } from "../src/fixtures/contracts.js";
import type { Clock } from "../src/core/clock.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = join(root, "data", "e2e.db");
const fixedClock: Clock = { now: () => new Date(FIXED_NOW) };

let base: string;
let server: ReturnType<typeof buildApp>;
let db: ReturnType<typeof openDatabase>;
let svc: OptionService;

function api(method: string, path: string, body?: unknown) {
  return fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

before(async () => {
  for (const suffix of ["", "-shm", "-wal"]) rmSync(dbPath + suffix, { force: true });
  db = openDatabase(dbPath);
  svc = new OptionService(db, fixedClock);
  server = buildApp(svc, db);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

test("health", async () => {
  const r = await api("GET", "/api/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.data.status, "ok");
});

test("full flow: create contract, freeze snapshot, price, report, node", async () => {
  const created = await api("POST", "/api/contracts", {
    idempotencyKey: "e2e-put-1",
    code: "E2E-AMPUT",
    optionType: "put",
    style: "american",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.25,
  });
  assert.equal(created.status, 200);
  const cid = created.json.data.id;

  // idempotent repeat -> same id, no duplicate
  const repeat = await api("POST", "/api/contracts", {
    idempotencyKey: "e2e-put-1",
    code: "E2E-AMPUT",
    optionType: "put",
    style: "american",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.25,
  });
  assert.equal(repeat.json.data.id, cid);

  const bad = await api("POST", "/api/contracts", {
    code: "BAD",
    optionType: "call",
    style: "european",
    strike: -5,
    maturityDate: "2027-01-01",
    annualVolatility: 0.2,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, "VALIDATION_ERROR");

  const snap = await api("POST", `/api/contracts/${cid}/snapshots`, {
    idempotencyKey: "e2e-snap-1",
    spot: 60,
    riskFreeRate: 0.05,
    label: "deep ITM",
  });
  assert.equal(snap.status, 200);
  const sid = snap.json.data.id;

  const priced = await api("POST", "/api/valuations", {
    idempotencyKey: "e2e-val-1",
    contractId: cid,
    snapshotId: sid,
    steps: 12,
    valuationTime: FIXED_NOW,
  });
  assert.equal(priced.status, 200);
  const vid = priced.json.data.id;
  assert.ok(priced.json.data.price >= 40);

  // repeat valuation idempotent
  const priced2 = await api("POST", "/api/valuations", {
    idempotencyKey: "e2e-val-1",
    contractId: cid,
    snapshotId: sid,
    steps: 12,
    valuationTime: FIXED_NOW,
  });
  assert.equal(priced2.json.data.id, vid);

  const report = await api("GET", `/api/valuations/${vid}/report`);
  assert.equal(report.status, 200);
  assert.ok(Array.isArray(report.json.data[0].payload.exerciseRegions));

  const node = await api("GET", `/api/valuations/${vid}/nodes/0/0`);
  assert.equal(node.status, 200);
  assert.ok("continuationValue" in node.json.data);
  assert.ok("exerciseValue" in node.json.data);

  const badNode = await api("GET", `/api/valuations/${vid}/nodes/0/9`);
  assert.equal(badNode.status, 404);
});

test("invalid probability returns 422 with explicit code and no clipping", async () => {
  const c = await api("POST", "/api/contracts", {
    code: "E2E-NEGRATE",
    optionType: "call",
    style: "european",
    strike: 100,
    maturityDate: "2027-01-01",
    annualVolatility: 0.2,
  });
  const s = await api("POST", `/api/contracts/${c.json.data.id}/snapshots`, { spot: 100, riskFreeRate: -5 });
  const v = await api("POST", "/api/valuations", {
    contractId: c.json.data.id,
    snapshotId: s.json.data.id,
    steps: 1,
    valuationTime: FIXED_NOW,
  });
  assert.equal(v.status, 422);
  assert.equal(v.json.error.code, "INVALID_PROBABILITY");
});

test("convergence and sensitivity endpoints", async () => {
  const seed = seedFixtures(svc);
  const cid = seed.contracts["FAKE-AMPUT-ITM"]!.id;
  const sid = seed.snapshots.find((x) => x.contractCode === "FAKE-AMPUT-ITM")!.id;
  const conv = await api("POST", "/api/convergence", {
    contractId: cid,
    snapshotId: sid,
    stepCounts: [5, 10, 25],
    valuationTime: FIXED_NOW,
  });
  assert.equal(conv.status, 200);
  assert.equal(conv.json.data.points.length, 3);

  const sens = await api("POST", "/api/sensitivity", {
    contractId: cid,
    snapshotId: sid,
    steps: 100,
    parameter: "spot",
    bump: 1,
  });
  assert.equal(sens.status, 200);
  assert.equal(sens.json.data.bump, 1);
  assert.ok(Number.isFinite(sens.json.data.value));

  const badParm = await api("POST", "/api/sensitivity", {
    contractId: cid,
    snapshotId: sid,
    steps: 100,
    parameter: "nope",
    bump: 1,
  });
  assert.equal(badParm.status, 400);
});

test("pagination", async () => {
  const page1 = await api("GET", "/api/contracts?limit=2&offset=0");
  assert.equal(page1.json.data.limit, 2);
  assert.ok(page1.json.data.rows.length <= 2);
  assert.ok(page1.json.data.total >= 2);
  const page2 = await api("GET", "/api/contracts?limit=2&offset=2");
  assert.ok(page2.json.data.rows.length >= 1);
});

test("snapshot/contract mismatch is rejected", async () => {
  const all = await api("GET", "/api/contracts?limit=50");
  const ids = all.json.data.rows.map((r: { id: number }) => r.id);
  const otherId = ids[ids.length - 1];
  const snaps = await api("GET", `/api/snapshots?contractId=${ids[0]}`);
  const sid = snaps.json.data.rows[0].id;
  if (otherId !== ids[0]) {
    const r = await api("POST", "/api/valuations", {
      contractId: otherId,
      snapshotId: sid,
      steps: 10,
      valuationTime: FIXED_NOW,
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, "SNAPSHOT_MISMATCH");
  }
});

test("transaction rolls back when an error is thrown inside it", () => {
  const before = Number((db.prepare("SELECT COUNT(*) c FROM contracts").get() as { c: number }).c);
  db.exec("BEGIN");
  assert.throws(() => {
    db.prepare(
      "INSERT INTO contracts (code, option_type, style, strike, maturity_date, annual_volatility, continuous_dividend_yield, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("ROLLBACK-ME", "call", "european", 1, "2027-01-01", 0.2, 0, FIXED_NOW);
    throw new Error("force rollback");
  });
  db.exec("ROLLBACK");
  const after = Number((db.prepare("SELECT COUNT(*) c FROM contracts").get() as { c: number }).c);
  assert.equal(after, before);
  const found = db.prepare("SELECT 1 FROM contracts WHERE code = 'ROLLBACK-ME'").get();
  assert.equal(found, undefined);
});

test("data persists across a database close/reopen (restart)", () => {
  const reopened = openDatabase(dbPath);
  const count = Number((reopened.prepare("SELECT COUNT(*) c FROM contracts").get() as { c: number }).c);
  assert.ok(count >= 1);
  const seeded = reopened.prepare("SELECT 1 FROM contracts WHERE code = 'FAKE-AMPUT-ITM'").get();
  assert.ok(seeded);
  // migration must be safe to re-run on an existing database
  assert.doesNotThrow(() => openDatabase(dbPath).close());
  reopened.close();
});
