import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as SQLiteDatabase } from "node:sqlite";
import { applyMigrations } from "../src/db/migrations.ts";
import { createApp, listenLocalhost } from "../src/api/app.ts";
import type { Clock } from "../src/db/database.ts";

let server: Server;
let db: DatabaseSync;
let baseUrl: string;
let contractId = "";
let snapshotId = "";

const clock: Clock = {
  now: () => new Date("2026-09-29T00:00:00Z"),
  randomUUID: (() => {
    let n = 0;
    return () => `http-uuid-${(n += 1)}`;
  })(),
};

async function request<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

before(async () => {
  db = new SQLiteDatabase(":memory:");
  applyMigrations(db);
  server = createApp(db, clock);
  const { port } = await listenLocalhost(server, 0);
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("HTTP API", () => {
  it("exposes health", async () => {
    const { status, body } = await request<{ status: string }>("/health");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  it("validates contract input with explicit error codes", async () => {
    const bad = await request("/contracts", { method: "POST", body: { code: "x", optionType: "warrant", style: "european", strike: 100, maturityDate: "2027-01-01", continuousDividendYield: 0 } });
    assert.equal(bad.status, 400);
    assert.equal((bad.body as { error: { code: string } }).error.code, "VALIDATION_ERROR");
  });

  it("rejects discrete cash dividends explicitly", async () => {
    const res = await request("/contracts", {
      method: "POST",
      body: { code: "CASH-DIV", optionType: "call", style: "american", strike: 100, maturityDate: "2027-01-01", continuousDividendYield: 0, cashDividend: 5 },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, "UNSUPPORTED_FEATURE");
  });

  it("creates a contract idempotently and paginates listing", async () => {
    const payload = { code: "API-CALL", optionType: "call", style: "american", strike: 100, maturityDate: "2027-09-29", continuousDividendYield: 0 };
    const first = await request("/contracts", { method: "POST", body: payload, idempotencyKey: "idem-1" });
    assert.equal(first.status, 201);
    contractId = (first.body as { contract: { id: string } }).contract.id;

    const second = await request("/contracts", { method: "POST", body: payload, idempotencyKey: "idem-1" });
    assert.equal(second.status, 200);
    assert.equal((second.body as { idempotentReplay: boolean }).idempotentReplay, true);

    const page = await request<{ data: unknown[]; pagination: { total: number; limit: number; offset: number } }>("/contracts?limit=1&offset=0");
    assert.equal(page.status, 200);
    assert.equal(page.body.pagination.limit, 1);
    assert.ok(page.body.pagination.total >= 1);

    const badPaging = await request("/contracts?limit=0");
    assert.equal(badPaging.status, 400);
    assert.equal((badPaging.body as { error: { code: string } }).error.code, "INVALID_PAGINATION");
  });

  it("returns NOT_FOUND for unknown ids", async () => {
    const res = await request("/contracts/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal((res.body as { error: { code: string } }).error.code, "NOT_FOUND");
  });

  it("freezes a snapshot, prices, explains a node and repeats identically", async () => {
    const snapshot = await request(`/contracts/${contractId}/snapshots`, {
      method: "POST",
      idempotencyKey: "snap-1",
      body: { valuationTime: "2026-09-29T00:00:00Z", underlyingPrice: 100, riskFreeRate: 0.05, volatility: 0.25, steps: 60 },
    });
    assert.equal(snapshot.status, 201);
    snapshotId = (snapshot.body as { snapshot: { id: string } }).snapshot.id;

    const replay = await request(`/contracts/${contractId}/snapshots`, {
      method: "POST",
      idempotencyKey: "snap-1",
      body: { valuationTime: "2026-09-29T00:00:00Z", underlyingPrice: 100, riskFreeRate: 0.05, volatility: 0.25, steps: 60 },
    });
    assert.equal((replay.body as { idempotentReplay: boolean }).idempotentReplay, true);

    const price1 = await request(`/snapshots/${snapshotId}/price`, { method: "POST" });
    const price2 = await request(`/snapshots/${snapshotId}/price`, { method: "POST" });
    assert.equal(price1.status, 200);
    assert.equal((price1.body as { price: number }).price, (price2.body as { price: number }).price);
    assert.ok((price1.body as { layers: unknown[] }).layers.length === 61);

    const explain = await request(`/snapshots/${snapshotId}/explain`, {
      method: "POST",
      body: { step: 5, upMoves: 2 },
    });
    assert.equal(explain.status, 200);
    assert.ok((explain.body as { node: { stockPrice: number } }).node.stockPrice > 0);
  });

  it("runs convergence and sensitivity reports", async () => {
    const conv = await request(`/snapshots/${snapshotId}/convergence`, { method: "POST", body: { steps: [10, 20, 40] } });
    assert.equal(conv.status, 200);
    assert.equal((conv.body as { points: unknown[] }).points.length, 3);

    const sens = await request(`/snapshots/${snapshotId}/sensitivity`, { method: "POST" });
    assert.equal(sens.status, 200);
    assert.ok((sens.body as { sensitivities: unknown[] }).sensitivities.length >= 5);

    const reports = await request(`/snapshots/${snapshotId}/reports`);
    assert.equal(reports.status, 200);
    assert.ok((reports.body as { reports: unknown[] }).reports.length >= 3);
  });

  it("rejects invalid probability via ad-hoc pricing", async () => {
    const res = await request("/price", {
      method: "POST",
      body: { optionType: "put", style: "european", strike: 100, remainingTermYears: 1, underlyingPrice: 100, riskFreeRate: -0.8, volatility: 0.01, continuousDividendYield: 0, steps: 1 },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { error: { code: string } }).error.code, "INVALID_PROBABILITY");
  });

  it("rejects malformed JSON and unknown routes", async () => {
    const response = await fetch(`${baseUrl}/contracts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_ERROR");

    const missing = await request("/nope");
    assert.equal(missing.status, 404);
  });
});
