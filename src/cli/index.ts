#!/usr/bin/env node
import { parseArgs } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/database.js";
import { systemClock } from "../core/clock.js";
import { OptionService } from "../core/service.js";
import { ApiError } from "../core/errors.js";
import { price } from "../pricing/crr.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbPath = process.env.OPT_DB ?? join(root, "data", "options.db");

function json(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || Number.isNaN(n)) throw new CliError(`${name} is required and must be a number`);
  return n;
}

class CliError extends Error {}

async function main() {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      idempotency: { type: "string" },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }

  const db = openDatabase(dbPath);
  const svc = new OptionService(db, systemClock);
  const idem = (values.idempotency as string) ?? undefined;

  try {
    switch (cmd) {
      case "contract:create": {
        const a = parseKv(positionals.slice(1));
        const before = svc.listContracts(1, 0).total;
        const c = svc.createContract({
          idempotencyKey: idem,
          code: String(a.code ?? ""),
          optionType: a.type === "put" ? "put" : "call",
          style: a.style === "american" ? "american" : "european",
          strike: num(a.strike, "strike"),
          maturityDate: String(a.maturity ?? ""),
          annualVolatility: num(a.vol, "vol"),
          continuousDividendYield: a.q === undefined ? 0 : num(a.q, "q"),
        });
        const after = svc.listContracts(1, 0).total;
        console.log(`[before] contracts total = ${before}`);
        console.log("[created]", json(c));
        console.log(`[after]  contracts total = ${after}`);
        break;
      }
      case "contract:list": {
        const limit = Number(positionals[1] ?? 50);
        const offset = Number(positionals[2] ?? 0);
        console.log(json(svc.listContracts(limit, offset)));
        break;
      }
      case "snapshot:freeze": {
        const a = parseKv(positionals.slice(1));
        const contractId = num(a.contract, "contract");
        const before = svc.listSnapshots(contractId, 1, 0).total;
        const s = svc.createSnapshot({
          idempotencyKey: idem,
          contractId,
          label: a.label === undefined ? undefined : String(a.label),
          spot: num(a.spot, "spot"),
          riskFreeRate: num(a.rate, "rate"),
          capturedAt: a.at === undefined ? undefined : String(a.at),
        });
        const after = svc.listSnapshots(contractId, 1, 0).total;
        console.log(`[before] snapshots for contract ${contractId} = ${before}`);
        console.log("[frozen]", json(s));
        console.log(`[after]  snapshots for contract ${contractId} = ${after}`);
        break;
      }
      case "price": {
        const a = parseKv(positionals.slice(1));
        const contractId = num(a.contract, "contract");
        const snapshotId = num(a.snapshot, "snapshot");
        const steps = num(a.steps ?? "100", "steps");
        const v = svc.runValuation({
          idempotencyKey: idem,
          contractId,
          snapshotId,
          steps,
          valuationTime: a.at === undefined ? undefined : String(a.at),
        });
        console.log("[valuation]", json(v));
        console.log("[report]", json(svc.getReport(Number((v as { id: number }).id))));
        break;
      }
      case "node": {
        const [vidStr, layerStr, jStr] = positionals.slice(1);
        console.log(
          json(svc.explainNode(num(vidStr, "valuationId"), num(layerStr, "layer"), num(jStr, "upMoves"))),
        );
        break;
      }
      case "convergence": {
        const a = parseKv(positionals.slice(1));
        const steps = String(a.steps ?? "10,25,50,100,200")
          .split(",")
          .map((s) => Number(s.trim()));
        console.log(
          json(
            svc.runConvergence(
              num(a.contract, "contract"),
              num(a.snapshot, "snapshot"),
              steps,
              a.at === undefined ? undefined : String(a.at),
            ),
          ),
        );
        break;
      }
      case "sensitivity": {
        const a = parseKv(positionals.slice(1));
        console.log(
          json(
            svc.runSensitivity(
              num(a.contract, "contract"),
              num(a.snapshot, "snapshot"),
              num(a.steps ?? "100", "steps"),
              {
                parameter: String(a.parameter ?? "spot") as never,
                bump: num(a.bump ?? "0.5", "bump"),
                scheme: (a.scheme as "central") ?? "central",
              },
              a.at === undefined ? undefined : String(a.at),
            ),
          ),
        );
        break;
      }
      case "calc": {
        const a = parseKv(positionals.slice(1));
        console.log(
          json(
            price({
              spot: num(a.spot, "spot"),
              strike: num(a.strike, "strike"),
              maturityYears: num(a.T, "T"),
              riskFreeRate: num(a.rate, "rate"),
              dividendYield: num(a.q ?? "0", "q"),
              volatility: num(a.vol, "vol"),
              optionType: a.type === "put" ? "put" : "call",
              style: a.style === "american" ? "american" : "european",
              steps: num(a.steps ?? "3", "steps"),
            }),
          ),
        );
        break;
      }
      default:
        throw new CliError(`unknown command: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(`error [${err.code}]: ${err.message}`);
      process.exitCode = 1;
    } else if (err instanceof CliError) {
      console.error(`error: ${err.message}\n\n${USAGE}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }
}

function parseKv(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) throw new CliError(`expected key=value, got ${arg}`);
    out[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return out;
}

const USAGE = `optcli - local CRR binomial option pricing CLI (demo only)

Commands:
  contract:create code=.. type=call|put style=european|american strike=.. maturity=YYYY-MM-DD vol=.. [q=..]
  contract:list [limit] [offset]
  snapshot:freeze contract=.. spot=.. rate=.. [label=..] [at=ISO]
  price contract=.. snapshot=.. [steps=100] [at=ISO]
  node <valuationId> <layer> <upMoves>
  convergence contract=.. snapshot=.. [steps=10,25,50,100,200] [at=ISO]
  sensitivity contract=.. snapshot=.. parameter=spot|volatility|riskFreeRate|dividendYield|strike|maturityYears [bump=..] [scheme=central|forward|backward] [steps=100]
  calc spot=.. strike=.. T=.. rate=.. [q=0] vol=.. type=call|put style=.. [steps=3]

Global:
  --idempotency=<key>   repeat-safe submission key for create/freeze/price
  OPT_DB=<path>         override SQLite file (default data/options.db)
`;

main();
