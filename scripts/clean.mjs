// Removes only project-local runtime artifacts. Never touches other paths.
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  join(root, "data", "options.db"),
  join(root, "data", "options.db-shm"),
  join(root, "data", "options.db-wal"),
  join(root, "data", "demo.db"),
  join(root, "data", "demo.db-shm"),
  join(root, "data", "demo.db-wal"),
  join(root, "data", "test.db"),
  join(root, "data", "test.db-shm"),
  join(root, "data", "test.db-wal"),
  join(root, "data", "e2e.db"),
  join(root, "data", "e2e.db-shm"),
  join(root, "data", "e2e.db-wal"),
  join(root, "data", "cli.db"),
  join(root, "data", "cli.db-shm"),
  join(root, "data", "cli.db-wal"),
  join(root, "data", "srv.db"),
  join(root, "data", "srv.db-shm"),
  join(root, "data", "srv.db-wal"),
  join(root, "data", "srv.err.log"),
  join(root, "data", "srv.out.log"),
  join(root, "data", "server.port"),
  join(root, "data", "server.pid"),
];
for (const t of targets) {
  if (existsSync(t)) {
    rmSync(t, { force: true });
    console.log("removed", t);
  }
}
