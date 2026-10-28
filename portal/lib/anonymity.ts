import { readAnonymity, setAnonymity } from "../../engine/insights/anonymity.mjs";
import { resolvePrincipals } from "../../engine/govern/references.mjs";
import { guarded, InvalidActionRequest, readActionParams, type GuardDeps } from "@/lib/action";
import { connect } from "@/lib/db";
import { databaseUrl } from "@/lib/runtime-config";
import type { EngineRef } from "@/lib/sentences";

// "Hide people's names" (redesign Track A3, IN-ANON). When on, every person Keel names
// shows by a stable code name ("Person K7Q2"); the engine decides each label
// (engine/insights/people.mjs displayPerson). Everyone can see whether it is on; only an
// admin (the `users` capability) turns it on or off, and each change is written to the
// audit record.

const NO_STORE = { "cache-control": "no-store" };

export interface AnonymitySetting {
  enabled: boolean;
  changedAt: string | null;
  // Who last changed it, named the way the setting says (a code name while it is on).
  changedBy: EngineRef | null;
}

export const ANONYMITY_OFF: AnonymitySetting = Object.freeze({ enabled: false, changedAt: null, changedBy: null }) as AnonymitySetting;

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

async function settingFrom(client: KeelClient): Promise<AnonymitySetting> {
  const state = (await readAnonymity(client)) as { enabled: boolean; changedAt: Date | string | null; changedBy: string | null };
  const changedBy = state.changedBy ? ((await resolvePrincipals(client, [state.changedBy])) as Map<string, EngineRef>).get(state.changedBy) ?? null : null;
  return {
    enabled: state.enabled,
    changedAt: state.changedAt ? new Date(state.changedAt).toISOString() : null,
    changedBy,
  };
}

/** The setting for a server-rendered page; null when it could not be read. */
export async function getAnonymitySetting(): Promise<AnonymitySetting | null> {
  try {
    const client = (await connect(databaseUrl())) as KeelClient;
    try {
      return await settingFrom(client);
    } finally {
      await client.end();
    }
  } catch (error) {
    console.error("[keel-portal] people name setting unavailable", error);
    return null;
  }
}

/** GET /api/anonymity: whether names are hidden, for anyone who can read. */
export function guardedAnonymityRead(deps: GuardDeps = {}) {
  return guarded({ action: "anonymity:read", capability: "read" }, async ({ client }) => {
    return Response.json({ setting: await settingFrom(client as KeelClient), generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

/** POST /api/anonymity { enabled }: an admin turns "Hide people's names" on or off. */
export function guardedAnonymityUpdate(deps: GuardDeps = {}) {
  return guarded({ action: "anonymity:update", capability: "users", recordAttempt: true }, async ({ client, principalId, tenantRef, request }) => {
    const body = await readActionParams(request);
    if (typeof body.enabled !== "boolean") throw new InvalidActionRequest();
    const { changed } = (await setAnonymity(client, { tenantRef, enabled: body.enabled, actor: principalId })) as { changed: boolean };
    return Response.json({ changed, setting: await settingFrom(client as KeelClient) }, { headers: NO_STORE });
  }, deps);
}
