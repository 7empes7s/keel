import {
  getRestoreApprovalRules,
  getRestoreApprovalSettings,
  RESTORE_APPROVAL_SERVICES,
  setRestoreApprovalRule,
  setRestoreApprovalSetting,
} from "../../engine/govern/restoreApprovalSettings.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import { connect } from "@/lib/db";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { isRestoreApprovalRule, type RestoreApprovalRule } from "@/lib/restore-approval-rules";
import type { EngineRef } from "@/lib/sentences";

// Restore approvals as a customer setting. Per service, whether a high-impact restore
// change (shorter retention, a released hold, wider sharing, a destroying action, a
// script run on devices, a shorter group lifetime) waits for a second person. On for
// every service until someone with `policies` turns it off; each change is written to
// the audit record. Anyone who can read sees how it is set. Some kinds of restore
// (content restores, turning a Conditional Access policy on, compliance fixes,
// organization-wide changes, restores into another tenant, items Keel cannot place)
// have their own setting on top, on until turned off the same way.

const NO_STORE = { "cache-control": "no-store" };

export interface RestoreApprovalSetting {
  service: string;
  approvalRequired: boolean;
  changedAt: string | null;
  changedBy: EngineRef | null;
}

export interface RestoreApprovalRuleSetting {
  rule: RestoreApprovalRule;
  approvalRequired: boolean;
  changedAt: string | null;
  changedBy: EngineRef | null;
}

export interface RestoreApprovalsView {
  services: RestoreApprovalSetting[];
  rules: RestoreApprovalRuleSetting[];
}

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface EngineSetting {
  approvalRequired: boolean;
  updatedBy: string | null;
  updatedAt: Date | string | null;
}

async function settingsFrom(client: KeelClient, tenant: string): Promise<RestoreApprovalsView> {
  const services = (await getRestoreApprovalSettings(client, { tenantRef: tenant })) as (EngineSetting & { service: string })[];
  const rules = (await getRestoreApprovalRules(client, { tenantRef: tenant })) as (EngineSetting & { rule: RestoreApprovalRule })[];
  const ids = [...services, ...rules].map((row) => row.updatedBy).filter((id): id is string => typeof id === "string");
  const people = ids.length ? ((await resolvePrincipals(client, [...new Set(ids)])) as Map<string, EngineRef>) : new Map<string, EngineRef>();
  const changed = (row: EngineSetting) => ({
    approvalRequired: row.approvalRequired,
    changedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
    changedBy: row.updatedBy ? people.get(row.updatedBy) ?? null : null,
  });
  return {
    services: services.map((row) => ({ service: row.service, ...changed(row) })),
    rules: rules.map((row) => ({ rule: row.rule, ...changed(row) })),
  };
}

/** The settings for a server-rendered page; null when they could not be read. */
export async function getRestoreApprovalSettingsView(): Promise<RestoreApprovalsView | null> {
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

/** GET /api/restore-approvals: how each service and kind of restore is set, for anyone who can read. */
export function guardedRestoreApprovalsRead(deps: GuardDeps = {}) {
  return guarded({ action: "restore-approvals:read", capability: "read" }, async ({ client, tenantRef: tenant }) => {
    const view = await settingsFrom(client as KeelClient, tenant);
    return Response.json(
      { settings: view.services, rules: view.rules, generatedAt: new Date().toISOString() },
      { headers: NO_STORE },
    );
  }, deps);
}

/**
 * POST /api/restore-approvals { service, approvalRequired } or { rule, approvalRequired }:
 * turn one service's or one kind of restore's approval on or off. One person with
 * `policies` decides; a two-person rule set up for restores still applies to them.
 */
export function guardedRestoreApprovalsUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "restore-approvals:update", capability: "policies", recordAttempt: true }, async ({ client, principalId, tenantRef: tenant, request }) => {
    const body = await readActionParams(request);
    const services = RESTORE_APPROVAL_SERVICES as readonly string[];
    if (typeof body.approvalRequired !== "boolean") throw new InvalidActionRequest();
    let changed: boolean;
    if (body.rule !== undefined && body.service === undefined && isRestoreApprovalRule(body.rule)) {
      ({ changed } = (await setRestoreApprovalRule(client, {
        tenantRef: tenant, rule: body.rule, approvalRequired: body.approvalRequired, actor: principalId,
      })) as { changed: boolean });
    } else if (body.service !== undefined && body.rule === undefined && typeof body.service === "string" && services.includes(body.service)) {
      ({ changed } = (await setRestoreApprovalSetting(client, {
        tenantRef: tenant, service: body.service, approvalRequired: body.approvalRequired, actor: principalId,
      })) as { changed: boolean });
    } else {
      throw new InvalidActionRequest();
    }
    const view = await settingsFrom(client as KeelClient, tenant);
    return Response.json({ changed, settings: view.services, rules: view.rules }, { headers: NO_STORE });
  }, deps);
}
