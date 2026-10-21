import { existsSync, statSync } from "node:fs";
import { createPolicy, getPolicy, listPolicies, listPolicyActions, setPolicyEnabled, clearPolicyPause } from "../../engine/policy/evaluate.mjs";
import { AUTOMATION_KILL_SWITCH_PATH } from "../../engine/policy/execute.mjs";
import {
  ActivationNotFoundError, ActivationRefusedError, activatePolicy, createActivationPreview, summarizeAutomationOutcomes,
} from "../../engine/policy/activation.mjs";
import { guarded, readActionParams, InvalidActionRequest, type GuardDeps } from "@/lib/action";
import { payloadName } from "@/lib/changes-view";
import type { NamedKeys } from "@/lib/job-names";
import { savedNames } from "@/lib/saved-names";

import type { DataSurface } from "@/lib/read";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BLAST = ["cosmetic", "access-affecting", "tenant-lockout"];

export interface Policy {
  id: string;
  name: string;
  enabled: boolean;
  paused_at: string | null;
  run_as_repair_required: boolean;
  run_as_principal_id: string | null;
  // Roadmap task-130: resolved by the engine reader, never shown as the bare id.
  run_as_principal: { id: string; email: string | null; name: string | null; readable: boolean } | null;
  last_action_at: string | null;
  last_action_status: string | null;
  last_action_natural_key: string | null;
  /** The job that ran the last action, so the page can link to it. */
  last_action_job_id?: string | null;
  /** The saved name of what it last acted on, filled in by the reader; never an id. */
  last_action_name?: string | null;
  last_action_resource_type?: string | null;
  actions_last_7_days: number;
  resource_type: string | null;
  blast_radius: string | null;
  natural_key_glob: string | null;
  change_type: string | null;
  action: string;
  max_blast_radius: string;
  max_actions_per_window: number | null;
  window_seconds: number | null;
  created_by: string;
  created_at: string;
}

/** One automatic action of a rule: the job that ran it and the change it acted on. */
export interface PolicyAction {
  job_id: string;
  status: "queued" | "executed" | "failed" | string;
  queued_at: string;
  finished_at: string | null;
  error: string | null;
  drift_id: string | null;
  natural_key: string | null;
  resource_type: string | null;
  change_type: string | null;
  blast_radius: string | null;
  /** The saved name of the change, filled in by the reader; never an id. */
  name: string | null;
}

// Roadmap task-92: the frozen activation preview, as engine/policy/activation.mjs stores it.
export interface PreviewDrift { driftId: string; naturalKey: string; resourceType: string; changeType: string; blastRadius: string | null; detectedAt: string | null }
export interface ActivationPreview {
  id: string;
  requestedBy: string;
  createdAt: string;
  expiresAt: string;
  policy: { id: string; name: string; enabled: boolean; action: string };
  matched: PreviewDrift[];
  matchedOverCeiling: PreviewDrift[];
  operations: { naturalKey: string; resourceType: string; verb: string; blastRadius: string | null; role: "matched" | "dependency"; driftId?: string }[];
  dependencies: { naturalKey: string; resourceType: string; blastRadius: string | null; requiredBy: string[]; overCeiling: boolean }[];
  impact: { maxBlastRadius: string | null; ceiling: string };
  unsupported: { naturalKey: string; resourceType: string; operation: string; claim: string }[];
  unknowns: { reason: string; naturalKeys: string[]; driftIds?: string[]; detail: string }[];
  runAs: {
    principalId: string | null; email: string | null; name: string | null; readable: boolean; disabled: boolean; authorized: boolean;
    grants: { id: string; role: string; scope: string; activeFrom: string | null; activeUntil: string | null }[];
  };
  ownership: { state: string; resources: { evidenceId: string; naturalKey: string; state: string; entityCode: string | null; expiresAt: string | null }[] };
  benchmarkFindings: { state: "read" | "unavailable"; findings: { id: string; controlId: string; title: string | null; verdict: string; exposed: boolean; link: "linked" | "mismatch"; driftIds: string[] }[] };
  limits: { maxBlastRadius: string; maxActionsPerWindow: number | null; windowSeconds: number | null; automationHalted: boolean };
  blockers: string[];
  verdict: "ready" | "blocked";
  versions: { policy: string; grant: string; ownership: string; projection: string };
  digest: string;
  outcomes?: { queued: number; rolledBack: number; failed: number };
  /** Names, not ids: the saved name of every resource the preview lists, by key. */
  names?: NamedKeys;
}

type QueryClient = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };

/** Each policy with the saved name of what it last acted on. A failed lookup leaves it unnamed. */
async function withLastActionNames(client: QueryClient, tenantRef: string, policies: Policy[]): Promise<Policy[]> {
  const keys = policies.map((policy) => policy.last_action_natural_key).filter((key): key is string => Boolean(key));
  if (keys.length === 0) return policies;
  let names: NamedKeys = {};
  try {
    names = await savedNames(client, tenantRef, keys);
  } catch (error) {
    console.error("[keel-portal] policy names unavailable", error);
  }
  return policies.map((policy) => {
    const saved = policy.last_action_natural_key ? names[policy.last_action_natural_key] : undefined;
    return { ...policy, last_action_name: saved?.name ?? null, last_action_resource_type: saved?.resourceType ?? null };
  });
}

/** A rule's newest actions, each named: the change's own name first, then the newest backup's. */
async function namedActions(client: QueryClient, tenantRef: string, policyId: string): Promise<PolicyAction[]> {
  const rows = await listPolicyActions(client, { tenantRef, policyId, limit: 20 }) as (Omit<PolicyAction, "name"> & { display_name: string | null })[];
  let names: NamedKeys = {};
  try {
    names = await savedNames(client, tenantRef, rows.map((row) => row.natural_key).filter((key): key is string => Boolean(key)));
  } catch (error) {
    console.error("[keel-portal] policy action names unavailable", error);
  }
  return rows.map(({ display_name, ...row }) => ({
    ...row,
    queued_at: toIso(row.queued_at), finished_at: row.finished_at ? toIso(row.finished_at) : null,
    name: payloadName({ displayName: display_name }) ?? (row.natural_key ? names[row.natural_key]?.name ?? null : null),
  }));
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** The name of every resource a preview lists: the changes' own names first, then the newest backup's. */
export async function previewNames(client: QueryClient, tenantRef: string, preview: ActivationPreview): Promise<NamedKeys> {
  const keys = [
    ...preview.matched.map((drift) => drift.naturalKey), ...preview.matchedOverCeiling.map((drift) => drift.naturalKey),
    ...preview.dependencies.flatMap((dependency) => [dependency.naturalKey, ...dependency.requiredBy]),
    ...preview.unsupported.map((entry) => entry.naturalKey), ...preview.unknowns.flatMap((unknown) => unknown.naturalKeys),
  ];
  let names: NamedKeys = {};
  try {
    names = await savedNames(client, tenantRef, keys);
    const driftIds = [...preview.matched, ...preview.matchedOverCeiling].map((drift) => drift.driftId);
    if (driftIds.length) {
      const { rows } = await client.query(
        "SELECT natural_key, resource_type, after_payload, before_payload FROM drift WHERE tenant_ref = $1 AND id::text = ANY($2::text[])",
        [tenantRef, driftIds],
      );
      for (const row of rows) {
        const name = payloadName(row.after_payload) ?? payloadName(row.before_payload);
        if (name) names[String(row.natural_key)] = { name, resourceType: String(row.resource_type) };
      }
    }
  } catch (error) {
    console.error("[keel-portal] preview names unavailable", error);
  }
  return names;
}

export function automationDisabled(path = AUTOMATION_KILL_SWITCH_PATH): boolean {
  return existsSync(path);
}

/** When automation was halted: the halt file's modification time, or null. */
export function automationHaltedAt(path = AUTOMATION_KILL_SWITCH_PATH): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

export const AUTOMATION_HALT_FILE = AUTOMATION_KILL_SWITCH_PATH;

export function guardedPolicyList(deps: GuardDeps = {}) {
  return guarded({ action: "policies:list", capability: "policies" }, async ({ client, tenantRef, request }) => {
    const filter = new URL(request.url).searchParams.get("enabled");
    if (filter !== null && filter !== "true" && filter !== "false") throw new InvalidActionRequest();
    const listed = await listPolicies(client, { tenantRef, enabled: filter === null ? undefined : filter === "true" }) as Policy[];
    const policies = await withLastActionNames(client as QueryClient, tenantRef, listed);
    return Response.json({
      policies, automationDisabled: automationDisabled(), automationHaltedAt: automationHaltedAt(),
      haltFile: AUTOMATION_KILL_SWITCH_PATH, generatedAt: new Date().toISOString(),
    }, { headers: NO_STORE });
  }, deps);
}

export function guardedPolicyShow(deps: GuardDeps = {}) {
  return guarded({ action: "policies:show", capability: "policies" }, async ({ client, tenantRef, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-1) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const found = await getPolicy(client, { tenantRef, id }) as Policy | null;
    const policy = found ? (await withLastActionNames(client as QueryClient, tenantRef, [found]))[0] : null;
    // The rule's newest 20 actions, for the detail page's "Recent actions"; a failed read leaves the list empty.
    let actions: PolicyAction[] = [];
    if (policy) {
      try {
        actions = await namedActions(client as QueryClient, tenantRef, policy.id);
      } catch (error) {
        console.error("[keel-portal] policy actions unavailable", error);
      }
    }
    return Response.json(policy ? { policy, actions, automationDisabled: automationDisabled(), generatedAt: new Date().toISOString() } : { error: "not_found" }, { status: policy ? 200 : 404, headers: NO_STORE });
  }, deps);
}

export function guardedPolicyCreate(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "policies:create", capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const body = await readActionParams(request);
    if (typeof body.name !== "string" || !body.name.trim()
      || !["alert", "require_approval", "auto_remediate"].includes(String(body.action))
      || !BLAST.includes(String(body.maxBlastRadius))
      || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new InvalidActionRequest();
    for (const key of ["resourceType", "naturalKeyGlob", "changeType", "blastRadius", "runAsPrincipalId"]) {
      if (body[key] != null && typeof body[key] !== "string") throw new InvalidActionRequest();
    }
    if (body.blastRadius != null && !BLAST.includes(String(body.blastRadius))) throw new InvalidActionRequest();
    for (const key of ["maxActionsPerWindow", "windowSeconds"]) {
      if (body[key] != null && (!Number.isSafeInteger(body[key]) || Number(body[key]) <= 0)) throw new InvalidActionRequest();
    }
    if ((body.maxActionsPerWindow == null) !== (body.windowSeconds == null)) throw new InvalidActionRequest();
    // Roadmap task-92: an automatic roll-back policy is created off and turned on only
    // from a current activation preview (POST …/activation-preview, then …/activate).
    const automatic = body.action === "auto_remediate";
    if (automatic && body.enabled === true) {
      return Response.json({ error: "activation_preview_required" }, { status: 409, headers: NO_STORE });
    }
    try {
      const policy = await createPolicy(client, {
        tenantRef, createdBy: principalId, name: body.name, enabled: automatic ? false : body.enabled ?? true,
        resourceType: body.resourceType, blastRadius: body.blastRadius, naturalKeyGlob: body.naturalKeyGlob,
        changeType: body.changeType, action: body.action, maxBlastRadius: body.maxBlastRadius,
        maxActionsPerWindow: body.maxActionsPerWindow, windowSeconds: body.windowSeconds,
        runAsPrincipalId: body.runAsPrincipalId,
      });
      return Response.json({ policy }, { status: 201, headers: NO_STORE });
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    }
  }, deps);
}

export function guardedPolicyUpdate(operation: "enabled" | "clear-pause", surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: `policies:${operation}`, capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const { rows } = await client.query("SELECT id, action FROM policy WHERE id = $1 AND tenant_ref = $2", [id, tenantRef]);
    if (!rows[0]) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const body = await readActionParams(request);
    if (operation === "enabled" && typeof body.enabled !== "boolean") throw new InvalidActionRequest();
    // Roadmap task-92: turning on automatic roll back goes through the activation preview.
    if (operation === "enabled" && body.enabled === true && rows[0].action === "auto_remediate") {
      return Response.json({ error: "activation_preview_required" }, { status: 409, headers: NO_STORE });
    }
    try {
      const policy = operation === "enabled"
        ? await setPolicyEnabled(client, { policyId: id, enabled: body.enabled })
        : await clearPolicyPause(client, { policyId: id });
      return Response.json({ policy }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "conflict" }, { status: 409, headers: NO_STORE });
    }
  }, deps);
}

/** Roadmap task-92: compute and freeze what turning an automatic policy on would do. */
export function guardedPolicyActivationPreview(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "policies:activation-preview", capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    try {
      const preview = await createActivationPreview(client, { tenantRef, policyId: id, requestedBy: principalId });
      const outcomes = await summarizeAutomationOutcomes(client, { tenantRef, policyId: id });
      const names = await previewNames(client as QueryClient, tenantRef, preview as ActivationPreview);
      return Response.json({ preview: { ...preview, outcomes: { queued: outcomes.queued, rolledBack: outcomes.rolledBack, failed: outcomes.failed }, names } }, { status: 201, headers: NO_STORE });
    } catch (error) {
      if (error instanceof ActivationNotFoundError) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
      throw error;
    }
  }, deps);
}

/** Roadmap task-92: turn an automatic policy on from a current, unused preview. */
export function guardedPolicyActivate(surface: DataSurface, deps: GuardDeps = {}) {
  return guarded({ action: "policies:activate", capability: surface.capability, recordAttempt: true }, async ({ client, tenantRef, principalId, request }) => {
    const id = new URL(request.url).pathname.split("/").at(-2) ?? "";
    if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
    const body = await readActionParams(request);
    if (typeof body.previewId !== "string" || !UUID.test(body.previewId)) throw new InvalidActionRequest();
    try {
      const { policy, activation } = await activatePolicy(client, { tenantRef, policyId: id, previewId: body.previewId, activatedBy: principalId });
      return Response.json({ policy, activation }, { headers: NO_STORE });
    } catch (error) {
      if (error instanceof ActivationRefusedError) {
        return Response.json({ error: error.code, changed: error.changed }, { status: 409, headers: NO_STORE });
      }
      if (error instanceof ActivationNotFoundError) return Response.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
      throw error;
    }
  }, deps);
}
