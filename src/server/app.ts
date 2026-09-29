import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type { OptionService } from "../core/service.js";
import { ApiError, statusFor } from "../core/errors.js";
import { PricingError } from "../pricing/types.js";

interface Route {
  method: string;
  pattern: RegExp;
  handler: (ctx: HandlerCtx) => Promise<unknown> | unknown;
}

interface HandlerCtx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  body: unknown;
  query: URLSearchParams;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("VALIDATION_ERROR", "request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function pagination(q: URLSearchParams) {
  const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 50)));
  const offset = Math.max(0, Number(q.get("offset") ?? 0));
  if (!Number.isFinite(limit) || !Number.isFinite(offset))
    throw new ApiError("VALIDATION_ERROR", "limit/offset must be numbers");
  return { limit, offset };
}

export function buildApp(svc: OptionService, db: DatabaseSync) {
  const routes: Route[] = [
    {
      method: "POST",
      pattern: /^\/api\/contracts$/,
      handler: ({ body }) => svc.createContract(body as never),
    },
    {
      method: "GET",
      pattern: /^\/api\/contracts$/,
      handler: ({ query }) => {
        const { limit, offset } = pagination(query);
        return svc.listContracts(limit, offset);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/contracts\/(?<id>\d+)$/,
      handler: ({ params }) => svc.getContract(Number(params.id)),
    },
    {
      method: "POST",
      pattern: /^\/api\/contracts\/(?<id>\d+)\/snapshots$/,
      handler: ({ params, body }) =>
        svc.createSnapshot({ ...(body as object), contractId: Number(params.id) } as never),
    },
    {
      method: "GET",
      pattern: /^\/api\/snapshots$/,
      handler: ({ query }) => {
        const { limit, offset } = pagination(query);
        const cid = query.get("contractId");
        return svc.listSnapshots(cid ? Number(cid) : undefined, limit, offset);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/snapshots\/(?<id>\d+)$/,
      handler: ({ params }) => svc.getSnapshot(Number(params.id)),
    },
    {
      method: "POST",
      pattern: /^\/api\/valuations$/,
      handler: ({ body }) => svc.runValuation(body as never),
    },
    {
      method: "GET",
      pattern: /^\/api\/valuations$/,
      handler: ({ query }) => {
        const { limit, offset } = pagination(query);
        const cid = query.get("contractId");
        return svc.listValuations(cid ? Number(cid) : undefined, limit, offset);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/valuations\/(?<id>\d+)$/,
      handler: ({ params }) => svc.getValuation(Number(params.id)),
    },
    {
      method: "GET",
      pattern: /^\/api\/valuations\/(?<id>\d+)\/report$/,
      handler: ({ params }) => svc.getReport(Number(params.id)),
    },
    {
      method: "GET",
      pattern: /^\/api\/valuations\/(?<id>\d+)\/nodes\/(?<layer>\d+)\/(?<j>\d+)$/,
      handler: ({ params }) => svc.explainNode(Number(params.id), Number(params.layer), Number(params.j)),
    },
    {
      method: "POST",
      pattern: /^\/api\/convergence$/,
      handler: ({ body }) => {
        const b = body as {
          contractId: number;
          snapshotId: number;
          stepCounts: number[];
          valuationTime?: string;
        };
        if (!Array.isArray(b.stepCounts) || b.stepCounts.some((s) => !Number.isInteger(s) || s < 1))
          throw new ApiError("VALIDATION_ERROR", "stepCounts must be an array of integers >= 1");
        return svc.runConvergence(Number(b.contractId), Number(b.snapshotId), b.stepCounts.map(Number), b.valuationTime);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/sensitivity$/,
      handler: ({ body }) => {
        const b = body as {
          contractId: number;
          snapshotId: number;
          steps: number;
          parameter: string;
          bump: number;
          scheme?: "central" | "forward" | "backward";
          valuationTime?: string;
        };
        const allowed = ["spot", "strike", "volatility", "riskFreeRate", "dividendYield", "maturityYears"];
        if (!allowed.includes(b.parameter))
          throw new ApiError("VALIDATION_ERROR", `parameter must be one of ${allowed.join(",")}`);
        return svc.runSensitivity(
          Number(b.contractId),
          Number(b.snapshotId),
          Number(b.steps),
          { parameter: b.parameter as never, bump: Number(b.bump), scheme: b.scheme },
          b.valuationTime,
        );
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      handler: () => {
        db.prepare("SELECT 1").get();
        return { status: "ok" };
      },
    },
  ];

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = ["POST", "PUT", "PATCH"].includes(req.method ?? "") ? await readBody(req) : {};
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const data = await route.handler({
          req,
          res,
          params: (m.groups ?? {}) as Record<string, string>,
          body,
          query: url.searchParams,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such route" } }));
    } catch (err) {
      if (err instanceof PricingError) {
        const code =
          err.code === "INVALID_PROBABILITY"
            ? "INVALID_PROBABILITY"
            : err.code === "NODE_NOT_FOUND"
              ? "NOT_FOUND"
              : "PRICING_INVALID_INPUT";
        res.writeHead(statusFor(code), { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code, message: err.message } }));
        return;
      }
      if (err instanceof ApiError) {
        res.writeHead(statusFor(err.code), { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "INTERNAL", message: String((err as Error).message) } }));
    }
  });

  return server;
}
