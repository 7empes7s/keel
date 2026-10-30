import {
  getRestoreApprovalSettings,
  RESTORE_APPROVAL_SERVICES,
  setRestoreApprovalSetting,
} from "../../engine/govern/restoreApprovalSettings.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import { connect } from "@/lib/db";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import type { EngineRef } from "@/lib/sentences";

// Restore approvals as a customer setting. Per service, whether a high-impact restore
// change (shorter retention, a released hold, wider sharing, a destroying action, a
// script run on devices, a shorter group lifetime) waits for a second person. On for
// every service until someone with `policies` turns it off; each change is written to
// the audit record. Anyone who can read sees how it is set.

const NO_STORE = { "cache-control": "no-store" };

export interface RestoreApprovalSetting {
  service: string;
  approvalRequired: boolean;
  changedAt: string | null;
  changedBy: EngineRef | null;
}

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface EngineSetting {
  service: string;
  approvalRequired: boolean;
  updatedBy: string | null;
  updatedAt: Date | string | null;
}

async function settingsFrom(client: KeelClient, tenant: string): Promise<RestoreApprovalSetting[]> {
  const rows = (await getRestoreApprovalSettings(client, { tenantRef: tenant })) as EngineSetting[];
  const ids = rows.map((row) => row.updatedBy).filter((id): id is string => typeof id === "string");
  const people = ids.length ? ((await resolvePrincipals(client, ids)) as Map<string, EngineRef>) : new Map<string, EngineRef>();
  return rows.map((row) => ({
    service: row.service,
    approvalRequired: row.approvalRequired,
    changedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    changedBy: row.updatedBy ? people.get(row.updatedBy) ?? null : null,
  }));
}

/** The settings for a server-rendered page; null when they could not be read. */
export async function getRestoreApprovalSettingsView(): Promise<RestoreApprovalSetting[] | null> {
  try {
    const client = (await connect(databaseUrl())) as KeelClient;
    try {
      return await settingsFrom(client, tenantRef());
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error("[keel-portal] restore approval settings unavailable", error);
    return null;
  }
}

/** GET /api/restore-approvals: how each service is set, for anyone who can read. */
export function guardedRestoreApprovalsRead(deps: GuardDeps = {}) {
  return guarded({ action: "restore-approvals:read", capability: "read" }, async ({ client, tenantRef: tenant }) => {
    return Response.json(
      { settings: await settingsFrom(client as KeelClient, tenant), generatedAt: new Date().toISOString() },
      { headers: NO_STORE },
    );
  }, deps);
}

/** POST /api/restore-approvals { service, approvalRequired }: turn one service's approval on or off. */
export function guardedRestoreApprovalsUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "restore-approvals:update", capability: "policies", recordAttempt: true }, async ({ client, principalId, tenantRef: tenant, request }) => {
    const body = await readActionParams(request);
    const services = RESTORE_APPROVAL_SERVICES as readonly string[];
    if (typeof body.service !== "string" || !services.includes(body.service) || typeof body.approvalRequired !== "boolean") {
      throw new InvalidActionRequest();
    }
    const { changed } = (await setRestoreApprovalSetting(client, {
      tenantRef: tenant, service: body.service, approvalRequired: body.approvalRequired, actor: principalId,
    })) as { changed: boolean };
    return Response.json({ changed, settings: await settingsFrom(client as KeelClient, tenant) }, { headers: NO_STORE });
  }, deps);
}
