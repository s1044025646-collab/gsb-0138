# Option Binomial Pricing Backend (Windows-local, demo only)

A from-scratch **Cox–Ross–Rubinstein (CRR) binomial tree** pricer and early
exercise analysis backend for **European and American calls/puts** with
**constant volatility** and a **continuous dividend yield**. It exposes an
HTTP API and a CLI, persists to SQLite, ships fictitious contract/quote
fixtures, and includes automated tests.

> Numerical demonstration only. There is **no web UI, no live market feed, and
> no order/trade execution**. All instruments and prices are fictitious.

## Scope and modeling conventions

- Underlying per-annum inputs: volatility `sigma >= 0`, continuously
  compounded rate `r` (**negative allowed**), continuous dividend yield
  `q >= 0`. **Discrete cash dividends are intentionally unsupported** and must
  never be folded into `q`.
- Time to expiry `T` is in years via **ACT/365 fixed** (`days/365`).
- Tree: `dt = T/n`, `u = exp(sigma sqrt(dt))`, `d = 1/u`, one-step discount
  `exp(-r dt)`, risk-neutral up probability
  `p = (exp((r-q) dt) - d) / (u - d)`.
- Backward induction node by node. **American** nodes take
  `max(continuation, immediateExercise)`; **European** nodes never exercise
  early. There is no blanket European formula applied to American nodes.
- If `p` leaves `[0,1]` the **(parameters, steps) combination is rejected**
  with code `INVALID_PROBABILITY` — probabilities are never silently clipped.
- Edge cases are finite and explainable:
  - `T = 0` → pure intrinsic (degenerate flat grid, mode
    `zero-volatility-degenerate`).
  - `sigma = 0`, `T > 0` → deterministic drift grid, still backward inducted.
  - deep ITM/OTM and negative rates → finite values, no `NaN`.
- Every tree layer reports an **early-exercise region**. An empty
  `exerciseNodes` array explicitly means "no early exercise in this layer".
- Finite-difference sensitivities record the **bump size, scheme, and reprice
  convention** (fresh full CRR rebuild, identical steps); domain-boundary
  instability is flagged (`boundaryInstable`) rather than hidden.

## Requirements

- Windows (also works cross-platform), **Node.js >= 22.5** (built-in
  `node:sqlite`; developed on Node v25). No native modules.

## Install

```powershell
npm install
```

## Tests

```powershell
npm test
```

Covers: small-tree hand calculation, European put-call parity, American
lower-bound/early exercise, expiry/zero-vol/negative-rate/deep-moneyness,
invalid probability rejection, parameter scans, snapshot reproducibility,
HTTP failure codes, pagination, idempotent resubmission, transaction rollback,
and persistence after close/reopen.

## Reproducible end-to-end demo

```powershell
npm run demo
```

Uses an injected fixed clock (`2026-01-01T00:00:00Z`) and writes
`data/demo.db`. Safe to re-run (fixtures are idempotent).

## Start / stop the API

```powershell
# binds 127.0.0.1 only; port 0 -> OS-assigned ephemeral port
npm start
# actual port and pid are written to data/server.port and data/server.pid
```

Stop with `Ctrl+C` in the running window, or:

```powershell
Stop-Process -Id (Get-Content data\server.pid)
```

Smoke test (starts, calls health/create/list, then stops its own process):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1
```

Process management is scoped to this project only.

## CLI

```powershell
npx tsx src/cli/index.ts --help

# example
npx tsx src/cli/index.ts contract:create code=DEMO type=put style=american strike=100 maturity=2027-01-01 vol=0.25
npx tsx src/cli/index.ts snapshot:freeze contract=1 spot=60 rate=0.05 label="deep ITM"
npx tsx src/cli/index.ts price contract=1 snapshot=1 steps=12
npx tsx src/cli/index.ts node 1 0 0
npx tsx src/cli/index.ts convergence contract=1 snapshot=1 steps=5,10,25,50,100
npx tsx src/cli/index.ts sensitivity contract=1 snapshot=1 parameter=spot bump=1 scheme=central
# stateless pure calculation for quick hand checks
npx tsx src/cli/index.ts calc spot=100 strike=100 T=1 rate=0.05 q=0 vol=0.2 type=call style=european steps=1
```

`--idempotency=<key>` makes create/freeze/price submissions repeat-safe.
`OPT_DB=<path>` overrides the SQLite file (default `data/options.db`).

## HTTP API

All bodies/responses are JSON. Errors are `{ "error": { code, message } }`.

- `GET  /api/health`
- `POST /api/contracts` · `GET /api/contracts?limit=&offset=` · `GET /api/contracts/:id`
- `POST /api/contracts/:id/snapshots` · `GET /api/snapshots?contractId=&limit=&offset=` · `GET /api/snapshots/:id`
- `POST /api/valuations` · `GET /api/valuations?contractId=&limit=&offset=` · `GET /api/valuations/:id`
- `GET  /api/valuations/:id/report` (per-layer early-exercise regions)
- `GET  /api/valuations/:id/nodes/:layer/:upMoves` (continuation vs exercise)
- `POST /api/convergence` `{contractId, snapshotId, stepCounts, valuationTime?}`
- `POST /api/sensitivity` `{contractId, snapshotId, steps, parameter, bump, scheme?}`

Error codes: `VALIDATION_ERROR` (400), `NOT_FOUND` (404), `CONFLICT` /
`SNAPSHOT_MISMATCH` (409), `INVALID_PROBABILITY` (422).

`POST` endpoints accept an optional `idempotencyKey`.

## Data and cleanup

All databases and runtime files stay under `data/`. Remove only project
artifacts with:

```powershell
npm run clean
```

Migrations are gated by `PRAGMA user_version` and use `IF NOT EXISTS`, so they
are safe to run repeatedly on an existing database.
