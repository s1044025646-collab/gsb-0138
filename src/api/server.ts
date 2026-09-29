import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../db/database.ts";
import { systemClock } from "../db/database.ts";
import { createApp, listenLocalhost } from "./app.ts";

const DB_PATH = process.env.OPTIONS_DB_PATH ?? join("data", "options.sqlite");
const RUNTIME_DIR = join("data");

const db = openDatabase(DB_PATH);
const server = createApp(db, systemClock);

const { port } = await listenLocalhost(server, Number(process.env.PORT ?? 0));

writeFileSync(join(RUNTIME_DIR, "server.port"), String(port), "utf-8");
writeFileSync(join(RUNTIME_DIR, "server.pid"), String(process.pid), "utf-8");

console.log(`[options-backend] listening on http://127.0.0.1:${port} (PID ${process.pid})`);
console.log(`[options-backend] database: ${DB_PATH}`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[options-backend] received ${signal}, stopping...`);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDatabase(db);
  console.log("[options-backend] stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
