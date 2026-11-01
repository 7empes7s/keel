import { getApprovalMode, setApprovalMode } from "../../engine/govern/approvalMode.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import { connect } from "@/lib/db";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type { EngineRef } from "@/lib/sentences";

// Approval mode (engine/govern/approvalMode.mjs): who may approve a change.
// "two-person": a second person approves, never the one who asked. Keel's default.
// "solo": the person who asked may approve it themselves, for a business with one
// admin; each such approval is recorded as self-approved. Anyone who can read sees the
// mode; only someone with `policies` changes it, and switching to solo needs the risk
// warning confirmed. Every change is written to the audit record.

const NO_STORE = { "cache-control": "no-store" };

export type ApprovalMode = "two-person" | "solo";

export interface ApprovalModeView {
  mode: ApprovalMode;
  changedAt: string | null;
  changedBy: EngineRef | null;
}

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "two-person" || value === "solo";
}

export async function approvalModeFrom(client: KeelClient, tenant: string): Promise<ApprovalModeView> {
  const row = (await getApprovalMode(client, { tenantRef: tenant })) as { mode: ApprovalMode; updatedBy: string | null; updatedAt: Date | string | null };
  const people = row.updatedBy ? ((await resolvePrincipals(client, [row.updatedBy])) as Map<string, EngineRef>) : new Map<string, EngineRef>();
  return {
    mode: row.mode,
    changedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    changedBy: row.updatedBy ? people.get(row.updatedBy) ?? null : null,
  };
}

/** The mode for a server-rendered page; null when it could not be read. */
export async function getApprovalModeView(): Promise<ApprovalModeView | null> {
  try {
    const client = (await connect(databaseUrl())) as KeelClient;
    try {
      return await approvalModeFrom(client, tenantRef());
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error("[keel-portal] approval mode unavailable", error);
    return null;
  }
}

/** GET /api/approval-mode: the tenant's approval mode, for anyone who can read. */
export function guardedApprovalModeRead(deps: GuardDeps = {}) {
  return guarded({ action: "approval-mode:read", capability: "read" }, async ({ client, tenantRef: tenant }) => {
    return Response.json({ ...(await approvalModeFrom(client as KeelClient, tenant)), generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

/**
 * POST /api/approval-mode { mode, riskAcknowledged? }: set the approval mode. Needs
 * `policies`; switching to solo needs { riskAcknowledged: true }.
 */
export function guardedApprovalModeUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "approval-mode:update", capability: "policies", recordAttempt: true }, async ({ client, principalId, tenantRef: tenant, request }) => {
    const body = await readActionParams(request);
    if (!isApprovalMode(body.mode)) throw new InvalidActionRequest();
    const riskAcknowledged = body.riskAcknowledged === true;
    if (body.mode === "solo" && !riskAcknowledged) throw new InvalidActionRequest("confirm the risk warning to switch to solo approval");
    const { changed } = (await setApprovalMode(client, { tenantRef: tenant, mode: body.mode, actor: principalId, riskAcknowledged })) as { changed: boolean };
    return Response.json({ changed, ...(await approvalModeFrom(client as KeelClient, tenant)) }, { headers: NO_STORE });
  }, deps);
}
