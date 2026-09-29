import type { OptionService } from "../core/service.js";
import { FIXED_NOW, FIXTURE_CONTRACTS, FIXTURE_SNAPSHOTS } from "./contracts.js";

export interface SeedResult {
  contracts: Record<string, { id: number }>;
  snapshots: { contractCode: string; label: string; id: number }[];
}

/** Idempotently load the fictitious fixtures (stable idempotency keys). */
export function seedFixtures(svc: OptionService): SeedResult {
  const contracts: Record<string, { id: number }> = {};
  for (const c of FIXTURE_CONTRACTS) {
    const row = svc.createContract({
      idempotencyKey: `seed-contract-${c.code}`,
      code: c.code,
      optionType: c.optionType,
      style: c.style,
      strike: c.strike,
      maturityDate: c.maturityDate,
      annualVolatility: c.annualVolatility,
      continuousDividendYield: c.continuousDividendYield,
    }) as { id: number };
    contracts[c.code] = { id: row.id };
  }
  const snapshots: SeedResult["snapshots"] = [];
  FIXTURE_SNAPSHOTS.forEach((s, idx) => {
    const row = svc.createSnapshot({
      idempotencyKey: `seed-snapshot-${idx}`,
      contractId: contracts[s.contractCode]!.id,
      label: s.label,
      spot: s.spot,
      riskFreeRate: s.riskFreeRate,
      capturedAt: FIXED_NOW,
    }) as { id: number };
    snapshots.push({ contractCode: s.contractCode, label: s.label, id: row.id });
  });
  return { contracts, snapshots };
}
