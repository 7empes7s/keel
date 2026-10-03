// Roadmap task-76: host composition for guided setup. The task-74 planner reads the
// tenant only through injected readers, and the task-75 executor changes it only
// through injected, separately qualified adapters. The repository ships neither, so by
// default this server can show the steps and the setup journal but can neither check
// nor change the tenant. A deployment that has qualified an implementation supplies it
// here; tests inject theirs through the route's deps. Credential pairs are server
// configuration (references only), never request input.

export type ReadAdapters = Record<string, () => Promise<unknown[]>>;

export interface ProvisioningAdapters {
  prerequisites(context: Record<string, unknown>): Promise<unknown>;
  qualify(context: Record<string, unknown>): Promise<unknown>;
  observe(context: Record<string, unknown>): Promise<unknown>;
  ensure(context: Record<string, unknown>): Promise<unknown>;
}

export interface CredentialReference {
  credentialRef: string;
  identityRef: string;
}

export interface SetupHost {
  readers: ReadAdapters | null;
  adapters: ProvisioningAdapters | null;
  credentials: { collector: CredentialReference; restorer: CredentialReference } | null;
  build: string | null;
  qualificationMode: "live-qualified" | "fixture-tested";
  // The onboarding operator's Entra object id, when the host can name it; without
  // it PIM prerequisites stay "waiting for you" and are never assumed.
  operatorPrincipalId: string | null;
}

export const NO_SETUP_HOST: SetupHost = Object.freeze({
  readers: null,
  adapters: null,
  credentials: null,
  build: null,
  qualificationMode: "live-qualified",
  operatorPrincipalId: null,
});

export function setupHost(): SetupHost {
  return NO_SETUP_HOST;
}

export function canCheck(host: SetupHost): boolean {
  return host.readers !== null;
}

export function canProvision(host: SetupHost): boolean {
  return host.readers !== null && host.adapters !== null && host.credentials !== null && host.build !== null;
}
