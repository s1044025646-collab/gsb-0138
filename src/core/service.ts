import type { DatabaseSync } from "node:sqlite";
import { explainNode, price } from "../pricing/crr.js";
import { convergence, sensitivity, type SensitivitySpec } from "../pricing/greeks.js";
import { PricingError } from "../pricing/types.js";
import { act365FixedYears, type Clock } from "./clock.js";
import { ApiError } from "./errors.js";

export interface CreateContractInput {
  idempotencyKey?: string;
  code: string;
  optionType: "call" | "put";
  style: "european" | "american";
  strike: number;
  maturityDate: string; // ISO date
  annualVolatility: number;
  continuousDividendYield?: number;
}

export interface CreateSnapshotInput {
  idempotencyKey?: string;
  contractId: number;
  label?: string;
  spot: number;
  riskFreeRate: number;
  capturedAt?: string; // optional override; defaults to clock
}

export interface RunValuationInput {
  idempotencyKey?: string;
  contractId: number;
  snapshotId: number;
  steps: number;
  valuationTime?: string;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export class OptionService {
  constructor(
    private db: DatabaseSync,
    private clock: Clock,
  ) {}

  private isoNow(): string {
    return this.clock.now().toISOString();
  }

  /** Find a previously created row by idempotency key (repeat submissions). */
  private findIdempotent(table: string, key: string): unknown | undefined {
    return this.db.prepare(`SELECT * FROM ${table} WHERE idempotency_key = ?`).get(key);
  }

  createContract(input: CreateContractInput) {
    if (!input.code || typeof input.code !== "string") throw new ApiError("VALIDATION_ERROR", "code is required");
    if (input.optionType !== "call" && input.optionType !== "put")
      throw new ApiError("VALIDATION_ERROR", "optionType must be call|put");
    if (input.style !== "european" && input.style !== "american")
      throw new ApiError("VALIDATION_ERROR", "style must be european|american");
    if (!(num(input.strike) > 0)) throw new ApiError("VALIDATION_ERROR", "strike must be > 0");
    if (!(num(input.annualVolatility) >= 0) || !Number.isFinite(num(input.annualVolatility)))
      throw new ApiError("VALIDATION_ERROR", "annualVolatility must be finite and >= 0");
    const q = num(input.continuousDividendYield ?? 0);
    if (!(q >= 0) || !Number.isFinite(q))
      throw new ApiError("VALIDATION_ERROR", "continuousDividendYield must be finite and >= 0 (discrete cash dividends unsupported)");
    const mat = Date.parse(input.maturityDate);
    if (Number.isNaN(mat)) throw new ApiError("VALIDATION_ERROR", "maturityDate must be an ISO date");

    if (input.idempotencyKey) {
      const existing = this.findIdempotent("contracts", input.idempotencyKey);
      if (existing) return existing;
    }
    try {
      const res = this.db
        .prepare(
          `INSERT INTO contracts
            (idempotency_key, code, option_type, style, strike, maturity_date, annual_volatility, continuous_dividend_yield, created_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.idempotencyKey ?? null,
          input.code,
          input.optionType,
          input.style,
          num(input.strike),
          new Date(mat).toISOString().slice(0, 10),
          num(input.annualVolatility),
          q,
          this.isoNow(),
        );
      return this.getContract(Number(res.lastInsertRowid));
    } catch (err) {
      if (isUnique(err)) throw new ApiError("CONFLICT", "contract code or idempotency key already exists");
      throw err;
    }
  }

  getContract(id: number) {
    const row = this.db.prepare("SELECT * FROM contracts WHERE id = ?").get(id);
    if (!row) throw new ApiError("NOT_FOUND", `contract ${id} not found`);
    return row;
  }

  listContracts(limit: number, offset: number) {
    return paginate(this.db, "contracts", limit, offset);
  }

  createSnapshot(input: CreateSnapshotInput) {
    const contract = this.getContract(input.contractId);
    if (!(num(input.spot) > 0)) throw new ApiError("VALIDATION_ERROR", "spot must be > 0");
    if (!Number.isFinite(num(input.riskFreeRate)))
      throw new ApiError("VALIDATION_ERROR", "riskFreeRate must be finite (negative allowed)");

    if (input.idempotencyKey) {
      const existing = this.findIdempotent("market_snapshots", input.idempotencyKey);
      if (existing) return existing;
    }
    const capturedAt = input.capturedAt ? new Date(input.capturedAt).toISOString() : this.isoNow();
    if (Number.isNaN(Date.parse(capturedAt))) throw new ApiError("VALIDATION_ERROR", "capturedAt must be ISO datetime");
    const res = this.db
      .prepare(
        `INSERT INTO market_snapshots (idempotency_key, contract_id, label, spot, risk_free_rate, captured_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        input.idempotencyKey ?? null,
        (contract as { id: number }).id,
        input.label ?? null,
        num(input.spot),
        num(input.riskFreeRate),
        capturedAt,
      );
    return this.getSnapshot(Number(res.lastInsertRowid));
  }

  getSnapshot(id: number) {
    const row = this.db.prepare("SELECT * FROM market_snapshots WHERE id = ?").get(id);
    if (!row) throw new ApiError("NOT_FOUND", `snapshot ${id} not found`);
    return row;
  }

  listSnapshots(contractId: number | undefined, limit: number, offset: number) {
    if (contractId === undefined) return paginate(this.db, "market_snapshots", limit, offset);
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) c FROM market_snapshots WHERE contract_id = ?").get(contractId) as { c: number }).c,
    );
    const rows = this.db
      .prepare("SELECT * FROM market_snapshots WHERE contract_id = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(contractId, limit, offset);
    return { rows, total, limit, offset };
  }

  /** Build immutable pricing inputs from a contract + frozen snapshot. */
  private pricingInputs(contractId: number, snapshotId: number, steps: number, valuationTime: Date) {
    const c = this.getContract(contractId) as Record<string, unknown>;
    const s = this.getSnapshot(snapshotId) as Record<string, unknown>;
    if (Number(s.contract_id) !== contractId)
      throw new ApiError("SNAPSHOT_MISMATCH", "snapshot does not belong to the given contract");
    const maturity = new Date(String(c.maturity_date) + "T00:00:00.000Z");
    const T = act365FixedYears(valuationTime, maturity);
    return {
      spot: Number(s.spot),
      strike: Number(c.strike),
      maturityYears: T,
      riskFreeRate: Number(s.risk_free_rate),
      dividendYield: Number(c.continuous_dividend_yield),
      volatility: Number(c.annual_volatility),
      optionType: String(c.option_type) as "call" | "put",
      style: String(c.style) as "european" | "american",
      steps,
    };
  }

  runValuation(input: RunValuationInput) {
    if (!Number.isInteger(input.steps) || input.steps < 1)
      throw new ApiError("VALIDATION_ERROR", "steps must be an integer >= 1");
    if (input.idempotencyKey) {
      const existing = this.findIdempotent("valuation_points", input.idempotencyKey);
      if (existing) return existing;
    }
    const vTime = input.valuationTime ? new Date(input.valuationTime) : this.clock.now();
    if (Number.isNaN(vTime.getTime())) throw new ApiError("VALIDATION_ERROR", "valuationTime must be ISO datetime");
    const pInputs = this.pricingInputs(input.contractId, input.snapshotId, input.steps, vTime);

    // Persist + report in one transaction; a pricing rejection is also stored
    // as an auditable rejected row (commit), while unexpected errors roll back.
    const insertValuation = this.db.prepare(
      `INSERT INTO valuation_points
        (idempotency_key, contract_id, snapshot_id, steps, valuation_time, time_to_expiry_years,
         price, risk_neutral_probability, up, down, dt, discount, lattice_mode,
         early_exercise_node_count, status, error_code, error_message, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insertReport = this.db.prepare(
      "INSERT INTO reports (valuation_id, kind, payload_json, created_at) VALUES (?,?,?,?)",
    );

    let id: number;
    this.db.exec("BEGIN");
    try {
      let result;
      let status = "ok";
      let errCode: string | null = null;
      let errMsg: string | null = null;
      try {
        result = price(pInputs);
      } catch (err) {
        if (!(err instanceof PricingError)) throw err;
        status = "rejected";
        errCode = err.code;
        errMsg = err.message;
      }
      const res = insertValuation.run(
        input.idempotencyKey ?? null,
        input.contractId,
        input.snapshotId,
        input.steps,
        vTime.toISOString(),
        pInputs.maturityYears,
        result?.price ?? null,
        result?.riskNeutralProbability ?? null,
        result?.up ?? null,
        result?.down ?? null,
        result?.dt ?? null,
        result?.discount ?? null,
        result?.meta.latticeMode ?? null,
        result?.earlyExerciseNodeCount ?? null,
        status,
        errCode,
        errMsg,
        this.isoNow(),
      );
      id = Number(res.lastInsertRowid);
      if (result) {
        insertReport.run(
          id,
          "exercise-regions",
          JSON.stringify({ exerciseRegions: result.exerciseRegions }),
          this.isoNow(),
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    const row = this.getValuation(id);
    if ((row as { status: string }).status === "rejected") {
      const r = row as { error_code: string; error_message: string };
      throw new ApiError(
        r.error_code === "INVALID_PROBABILITY" ? "INVALID_PROBABILITY" : "PRICING_INVALID_INPUT",
        r.error_message ?? "pricing rejected",
      );
    }
    return row;
  }

  getValuation(id: number) {
    const row = this.db.prepare("SELECT * FROM valuation_points WHERE id = ?").get(id);
    if (!row) throw new ApiError("NOT_FOUND", `valuation ${id} not found`);
    return row;
  }

  listValuations(contractId: number | undefined, limit: number, offset: number) {
    if (contractId === undefined) return paginate(this.db, "valuation_points", limit, offset);
    const total = Number(
      (this.db.prepare("SELECT COUNT(*) c FROM valuation_points WHERE contract_id = ?").get(contractId) as { c: number }).c,
    );
    const rows = this.db
      .prepare("SELECT * FROM valuation_points WHERE contract_id = ? ORDER BY id LIMIT ? OFFSET ?")
      .all(contractId, limit, offset);
    return { rows, total, limit, offset };
  }

  getReport(valuationId: number) {
    this.getValuation(valuationId);
    const rows = this.db.prepare("SELECT * FROM reports WHERE valuation_id = ? ORDER BY id").all(valuationId);
    return rows.map((r) => ({ ...(r as object), payload: JSON.parse((r as { payload_json: string }).payload_json) }));
  }

  /** Recompute (not stored) node explanation from frozen inputs. */
  explainNode(valuationId: number, layer: number, upMoves: number) {
    const v = this.getValuation(valuationId) as Record<string, unknown>;
    const pInputs = this.pricingInputs(
      Number(v.contract_id),
      Number(v.snapshot_id),
      Number(v.steps),
      new Date(String(v.valuation_time)),
    );
    const result = price(pInputs);
    return explainNode(result, { layer, upMoves });
  }

  runConvergence(contractId: number, snapshotId: number, stepCounts: number[], valuationTime?: string) {
    const vTime = valuationTime ? new Date(valuationTime) : this.clock.now();
    const base = this.pricingInputs(contractId, snapshotId, stepCounts[0] ?? 1, vTime);
    return convergence(base, stepCounts);
  }

  runSensitivity(
    contractId: number,
    snapshotId: number,
    steps: number,
    spec: SensitivitySpec,
    valuationTime?: string,
  ) {
    const vTime = valuationTime ? new Date(valuationTime) : this.clock.now();
    const base = this.pricingInputs(contractId, snapshotId, steps, vTime);
    try {
      return sensitivity(base, spec);
    } catch (err) {
      if (err instanceof PricingError) throw new ApiError("PRICING_INVALID_INPUT", err.message);
      throw err;
    }
  }
}

function isUnique(err: unknown): boolean {
  return typeof err === "object" && err !== null && /unique constraint/i.test(String((err as Error).message ?? err));
}

export function paginate(db: DatabaseSync, table: string, limit: number, offset: number) {
  const allowed = new Set(["contracts", "market_snapshots", "valuation_points"]);
  if (!allowed.has(table)) throw new Error("illegal table");
  const total = Number((db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c);
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id LIMIT ? OFFSET ?`).all(limit, offset);
  return { rows, total, limit, offset };
}
