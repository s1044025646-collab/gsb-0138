import { DatabaseSync } from "node:sqlite";

/**
 * Idempotent migrations. Re-running on an existing database is a no-op:
 * user_version gates each block and IF NOT EXISTS guards object creation.
 */
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        code TEXT NOT NULL UNIQUE,
        option_type TEXT NOT NULL CHECK (option_type IN ('call','put')),
        style TEXT NOT NULL CHECK (style IN ('european','american')),
        strike REAL NOT NULL CHECK (strike > 0),
        maturity_date TEXT NOT NULL,
        annual_volatility REAL NOT NULL CHECK (annual_volatility >= 0),
        continuous_dividend_yield REAL NOT NULL DEFAULT 0 CHECK (continuous_dividend_yield >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS market_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        label TEXT,
        spot REAL NOT NULL CHECK (spot > 0),
        risk_free_rate REAL NOT NULL,
        captured_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS valuation_points (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT UNIQUE,
        contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
        snapshot_id INTEGER NOT NULL REFERENCES market_snapshots(id) ON DELETE CASCADE,
        steps INTEGER NOT NULL CHECK (steps >= 1),
        valuation_time TEXT NOT NULL,
        time_to_expiry_years REAL NOT NULL CHECK (time_to_expiry_years >= 0),
        price REAL,
        risk_neutral_probability REAL,
        up REAL,
        down REAL,
        dt REAL,
        discount REAL,
        lattice_mode TEXT,
        early_exercise_node_count INTEGER,
        status TEXT NOT NULL CHECK (status IN ('ok','rejected')),
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        valuation_id INTEGER NOT NULL REFERENCES valuation_points(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
];

export function migrate(db: DatabaseSync): void {
  const current = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  for (let v = current; v < MIGRATIONS.length; v++) {
    const apply = MIGRATIONS[v]!;
    db.exec("BEGIN");
    try {
      apply(db);
      db.prepare(`PRAGMA user_version = ${v + 1}`).run();
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
