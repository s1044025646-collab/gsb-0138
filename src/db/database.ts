import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations } from "./migrations.ts";

export interface Clock {
  now(): Date;
  randomUUID(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  randomUUID: () => globalThis.crypto.randomUUID(),
};

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  applyMigrations(db);
  return db;
}

export function closeDatabase(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // best effort on close
  }
  db.close();
}
