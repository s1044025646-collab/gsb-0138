import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT UNIQUE,
    code TEXT NOT NULL UNIQUE,
    option_type TEXT NOT NULL CHECK (option_type IN ('call','put')),
    style TEXT NOT NULL CHECK (style IN ('european','american')),
    strike REAL NOT NULL CHECK (strike > 0),
    maturity_date TEXT NOT NULL,
    continuous_dividend_yield REAL NOT NULL CHECK (continuous_dividend_yield >= 0),
    contract_unit REAL NOT NULL DEFAULT 1 CHECK (contract_unit > 0),
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS market_snapshots (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT,
    contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
    valuation_time TEXT NOT NULL,
    underlying_price REAL NOT NULL CHECK (underlying_price >= 0),
    risk_free_rate REAL NOT NULL,
    volatility REAL NOT NULL CHECK (volatility >= 0),
    steps INTEGER NOT NULL CHECK (steps > 0),
    note TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (contract_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS valuations (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES market_snapshots(id) ON DELETE CASCADE,
    remaining_term_years REAL NOT NULL CHECK (remaining_term_years >= 0),
    price REAL NOT NULL,
    risk_neutral_probability REAL,
    up_factor REAL NOT NULL,
    down_factor REAL NOT NULL,
    growth_factor REAL NOT NULL,
    discount_factor REAL NOT NULL,
    dt REAL NOT NULL,
    exercised_at_root INTEGER NOT NULL,
    degenerate INTEGER NOT NULL,
    layers_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    pricing_basis TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    snapshot_id TEXT NOT NULL REFERENCES market_snapshots(id) ON DELETE CASCADE,
    report_type TEXT NOT NULL CHECK (report_type IN ('sensitivity','convergence','node')),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_snapshots_contract ON market_snapshots(contract_id, valuation_time);
  CREATE INDEX IF NOT EXISTS idx_valuations_snapshot ON valuations(snapshot_id);
  CREATE INDEX IF NOT EXISTS idx_reports_snapshot ON reports(snapshot_id);
  `,
];

export function applyMigrations(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  for (let version = current + 1; version <= SCHEMA_VERSION; version += 1) {
    const sql = MIGRATIONS[version - 1];
    if (!sql) continue;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
