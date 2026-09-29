import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase, systemClock, type Clock } from "../db/database.ts";
import { Repository } from "../services/repository.ts";
import { PricingService, PRICING_BASIS } from "../services/pricing-service.ts";
import { loadFixtures, seedFixtures } from "./fixture-loader.ts";
import { evaluateTree } from "../domain/binomial.ts";
import { validatePricingInputs } from "../domain/validation.ts";
import { isAppError } from "../domain/errors.ts";

const HELP = `
options-backend CLI (fictional data, numerical demo only)

Usage:
  node --experimental-sqlite src/cli/main.ts <command> [args]

Commands:
  init-db [--db PATH]
  create-contract --code CODE --type call|put --style european|american \\
      --strike K --maturity YYYY-MM-DD [--dividend-yield Q] [--unit U] [--note N] [--idempotency-key KEY]
  list-contracts [--limit N] [--offset N]
  freeze-snapshot --contract-id ID --time ISO8601 --spot S --rate R --sigma V --steps N [--note N] [--idempotency-key KEY]
  list-snapshots [--contract-id ID] [--limit N] [--offset N]
  price --snapshot-id ID
  explain --snapshot-id ID --step I --up-moves J
  sensitivity --snapshot-id ID
  convergence --snapshot-id ID --steps 10,25,50,100,200
  price-adhoc --json '{"optionType":"call","style":"european",...}'
  seed-fixtures [--fixtures PATH]
  demo
  serve [--port 0]
  stop
`;

function arg(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requireArg(args: string[], name: string): string {
  const value = arg(args, name);
  if (value === undefined) {
    throw new Error(`Missing required argument ${name}`);
  }
  return value;
}

function dbPath(args: string[]): string {
  return arg(args, "--db") ?? join("data", "options.sqlite");
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function withDb<T>(args: string[], fn: (db: DatabaseSync, clock: Clock) => T): T {
  const path = dbPath(args);
  const db = openDatabase(path);
  try {
    return fn(db, systemClock);
  } finally {
    closeDatabase(db);
  }
}

function snapshotIdsByCode(db: DatabaseSync, clock: Clock): Map<string, string> {
  const fixtures = loadFixtures(join("fixtures", "fiction.json"));
  const ids = seedFixtures(db, clock, fixtures);
  return ids;
}

async function main(rawArgs: string[]): Promise<number> {
  const [command, ...rest] = rawArgs;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP.trim());
    return 0;
  }

  try {
    switch (command) {
      case "init-db": {
        const path = dbPath(rest);
        const before = existsSync(path);
        const db = openDatabase(path);
        closeDatabase(db);
        console.log(`[before] database existed: ${before}`);
        console.log(`[after]  database ready at ${path} (migrations idempotent)`);
        return 0;
      }

      case "create-contract": {
        return withDb(rest, (db, clock) => {
          const repo = new Repository(db, clock);
          const before = repo.listContracts(1, 0).total;
          const input = {
            code: requireArg(rest, "--code"),
            optionType: requireArg(rest, "--type") as "call" | "put",
            style: requireArg(rest, "--style") as "european" | "american",
            strike: Number(requireArg(rest, "--strike")),
            maturityDate: requireArg(rest, "--maturity"),
            continuousDividendYield: Number(arg(rest, "--dividend-yield") ?? "0"),
            contractUnit: Number(arg(rest, "--unit") ?? "1"),
            note: arg(rest, "--note") ?? null,
            idempotencyKey: arg(rest, "--idempotency-key") ?? null,
          };
          if (input.optionType !== "call" && input.optionType !== "put") {
            throw new Error("--type must be call or put");
          }
          if (input.style !== "european" && input.style !== "american") {
            throw new Error("--style must be european or american");
          }
          const { contract, replayed } = repo.createContract(input);
          const after = repo.listContracts(1, 0).total;
          console.log(`[before] contract count: ${before}`);
          console.log(`[after]  contract count: ${after}, idempotentReplay: ${replayed}`);
          printJson(contract);
          return 0;
        });
      }

      case "list-contracts": {
        return withDb(rest, (db, clock) => {
          const limit = Number(arg(rest, "--limit") ?? "50");
          const offset = Number(arg(rest, "--offset") ?? "0");
          printJson(new Repository(db, clock).listContracts(limit, offset));
          return 0;
        });
      }

      case "freeze-snapshot": {
        return withDb(rest, (db, clock) => {
          const repo = new Repository(db, clock);
          const contractId = requireArg(rest, "--contract-id");
          const contract = repo.getContract(contractId);
          const input = {
            contractId,
            valuationTime: requireArg(rest, "--time"),
            underlyingPrice: Number(requireArg(rest, "--spot")),
            riskFreeRate: Number(requireArg(rest, "--rate")),
            volatility: Number(requireArg(rest, "--sigma")),
            steps: Number(requireArg(rest, "--steps")),
            note: arg(rest, "--note") ?? null,
            idempotencyKey: arg(rest, "--idempotency-key") ?? null,
          };
          const before = repo.listSnapshots(contractId, 1, 0).total;
          const { snapshot, replayed } = repo.createSnapshot(input);
          const after = repo.listSnapshots(contractId, 1, 0).total;
          console.log(`[before] snapshots for ${contract.code}: ${before}`);
          console.log(`[after]  snapshots for ${contract.code}: ${after}, idempotentReplay: ${replayed}`);
          printJson(snapshot);
          return 0;
        });
      }

      case "list-snapshots": {
        return withDb(rest, (db, clock) => {
          const limit = Number(arg(rest, "--limit") ?? "50");
          const offset = Number(arg(rest, "--offset") ?? "0");
          printJson(new Repository(db, clock).listSnapshots(arg(rest, "--contract-id") ?? null, limit, offset));
          return 0;
        });
      }

      case "price": {
        return withDb(rest, (db, clock) => {
          const snapshotId = requireArg(rest, "--snapshot-id");
          printJson(new PricingService(db, clock).priceSnapshot(snapshotId));
          return 0;
        });
      }

      case "explain": {
        return withDb(rest, (db, clock) => {
          const result = new PricingService(db, clock).explainSnapshotNode(
            requireArg(rest, "--snapshot-id"),
            Number(requireArg(rest, "--step")),
            Number(requireArg(rest, "--up-moves")),
          );
          printJson(result);
          return 0;
        });
      }

      case "sensitivity": {
        return withDb(rest, (db, clock) => {
          printJson(new PricingService(db, clock).sensitivitySnapshot(requireArg(rest, "--snapshot-id")));
          return 0;
        });
      }

      case "convergence": {
        return withDb(rest, (db, clock) => {
          const steps = requireArg(rest, "--steps")
            .split(",")
            .map((value) => Number(value.trim()));
          printJson(
            new PricingService(db, clock).convergenceSnapshot(
              requireArg(rest, "--snapshot-id"),
              steps,
            ),
          );
          return 0;
        });
      }

      case "price-adhoc": {
        const raw = requireArg(rest, "--json");
        const inputs = validatePricingInputs(JSON.parse(raw));
        printJson({ inputs, result: evaluateTree(inputs).result });
        return 0;
      }

      case "seed-fixtures": {
        const fixturePath = arg(rest, "--fixtures") ?? join("fixtures", "fiction.json");
        return withDb(rest, (db, clock) => {
          const ids = seedFixtures(db, clock, loadFixtures(fixturePath));
          console.log("Seeded fictional fixtures (re-runs are idempotent):");
          printJson(Object.fromEntries(ids));
          return 0;
        });
      }

      case "serve": {
        const port = Number(arg(rest, "--port") ?? process.env.PORT ?? "0");
        const child = spawn(
          process.execPath,
          ["--experimental-sqlite", join("src", "api", "server.ts")],
          {
            stdio: "inherit",
            env: { ...process.env, PORT: String(port), OPTIONS_DB_PATH: dbPath(rest) },
          },
        );
        child.on("exit", (code) => process.exit(code ?? 0));
        return new Promise<number>((resolve) => {
          child.on("error", (error) => {
            console.error(error);
            resolve(1);
          });
        });
      }

      case "stop": {
        const pidFile = join("data", "server.pid");
        if (!existsSync(pidFile)) {
          console.log("No managed server PID file found under data/. Nothing to stop.");
          return 0;
        }
        const pid = Number(readFileSync(pidFile, "utf-8").trim());
        if (!Number.isInteger(pid) || pid <= 0) {
          console.log("Invalid PID file; leaving data/server.pid for inspection.");
          return 1;
        }
        try {
          process.kill(pid, "SIGTERM");
          console.log(`Sent SIGTERM to project server PID ${pid}.`);
        } catch (error) {
          console.log(`Server PID ${pid} was not running (${(error as Error).message}).`);
        }
        return 0;
      }

      case "demo": {
        return runDemo(join("data", "demo.sqlite"));
      }

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP.trim());
        return 2;
    }
  } catch (error) {
    if (isAppError(error)) {
      console.error(JSON.stringify({ error: { code: error.code, message: error.message, details: error.details } }, null, 2));
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function runDemo(path: string): number {
  if (existsSync(path)) rmSync(path, { force: true });
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(path + suffix, { force: true });
  }
  const db = openDatabase(path);
  try {
    console.log("=== Fictional option binomial pricing demo ===");
    const fixtures = loadFixtures(join("fixtures", "fiction.json"));
    const ids = seedFixtures(db, systemClock, fixtures);
    const pricing = new PricingService(db, systemClock);

    const amCallSnapshot = ids.get("FAKE-AMC-NODIV:snapshot")!;
    const amPutSnapshot = ids.get("FAKE-AMP-DEEP:snapshot")!;
    const expirySnapshot = ids.get("FAKE-EXP-AT:snapshot")!;
    const zeroVolSnapshot = ids.get("FAKE-ZV-CALL:snapshot")!;

    console.log("\n-- American call WITHOUT dividends (should match European, no early exercise) --");
    printJson(pricing.priceSnapshot(amCallSnapshot));

    console.log("\n-- Deep ITM American PUT (early-exercise region per layer) --");
    printJson(pricing.priceSnapshot(amPutSnapshot));

    console.log("\n-- Expiry / zero remaining term (intrinsic only) --");
    printJson(pricing.priceSnapshot(expirySnapshot));

    console.log("\n-- Zero volatility deterministic branch --");
    printJson(pricing.priceSnapshot(zeroVolSnapshot));

    console.log("\n-- Node explanation (American put, step 10, up-moves 0 = lowest node) --");
    printJson(pricing.explainSnapshotNode(amPutSnapshot, 10, 0));

    console.log("\n-- Step-count convergence --");
    printJson(pricing.convergenceSnapshot(amCallSnapshot, [25, 50, 100, 200, 400]));

    console.log("\n-- Finite-difference sensitivities (bump sizes recorded) --");
    printJson(pricing.sensitivitySnapshot(amCallSnapshot));

    console.log("\n-- Invalid probability case must be rejected --");
    const invalid = validatePricingInputs({
      ...JSON.parse(
        JSON.stringify(
          fixtures.contracts.find((c) => c.code === "FAKE-AMP-DEEP"),
        ),
      ),
      underlyingPrice: 100,
      remainingTermYears: 1,
      riskFreeRate: -0.8,
      volatility: 0.01,
      steps: 1,
    });
    try {
      evaluateTree(invalid);
      console.error("ERROR: expected INVALID_PROBABILITY rejection");
      return 1;
    } catch (error) {
      if (isAppError(error) && error.code === "INVALID_PROBABILITY") {
        printJson({ rejected: true, code: error.code, details: error.details });
      } else {
        throw error;
      }
    }

    console.log("\nPricing basis:");
    console.log(PRICING_BASIS);
    console.log("\nDemo database left at", path, "(restart-safe; re-running demo recreates it).");
    return 0;
  } finally {
    closeDatabase(db);
  }
}

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
