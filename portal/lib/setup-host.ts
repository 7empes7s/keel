// Roadmap task-76: host composition for guided setup. The task-74 planner reads the
// tenant only through injected readers, and the task-75 executor changes it only
// through injected adapters. setupHost() builds them from the deployment's existing
// credential files (the same Collector and Restorer files restores use, see
// lib/restore-config.ts) with engine/bootstrap/graphHost.mjs: read-only Graph readers
// on the Collector credential, and write operations that stay disabled unless the
// optional setup config enables each one by name. Without both credential files the
// server can show the steps but can neither check nor change the tenant. Credential
// pairs are server configuration (references only), never request input; tests inject
// their own host through the route's deps.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { createGraphSetupHost } from "../../engine/bootstrap/graphHost.mjs";
import { tenantRefFor } from "../../engine/store/tenantRef.mjs";
import { restoreCredentialPaths } from "@/lib/restore-config";

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

const DEFAULT_SETUP_CONFIG_PATH = "/etc/keel/setup.json";
const DEFAULT_TENANT_CONFIG_PATH = "/etc/keel/tenant.json";

interface SetupConfig {
  operatorPrincipalId?: string | null;
  build?: string;
  qualificationMode?: "live-qualified" | "fixture-tested";
  operations?: Record<string, unknown>;
}

const readJson = (path: string) => JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8"));

let gitBuild: string | null | undefined;
function deployedRevision(): string | null {
  if (gitBuild === undefined) {
    try {
      gitBuild = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      gitBuild = null;
    }
  }
  return gitBuild;
}

/**
 * The deployment's setup host, or null when this server has no Collector and Restorer
 * credential files. A present but invalid configuration throws.
 */
export function composeSetupHost(
  env: NodeJS.ProcessEnv = process.env,
  // Tests only: an injected token source and kill-switch path.
  overrides: { getToken?: unknown; killSwitchPath?: string } = {},
): SetupHost | null {
  const paths = restoreCredentialPaths(env);
  if (!existsSync(paths.collectorConfig) || !existsSync(paths.targetConfig)) return null;
  const setupPath = env.KEEL_SETUP_CONFIG_PATH || DEFAULT_SETUP_CONFIG_PATH;
  const setup: SetupConfig = existsSync(setupPath) ? readJson(setupPath) : {};
  const tenant = readJson(env.KEEL_TENANT_CONFIG_PATH ?? DEFAULT_TENANT_CONFIG_PATH) as { tenantId?: string };
  const build = setup.build ?? env.KEEL_BUILD ?? deployedRevision();
  if (!build) throw new Error("setup host: no build identifier (set build in the setup config or KEEL_BUILD)");
  return createGraphSetupHost({
    tenantRef: tenantRefFor(tenant.tenantId),
    tenantId: tenant.tenantId,
    collector: { config: readJson(paths.collectorConfig), credentialRef: `file:${paths.collectorConfig}` },
    restorer: { config: readJson(paths.targetConfig), credentialRef: `file:${paths.targetConfig}` },
    operatorPrincipalId: setup.operatorPrincipalId ?? env.KEEL_SETUP_OPERATOR_ID ?? null,
    build,
    qualificationMode: setup.qualificationMode ?? "live-qualified",
    operations: setup.operations ?? {},
    ...overrides,
  } as unknown as Parameters<typeof createGraphSetupHost>[0]) as unknown as SetupHost;
}

export function setupHost(): SetupHost {
  try {
    return composeSetupHost() ?? NO_SETUP_HOST;
  } catch (error) {
    // A misconfigured host must not half-work: show the steps, change nothing.
    console.error(error instanceof Error ? error.message : "setup host: configuration refused");
    return NO_SETUP_HOST;
  }
}

export function canCheck(host: SetupHost): boolean {
  return host.readers !== null;
}

export function canProvision(host: SetupHost): boolean {
  return host.readers !== null && host.adapters !== null && host.credentials !== null && host.build !== null;
}
