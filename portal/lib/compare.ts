// Wave 2 CMP: the Compare page's loader. Read-only: it lists completed snapshots and
// asks engine/govern/compare.mjs to compare two of them. Callers check `read` first.
import { CompareError, compareSnapshots, listCompareSources } from "../../engine/govern/compare.mjs";
import { connect } from "../../engine/store/db.mjs";

import {
  defaultInput, labelTenants, type CompareData, type CompareInput, type CompareProblem, type CompareResult, type CompareSnapshotOption,
} from "@/lib/compare-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export async function getCompareData(input: CompareInput | null, now: Date = new Date()): Promise<CompareData> {
  const own = tenantRef();
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const sources = (await listCompareSources(client)) as { tenantRef: string; snapshots: CompareSnapshotOption[] }[];
    const tenants = labelTenants(sources, own);
    const chosen = input ?? defaultInput(tenants);
    const base = { generatedAt: now.toISOString(), tenants, input: chosen };
    if (!chosen) return { ...base, result: null, problem: "too-few-snapshots" };
    if (chosen.from === chosen.to) return { ...base, result: null, problem: "same-snapshot" };
    try {
      const result = (await compareSnapshots(client, { leftSnapshotId: chosen.from, rightSnapshotId: chosen.to, now })) as CompareResult;
      return { ...base, result, problem: null };
    } catch (error) {
      if (error instanceof CompareError && (error.code === "snapshot-not-found" || error.code === "snapshot-incomplete")) {
        return { ...base, result: null, problem: error.code as CompareProblem };
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}
