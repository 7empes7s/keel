import { loadConnections, syncConnections } from "../../engine/bootstrap/connections.mjs";
import { loadSetupState } from "../../engine/bootstrap/onboarding.mjs";
import { guarded, type GuardDeps } from "@/lib/action";
import { canCheck, canProvision, setupHost, type SetupHost } from "@/lib/setup-host";
import { confirmedRoles } from "@/lib/setup-view";

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
    const load = (readers: SetupHost["readers"]) => loadSetupState(client, {
      tenantRef,
      viewerId: principalId,
      readers,
      operatorPrincipalId: host.operatorPrincipalId,
      // The app ids the host signs in as, so steps can link to the app before it is observed.
      appIds: host.credentials ? { collector: host.credentials.collector.identityRef, restorer: host.credentials.restorer.identityRef } : null,
    } as unknown as Parameters<typeof loadSetupState>[1]);
    let state: Awaited<ReturnType<typeof load>>;
    let checkFailed = false;
    try {
      state = await load(host.readers);
    } catch (error) {
      if (host.readers === null) throw error;
      // The tenant could not be read just now: show every step as not checked
      // rather than guessing. Only the message is logged; it carries no token.
      console.error(error instanceof Error ? error.message : "setup: tenant check failed");
      state = await load(null);
      checkFailed = true;
    }
    // Connections: record each Keel app's state from the same tenant read. A failure here
    // never hides the setup steps; the page shows connections as unavailable instead.
    let connections: Awaited<ReturnType<typeof loadConnections>> | null = null;
    try {
      // A host without credential files knows no app, so it records nothing and only shows what was recorded.
      if (host.apps) await syncConnections(client, {
        tenantRef,
        apps: host.apps ?? {},
        readers: checkFailed ? null : host.readers,
        // The Intune roles Setup shows as done, so an app whose roles Keel cannot read
        // directly agrees with the step list instead of saying "Not checked".
        confirmedRoles: confirmedRoles(state),
      } as unknown as Parameters<typeof syncConnections>[1]);
      connections = await loadConnections(client, { tenantRef });
    } catch (error) {
      console.error(error instanceof Error ? error.message : "setup: connections could not be recorded");
    }
    return Response.json(
      // The page's "now" is when this answer was put together, after the connection check
      // above: that check records its own time, so the setup state's earlier time would
      // make every app read "last checked in the future".
      { ...state, generatedAt: new Date().toISOString(), connections, tenantId: host.tenantId ?? null, canCheck: canCheck(host), canProvision: canProvision(host), checkFailed },
      { headers: NO_STORE },
    );
  }, deps);
}


