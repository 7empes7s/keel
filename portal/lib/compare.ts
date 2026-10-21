// Wave 2 CMP: the Compare page's loader. Read-only: it lists completed snapshots and
// asks engine/govern/compare.mjs to compare two of them. Callers check `read` first.
import { CompareError, compareSnapshots, listCompareSources } from "../../engine/govern/compare.mjs";
import { connect } from "@/lib/db";

import {
  defaultInput, labelTenants, type CompareData, type CompareInput, type CompareProblem, type CompareResult, type CompareSnapshotOption,
} from "@/lib/compare-view";
import { DERIVED_NAME_TYPES } from "@/lib/app-names";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import { idNames } from "@/lib/value-names";

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
      return { ...base, result: await withValueNames(client, await withAppNames(client, result)), problem: null };
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

// App settings that carry no name (app consent, provisioning jobs) are named from the
// apps they point to, as each side's newest backup names them. A failed read leaves
// them unnamed, never the page down.
async function withAppNames(client: KeelClient, result: CompareResult): Promise<CompareResult> {
  const groups = result.settings?.groups ?? [];
  const derivable = (group: { resourceType: string }) => (DERIVED_NAME_TYPES as readonly string[]).includes(group.resourceType);
  const keys = groups.filter(derivable).flatMap((group) => group.items.filter((item) => !item.name).map((item) => item.naturalKey));
  if (!keys.length || !result.settings) return result;
  const names: Record<string, string> = {};
  for (const tenant of new Set([result.right.tenantRef, result.left.tenantRef])) {
    const missing = keys.filter((key) => !names[key]);
    if (!missing.length) break;
    try {
      const saved = await savedNames(client, tenant, missing);
      for (const key of missing) {
        const name = saved[key]?.name;
        if (name) names[key] = name;
      }
    } catch (error) {
      console.error("[keel-portal] compare app names unavailable", error);
    }
  }
  return {
    ...result,
    settings: {
      ...result.settings,
      groups: groups.map((group) => derivable(group)
        ? { ...group, items: group.items.map((item) => (!item.name && names[item.naturalKey] ? { ...item, name: names[item.naturalKey] } : item)) }
        : group),
    },
  };
}

// Ids inside the values ("excluded groups: <id>") read as the names the two backups
// hold for them.
async function withValueNames(client: KeelClient, result: CompareResult): Promise<CompareResult> {
  const values = [
    ...(result.settings?.groups ?? []).flatMap((group) => group.items.flatMap((item) => (item.fields ?? []).flatMap((field) => [field.before, field.after]))),
    ...(result.workloads?.groups ?? []).flatMap((group) => (group.items ?? []).flatMap((item) => (item.fields ?? []).flatMap((field) => [field.before, field.after]))),
  ];
  const names = await idNames(client, [result.left.snapshotId, result.right.snapshotId], values);
  return Object.keys(names).length ? { ...result, names } : result;
}
