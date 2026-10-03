import { loadSetupState } from "../../engine/bootstrap/onboarding.mjs";
import { guarded, type GuardDeps } from "@/lib/action";
import { canCheck, canProvision, setupHost, type SetupHost } from "@/lib/setup-host";

// Roadmap task-76: what the setup page reads. Progress comes from the task-75 journal
// (or, before any run, from the host's readers); nothing here can mark a step done.
// The page's types and words are in lib/setup-view.ts.

const NO_STORE = { "cache-control": "no-store" };

export interface SetupReadDeps extends GuardDeps {
  host?: () => SetupHost;
}

export function guardedSetupState(deps: SetupReadDeps = {}) {
  const resolveHost = deps.host ?? setupHost;
  return guarded({ action: "setup:show", capability: "configuration" }, async ({ client, principalId, tenantRef }) => {
    const host = resolveHost();
    const state = await loadSetupState(client, {
      tenantRef,
      viewerId: principalId,
      readers: host.readers,
      operatorPrincipalId: host.operatorPrincipalId,
    } as unknown as Parameters<typeof loadSetupState>[1]);
    return Response.json({ ...state, canCheck: canCheck(host), canProvision: canProvision(host) }, { headers: NO_STORE });
  }, deps);
}

