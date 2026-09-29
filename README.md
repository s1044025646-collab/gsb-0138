# Fictional Option Binomial Pricing Backend (Windows-local)

A local-only backend for **Cox–Ross–Rubinstein (CRR) binomial option pricing and early-exercise analysis**, built with **TypeScript + Node.js (native type stripping) + built-in `node:sqlite`**.

Scope and limitations:

- European and American **calls and puts** only.
- Constant volatility, constant **continuously compounded** interest rate and **continuous dividend yield**.
- **Discrete cash dividends are explicitly rejected** (`UNSUPPORTED_FEATURE`); they must never be encoded as the continuous yield.
- Fictional contracts and fictional market fixtures only. **No web UI, no real market connection, no order/trade execution.** All numbers are numerical demonstrations, not investment advice.

## Requirements

- Windows with PowerShell (commands shown for PowerShell)
- Node.js **>= 22.5** (developed and verified on Node 25.5.0)
- npm (used only to install TypeScript type-check dev dependencies)

The runtime uses Node's built-in SQLite (`node:sqlite`) — no native modules to compile.

## Install

```powershell
npm install
```

## Run the automated tests

```powershell
npm test
```

This runs 29 checks covering: hand-computed small trees, put-call parity, American lower bounds, expiry/zero-vol/negative-rate/deep-ITM-OTM cases, invalid-probability rejection, step-convergence vs Black-Scholes, finite-difference sensitivities, parameter scans, idempotent replay, pagination error paths, transaction rollback, and persistence across restart.

Type checking (optional):

```powershell
npm run typecheck
```

## Repeatable end-to-end demo

```powershell
npm run demo
```

The demo recreates `data/demo.sqlite` on every run, seeds the fictional fixtures from `fixtures/fiction.json`, and prints:

1. American call **without dividends** (equals European; every pre-maturity layer reports no exercise region, `range: null`).
2. Deep in-the-money American put with the **per-layer early-exercise region** (node indices and contiguous range).
3. Expiry / zero remaining term (intrinsic value only; probability is `null`).
4. Zero volatility deterministic branch (no NaN, probability `null`).
5. Node explanation (continuation vs immediate exercise at a chosen lattice node).
6. Step-count convergence table.
7. Finite-difference sensitivities with recorded bump sizes and recomputation method; boundary instability flags.
8. An invalid-probability parameter set rejected with `INVALID_PROBABILITY`.

## Start the API server

```powershell
npm run serve
# or, with an explicit port (0 = automatic free port):
node --experimental-sqlite src/api/server.ts
$env:PORT="8080"; node --experimental-sqlite src/api/server.ts
```

The server **only binds `127.0.0.1`**, uses an automatic free port by default, and writes its runtime files inside the project:

- `data/server.port` — chosen port
- `data/server.pid` — managed process PID
- `data/options.sqlite` (+ `-wal`/`-shm`) — database (override with `OPTIONS_DB_PATH`)

Stop the managed server (only ever signals the PID recorded by this project):

```powershell
node --experimental-sqlite src/cli/main.ts stop
```

Or press `Ctrl+C` in the server window.

## CLI usage

```powershell
node --experimental-sqlite src/cli/main.ts --help
```

Key commands (state-before/state-after counts are printed for creates):

```powershell
node --experimental-sqlite src/cli/main.ts init-db
node --experimental-sqlite src/cli/main.ts seed-fixtures
node --experimental-sqlite src/cli/main.ts create-contract --code DEMO-C --type call --style american --strike 100 --maturity 2027-09-29 --dividend-yield 0 --idempotency-key demo-c-1
node --experimental-sqlite src/cli/main.ts list-contracts --limit 20 --offset 0
node --experimental-sqlite src/cli/main.ts freeze-snapshot --contract-id <ID> --time 2026-09-29T00:00:00Z --spot 100 --rate 0.05 --sigma 0.25 --steps 100 --idempotency-key snap-1
node --experimental-sqlite src/cli/main.ts list-snapshots --contract-id <ID>
node --experimental-sqlite src/cli/main.ts price --snapshot-id <ID>
node --experimental-sqlite src/cli/main.ts explain --snapshot-id <ID> --step 10 --up-moves 0
node --experimental-sqlite src/cli/main.ts convergence --snapshot-id <ID> --steps 10,25,50,100,200
node --experimental-sqlite src/cli/main.ts sensitivity --snapshot-id <ID>
node --experimental-sqlite src/cli/main.ts price-adhoc --json '{"optionType":"put","style":"american","strike":100,"remainingTermYears":1,"underlyingPrice":80,"riskFreeRate":0.05,"volatility":0.3,"continuousDividendYield":0.02,"steps":50}'
```

Repeated create/freeze calls with the same `--idempotency-key` (or `Idempotency-Key` HTTP header) return the original record and are reported as idempotent replays.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `POST` | `/contracts` | Create contract (header `Idempotency-Key`) |
| `GET` | `/contracts?limit=&offset=` | Paginated contracts |
| `GET` | `/contracts/:id` | Fetch one contract |
| `POST` | `/contracts/:id/snapshots` | Freeze a market/valuation snapshot |
| `GET` | `/snapshots?contractId=&limit=&offset=` | Paginated snapshots |
| `GET` | `/snapshots/:id` | Fetch one snapshot |
| `POST` | `/snapshots/:id/price` | Run/retrieve CRR valuation for the snapshot |
| `POST` | `/snapshots/:id/explain` | Body `{ "step": i, "upMoves": j }` |
| `POST` | `/snapshots/:id/convergence` | Body `{ "steps": [10,25,50,...] }` |
| `POST` | `/snapshots/:id/sensitivity` | Finite-difference Greeks report |
| `GET` | `/snapshots/:id/reports` | Stored reports for a snapshot |
| `POST` | `/price` | Stateless ad-hoc pricing |

Error responses use `{ "error": { "code", "message", "details" } }` with codes:
`VALIDATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `INVALID_PROBABILITY`, `UNSUPPORTED_FEATURE`, `INVALID_PAGINATION`.

Example:

```powershell
$port = Get-Content data/server.port
Invoke-RestMethod "http://127.0.0.1:$port/contracts?limit=5&offset=0"
```

## Pricing conventions (annualized / discounting basis)

- Remaining term `T`: calendar time from valuation timestamp to the maturity date under **ACT/365F**, floored at zero (never negative, never NaN).
- Time step `dt = T / N`; per-step **discount factor** `exp(-r·dt)` with annualized continuously compounded rate `r` (negative rates allowed).
- CRR factors: `u = exp(σ·√dt)`, `d = 1/u`, growth `a = exp((r−q)·dt)`, risk-neutral up probability `p = (a − d)/(u − d)`.
- **If `p ≤ 0` or `p ≥ 1` (or non-finite), the parameter/step combination is rejected with `INVALID_PROBABILITY`; probabilities are never silently clipped.**
- Backward induction: European nodes hold only discounted risk-neutral continuation; **American nodes compare continuation value with the immediate intrinsic payoff and take the larger**, node by node — no European shortcut formula is applied to American options.
- Zero term: value equals intrinsic payoff. Zero volatility: a deterministic single-branch lattice (`u = d = exp((r−q)dt)`, probability reported as `null`) with an explanatory flag.
- Each valuation stores per-layer early-exercise node indices; a layer with no exercise region reports `exerciseNodes: []`, `range: null`, `count: 0`.
- Sensitivities use central finite differences (`delta`, `gamma`, `vega`, `rho`, `theta`); every bumped input rebuilds the full tree. Bump sizes, the recomputation basis, and boundary-instability warnings are stored in the report.

## Project layout

```
src/domain/      types, validation, CRR lattice, greeks, convergence
src/db/          SQLite connection + repeatable migrations
src/services/    repositories, idempotency, pricing orchestration, day count
src/api/         HTTP app and local-only server entry
src/cli/         CLI, fixture seeding, repeatable demo
fixtures/        fictional contracts and market snapshots
test/            node:test automated tests
data/            local DB and runtime pid/port files (git-ignored)
```

## Cleanup

All generated state lives under `data/` in this project. Delete it to reset everything:

```powershell
Remove-Item data/*.sqlite*,data/server.pid,data/server.port -ErrorAction SilentlyContinue
```

Start/stop commands manage only the project server whose PID is recorded in `data/server.pid`.
