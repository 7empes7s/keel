import {
  getScubaConfigLists,
  ROLE_EXCLUSION_RULES,
  SCUBA_LIST_NAMES,
  SCUBA_LISTS,
  ScubaConfigListError,
  setScubaConfigList,
  SIGN_IN_EXCLUSION_RULES,
} from "../../engine/benchmarks/scubagear/config.mjs";
import { SCUBA_CONTROL_PREFIX } from "../../engine/benchmarks/scubagear/controls.mjs";
import { controlFor } from "../../engine/benchmarks/registry.mjs";
import { runComplianceChecks } from "../../engine/benchmarks/runChecks.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { guarded, readActionParams, type GuardDeps } from "@/lib/action";
import { connect } from "@/lib/db";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type { EngineRef } from "@/lib/sentences";
import type { ScubaListName, ScubaListsView } from "@/lib/types";

// ScubaGear's config lists, per tenant (engine/benchmarks/scubagear/config.mjs): the
// sensitive users and partner domains two CISA rules need, and the emergency accounts
// registered under Emergency access, which the sign-in and admin role rules leave out.
// Anyone who can read sees them; changing a list needs `configuration`. Saving writes
// only Keel's own database, then checks the list's rule again on the newest backup.

const NO_STORE = { "cache-control": "no-store" };

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface EngineLists {
  lists: { list: ScubaListName; policyId: string; entries: string[]; updatedBy: string | null; updatedAt: Date | string | null }[];
  emergencyAccounts: { accountId: string; label: string }[];
}

export function isScubaListName(value: unknown): value is ScubaListName {
  return typeof value === "string" && (SCUBA_LIST_NAMES as readonly string[]).includes(value);
}

async function viewFrom(client: KeelClient, tenant: string): Promise<ScubaListsView> {
  const engine = (await getScubaConfigLists(client, { tenantRef: tenant })) as EngineLists;
  const ids = engine.lists.map((row) => row.updatedBy).filter((id): id is string => typeof id === "string");
  const people = ids.length ? ((await resolvePrincipals(client, [...new Set(ids)])) as Map<string, EngineRef>) : new Map<string, EngineRef>();
  return {
    lists: engine.lists.map((row) => ({
      list: row.list,
      policyId: row.policyId,
      entries: row.entries,
      changedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
      changedBy: row.updatedBy ? people.get(row.updatedBy) ?? null : null,
    })),
    emergencyAccounts: engine.emergencyAccounts,
    signInRules: [...SIGN_IN_EXCLUSION_RULES],
    roleRules: [...ROLE_EXCLUSION_RULES],
  };
}

/** The lists for a server-rendered page; null when they could not be read. */
export async function getScubaListsView(): Promise<ScubaListsView | null> {
  try {
    const client = (await connect(databaseUrl())) as KeelClient;
    try {
      return await viewFrom(client, tenantRef());
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error("[keel-portal] ScubaGear lists unavailable", error);
    return null;
  }
}

/**
 * POST /api/actions/compliance/scuba-lists { list, entries }: replace one list. An empty
 * list unsets it, and its rule reads "could not check" again. Answers the saved list
 * and the rule's result on the newest backup (null when it could not run yet).
 */
export function guardedScubaListUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "compliance:scuba-list", capability: "configuration", recordAttempt: true }, async ({ client, principalId, tenantRef: tenant, request }) => {
    const { list, entries } = await readActionParams(request);
    if (!isScubaListName(list) || !Array.isArray(entries)) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    let changed: boolean;
    try {
      ({ changed } = (await setScubaConfigList(client, { tenantRef: tenant, list, entries, actor: principalId })) as { changed: boolean });
    } catch (error) {
      if (error instanceof ScubaConfigListError) return Response.json({ error: "invalid_request", detail: error.message }, { status: 400, headers: NO_STORE });
      if (error instanceof Error && error.message.startsWith("forbidden")) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      throw error;
    }
    // The list is saved: a failure of the check that follows must not read as "not saved".
    let verdict: string | null = null;
    let reason: string | null = null;
    const control = changed ? controlFor(`${SCUBA_CONTROL_PREFIX}${SCUBA_LISTS[list].policyId}`) : null;
    if (control) {
      try {
        const checks = (await runComplianceChecks(client, { tenantRef: tenant, actor: principalId, controls: [control] })) as {
          evaluations: { verdict: string; reason: string | null }[];
        };
        verdict = checks.evaluations[0]?.verdict ?? null;
        reason = checks.evaluations[0]?.reason ?? null;
      } catch {
        verdict = null;
      }
    }
    // The list is saved whatever happens next: a failed read-back answers without it.
    const saved = await viewFrom(client as KeelClient, tenant).then((view) => view.lists.find((entry) => entry.list === list) ?? null).catch(() => null);
    return Response.json({ changed, list: saved, verdict, reason }, { status: 200, headers: NO_STORE });
  }, deps);
}
