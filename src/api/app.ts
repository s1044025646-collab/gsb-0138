import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { AppError, isAppError } from "../domain/errors.ts";
import {
  exerciseStyle,
  finiteNumber,
  nonNegativeNumber,
  optionType,
  positiveNumber,
  validateDate,
  validatePagination,
  validatePricingInputs,
  validateSteps,
  validateTimestamp,
} from "../domain/validation.ts";
import { evaluateTree } from "../domain/binomial.ts";
import type { Clock } from "../db/database.ts";
import { PricingService } from "../services/pricing-service.ts";
import { Repository } from "../services/repository.ts";

interface RouteContext {
  db: DatabaseSync;
  clock: Clock;
  repo: Repository;
  pricing: PricingService;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorBody(code: string, message: string, details: unknown) {
  return { error: { code, message, details: details ?? null } };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

type Handler = (
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const patternSource = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return {
    method,
    pattern: new RegExp(`^/${patternSource}$`),
    paramNames,
    handler,
  };
}

const routes: Route[] = [
  route("GET", "/health", async (_ctx, _req, res) => {
    send(res, 200, { status: "ok" });
  }),

  route("POST", "/contracts", async (ctx, req, res) => {
    const body = asRecord(await readJson(req));
    const input = {
      code: typeof body.code === "string" && body.code.trim() !== "" ? body.code.trim() : "",
      optionType: optionType(body.optionType),
      style: exerciseStyle(body.style),
      strike: positiveNumber(body.strike, "strike"),
      maturityDate: validateDate(body.maturityDate, "maturityDate"),
      continuousDividendYield: nonNegativeNumber(
        body.continuousDividendYield,
        "continuousDividendYield",
      ),
      contractUnit:
        body.contractUnit === undefined
          ? 1
          : positiveNumber(body.contractUnit, "contractUnit"),
      note: body.note === undefined || body.note === null ? null : String(body.note),
      idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
    };
    if (input.code === "") {
      throw new AppError("VALIDATION_ERROR", "Field 'code' must be a non-empty string");
    }
    if ("cashDividend" in body || "discreteDividend" in body) {
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "Discrete cash dividends are not supported; only a continuous dividend yield is modeled. Do not encode cash dividends as the yield.",
      );
    }
    const { contract, replayed } = ctx.repo.createContract(input);
    send(res, replayed ? 200 : 201, { contract, idempotentReplay: replayed });
  }),

  route("GET", "/contracts", async (ctx, _req, res, _params, query) => {
    const { limit, offset } = validatePagination(query);
    const result = ctx.repo.listContracts(limit, offset);
    send(res, 200, paginated(result.data, result.total, limit, offset));
  }),

  route("GET", "/contracts/:id", async (ctx, _req, res, params) => {
    send(res, 200, { contract: ctx.repo.getContract(params.id!) });
  }),

  route("POST", "/contracts/:id/snapshots", async (ctx, req, res, params) => {
    ctx.repo.getContract(params.id!);
    const body = asRecord(await readJson(req));
    const input = {
      contractId: params.id!,
      valuationTime: validateTimestamp(body.valuationTime, "valuationTime"),
      underlyingPrice: nonNegativeNumber(body.underlyingPrice, "underlyingPrice"),
      riskFreeRate: finiteNumber(body.riskFreeRate, "riskFreeRate"),
      volatility: nonNegativeNumber(body.volatility, "volatility"),
      steps: validateSteps(body.steps),
      note: body.note === undefined || body.note === null ? null : String(body.note),
      idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
    };
    const { snapshot, replayed } = ctx.repo.createSnapshot(input);
    send(res, replayed ? 200 : 201, { snapshot, idempotentReplay: replayed });
  }),

  route("GET", "/snapshots", async (ctx, _req, res, _params, query) => {
    const { limit, offset } = validatePagination(query);
    const contractId = query.get("contractId");
    const result = ctx.repo.listSnapshots(contractId, limit, offset);
    send(res, 200, paginated(result.data, result.total, limit, offset));
  }),

  route("GET", "/snapshots/:id", async (ctx, _req, res, params) => {
    send(res, 200, { snapshot: ctx.repo.getSnapshot(params.id!) });
  }),

  route("POST", "/snapshots/:id/price", async (ctx, _req, res, params) => {
    send(res, 200, ctx.pricing.priceSnapshot(params.id!));
  }),

  route("POST", "/snapshots/:id/explain", async (ctx, req, res, params) => {
    const body = asRecord(await readJson(req));
    const step = finiteNumber(body.step, "step");
    const upMoves = finiteNumber(body.upMoves, "upMoves");
    send(
      res,
      200,
      ctx.pricing.explainSnapshotNode(params.id!, step, upMoves),
    );
  }),

  route("POST", "/snapshots/:id/sensitivity", async (ctx, _req, res, params) => {
    send(res, 200, ctx.pricing.sensitivitySnapshot(params.id!));
  }),

  route("POST", "/snapshots/:id/convergence", async (ctx, req, res, params) => {
    const body = asRecord(await readJson(req));
    if (!Array.isArray(body.steps) || body.steps.length === 0) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Field 'steps' must be a non-empty array of positive integers",
      );
    }
    const steps = body.steps.map((value) => validateSteps(value));
    send(res, 200, ctx.pricing.convergenceSnapshot(params.id!, steps));
  }),

  route("GET", "/snapshots/:id/reports", async (ctx, _req, res, params) => {
    ctx.repo.getSnapshot(params.id!);
    send(res, 200, { reports: ctx.repo.listReports(params.id!) });
  }),

  route("POST", "/price", async (_ctx, req, res) => {
    const body = asRecord(await readJson(req));
    if ("cashDividend" in body || "discreteDividend" in body) {
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "Discrete cash dividends are not supported; only a continuous dividend yield is modeled.",
      );
    }
    const inputs = validatePricingInputs(body);
    const evaluation = evaluateTree(inputs);
    send(res, 200, { inputs, result: evaluation.result });
  }),
];

function paginated<T>(data: T[], total: number, limit: number, offset: number) {
  return {
    data,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + data.length < total,
    },
  };
}

export function createApp(db: DatabaseSync, clock: Clock): Server {
  const ctx: RouteContext = {
    db,
    clock,
    repo: new Repository(db, clock),
    pricing: new PricingService(db, clock),
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        for (const candidate of routes) {
          if (candidate.method !== req.method) continue;
          const match = candidate.pattern.exec(url.pathname);
          if (!match) continue;
          const params: Record<string, string> = {};
          candidate.paramNames.forEach((name, index) => {
            params[name] = decodeURIComponent(match[index + 1]!);
          });
          await candidate.handler(ctx, req, res, params, url.searchParams);
          return;
        }
        send(res, 404, errorBody("NOT_FOUND", `No route for ${req.method} ${url.pathname}`, null));
      } catch (error) {
        if (isAppError(error)) {
          const status =
            error.code === "NOT_FOUND"
              ? 404
              : error.code === "CONFLICT"
                ? 409
                : error.code === "INVALID_PAGINATION"
                  ? 400
                  : 400;
          send(res, status, errorBody(error.code, error.message, error.details));
          return;
        }
        const message = error instanceof Error ? error.message : "Unknown error";
        send(res, 500, errorBody("INTERNAL_ERROR", message, null));
      }
    })();
  });

  return server;
}

export function listenLocalhost(server: Server, port = 0): Promise<{ port: number }> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ port: address.port });
    });
  });
}
