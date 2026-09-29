import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/database.js";
import { systemClock } from "../core/clock.js";
import { OptionService } from "../core/service.js";
import { buildApp } from "./app.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = process.env.OPT_DB ?? join(root, "data", "options.db");
const db = openDatabase(dbPath);
const svc = new OptionService(db, systemClock);
const server = buildApp(svc, db);

// Bind only to loopback; port 0 lets the OS assign an ephemeral port.
server.listen(Number(process.env.PORT ?? 0), "127.0.0.1", () => {
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : Number(process.env.PORT ?? 0);
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "server.port"), String(port));
  writeFileSync(join(root, "data", "server.pid"), String(process.pid));
  console.log(`options API listening on http://127.0.0.1:${port} (pid ${process.pid}, db ${dbPath})`);
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
