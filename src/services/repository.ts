import type { DatabaseSync } from "node:sqlite";
import { AppError } from "../domain/errors.ts";
import type {
  Contract,
  ExerciseStyle,
  MarketSnapshot,
  OptionType,
  PricingResult,
} from "../domain/types.ts";
import type { Clock } from "../db/database.ts";

export interface CreateContractInput {
  code: string;
  optionType: OptionType;
  style: ExerciseStyle;
  strike: number;
  maturityDate: string;
  continuousDividendYield: number;
  contractUnit: number;
  note: string | null;
  idempotencyKey: string | null;
}

export interface CreateSnapshotInput {
  contractId: string;
  valuationTime: string;
  underlyingPrice: number;
  riskFreeRate: number;
  volatility: number;
  steps: number;
  note: string | null;
  idempotencyKey: string | null;
}

interface ContractRow {
  id: string;
  idempotency_key: string | null;
  code: string;
  option_type: OptionType;
  style: ExerciseStyle;
  strike: number;
  maturity_date: string;
  continuous_dividend_yield: number;
  contract_unit: number;
  note: string | null;
  created_at: string;
}

interface SnapshotRow {
  id: string;
  idempotency_key: string | null;
  contract_id: string;
  valuation_time: string;
  underlying_price: number;
  risk_free_rate: number;
  volatility: number;
  steps: number;
  note: string | null;
  created_at: string;
}

function mapContract(row: ContractRow): Contract {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    code: row.code,
    optionType: row.option_type,
    style: row.style,
    strike: row.strike,
    maturityDate: row.maturity_date,
    continuousDividendYield: row.continuous_dividend_yield,
    contractUnit: row.contract_unit,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapSnapshot(row: SnapshotRow): MarketSnapshot {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    contractId: row.contract_id,
    valuationTime: row.valuation_time,
    underlyingPrice: row.underlying_price,
    riskFreeRate: row.risk_free_rate,
    volatility: row.volatility,
    steps: row.steps,
    note: row.note,
    createdAt: row.created_at,
  };
}

export class Repository {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;

  constructor(
    db: DatabaseSync,
    clock: Clock,
  ) {
    this.db = db;
    this.clock = clock;
  }

  createContract(input: CreateContractInput): { contract: Contract; replayed: boolean } {
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare("SELECT * FROM contracts WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as unknown as ContractRow | undefined;
      if (existing) {
        return { contract: mapContract(existing), replayed: true };
      }
    }
    const duplicateCode = this.db
      .prepare("SELECT id FROM contracts WHERE code = ?")
      .get(input.code);
    if (duplicateCode) {
      throw new AppError("CONFLICT", `Contract code '${input.code}' already exists`, {
        code: input.code,
      });
    }
    const id = this.clock.randomUUID();
    this.db
      .prepare(
        `INSERT INTO contracts (id, idempotency_key, code, option_type, style, strike,
          maturity_date, continuous_dividend_yield, contract_unit, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.idempotencyKey,
        input.code,
        input.optionType,
        input.style,
        input.strike,
        input.maturityDate,
        input.continuousDividendYield,
        input.contractUnit,
        input.note,
        this.clock.now().toISOString(),
      );
    const created = this.db
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(id) as unknown as ContractRow;
    return { contract: mapContract(created), replayed: false };
  }

  getContract(id: string): Contract {
    const row = this.db
      .prepare("SELECT * FROM contracts WHERE id = ?")
      .get(id) as unknown as ContractRow | undefined;
    if (!row) {
      throw new AppError("NOT_FOUND", `Contract '${id}' not found`, { id });
    }
    return mapContract(row);
  }

  listContracts(limit: number, offset: number): { data: Contract[]; total: number } {
    const rows = this.db
      .prepare("SELECT * FROM contracts ORDER BY created_at, code LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as ContractRow[];
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM contracts").get() as { c: number }).c;
    return { data: rows.map(mapContract), total };
  }

  createSnapshot(input: CreateSnapshotInput): { snapshot: MarketSnapshot; replayed: boolean } {
    this.getContract(input.contractId);
    if (input.idempotencyKey) {
      const existing = this.db
        .prepare(
          "SELECT * FROM market_snapshots WHERE contract_id = ? AND idempotency_key = ?",
        )
        .get(input.contractId, input.idempotencyKey) as unknown as SnapshotRow | undefined;
      if (existing) {
        return { snapshot: mapSnapshot(existing), replayed: true };
      }
    }
    const id = this.clock.randomUUID();
    this.db
      .prepare(
        `INSERT INTO market_snapshots (id, idempotency_key, contract_id, valuation_time,
          underlying_price, risk_free_rate, volatility, steps, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.idempotencyKey,
        input.contractId,
        input.valuationTime,
        input.underlyingPrice,
        input.riskFreeRate,
        input.volatility,
        input.steps,
        input.note,
        this.clock.now().toISOString(),
      );
    const created = this.db
      .prepare("SELECT * FROM market_snapshots WHERE id = ?")
      .get(id) as unknown as SnapshotRow;
    return { snapshot: mapSnapshot(created), replayed: false };
  }

  getSnapshot(id: string): MarketSnapshot {
    const row = this.db
      .prepare("SELECT * FROM market_snapshots WHERE id = ?")
      .get(id) as unknown as SnapshotRow | undefined;
    if (!row) {
      throw new AppError("NOT_FOUND", `Market snapshot '${id}' not found`, { id });
    }
    return mapSnapshot(row);
  }

  listSnapshots(
    contractId: string | null,
    limit: number,
    offset: number,
  ): { data: MarketSnapshot[]; total: number } {
    const rows =
      contractId === null
        ? (this.db
            .prepare(
              "SELECT * FROM market_snapshots ORDER BY valuation_time, id LIMIT ? OFFSET ?",
            )
            .all(limit, offset) as unknown as SnapshotRow[])
        : (this.db
            .prepare(
              "SELECT * FROM market_snapshots WHERE contract_id = ? ORDER BY valuation_time, id LIMIT ? OFFSET ?",
            )
            .all(contractId, limit, offset) as unknown as SnapshotRow[]);
    const total =
      contractId === null
        ? (this.db.prepare("SELECT COUNT(*) AS c FROM market_snapshots").get() as { c: number }).c
        : (this.db
            .prepare("SELECT COUNT(*) AS c FROM market_snapshots WHERE contract_id = ?")
            .get(contractId) as { c: number }).c;
    return { data: rows.map(mapSnapshot), total };
  }

  saveValuation(
    snapshotId: string,
    remainingTermYears: number,
    result: PricingResult,
    pricingBasis: string,
  ): string {
    const existing = this.db
      .prepare("SELECT id FROM valuations WHERE snapshot_id = ?")
      .get(snapshotId) as { id: string } | undefined;
    if (existing) {
      return existing.id;
    }
    const id = this.clock.randomUUID();
    this.db
      .prepare(
        `INSERT INTO valuations (id, snapshot_id, remaining_term_years, price,
          risk_neutral_probability, up_factor, down_factor, growth_factor, discount_factor,
          dt, exercised_at_root, degenerate, layers_json, created_at, pricing_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        snapshotId,
        remainingTermYears,
        result.price,
        result.riskNeutralProbability,
        result.upFactor,
        result.downFactor,
        result.growthFactor,
        result.discountFactor,
        result.dt,
        result.exercisedAtRoot ? 1 : 0,
        result.degenerateZeroVolatility ? 1 : 0,
        JSON.stringify(result.layers),
        this.clock.now().toISOString(),
        pricingBasis,
      );
    return id;
  }

  getValuation(snapshotId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare("SELECT * FROM valuations WHERE snapshot_id = ?")
      .get(snapshotId) as
      | {
          id: string;
          snapshot_id: string;
          remaining_term_years: number;
          price: number;
          risk_neutral_probability: number | null;
          up_factor: number;
          down_factor: number;
          growth_factor: number;
          discount_factor: number;
          dt: number;
          exercised_at_root: number;
          degenerate: number;
          layers_json: string;
          created_at: string;
          pricing_basis: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      snapshotId: row.snapshot_id,
      remainingTermYears: row.remaining_term_years,
      price: row.price,
      riskNeutralProbability: row.risk_neutral_probability,
      upFactor: row.up_factor,
      downFactor: row.down_factor,
      growthFactor: row.growth_factor,
      discountFactor: row.discount_factor,
      dt: row.dt,
      exercisedAtRoot: row.exercised_at_root === 1,
      degenerate: row.degenerate === 1,
      layers: JSON.parse(row.layers_json) as unknown,
      createdAt: row.created_at,
      pricingBasis: row.pricing_basis,
    };
  }

  saveReport(
    snapshotId: string,
    type: "sensitivity" | "convergence" | "node",
    payload: unknown,
  ): string {
    const id = this.clock.randomUUID();
    this.db
      .prepare(
        "INSERT INTO reports (id, snapshot_id, report_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, snapshotId, type, JSON.stringify(payload), this.clock.now().toISOString());
    return id;
  }

  listReports(snapshotId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM reports WHERE snapshot_id = ? ORDER BY created_at, id")
      .all(snapshotId) as {
      id: string;
      snapshot_id: string;
      report_type: string;
      payload_json: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      id: row.id,
      snapshotId: row.snapshot_id,
      reportType: row.report_type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: row.created_at,
    }));
  }
}


