import { resolvePrincipal } from "../../engine/authz/principals.mjs";
import { connect } from "../../engine/store/db.mjs";

import { databaseUrl } from "@/lib/runtime-config";

export const PRINCIPAL_ID_HEADER = "x-keel-principal-id";
export const CAPABILITIES_HEADER = "x-keel-capabilities";
// Task 90: capabilities held only through entity-scoped grants, as space-separated
// `capability:ENTITY` tokens. CAPABILITIES_HEADER stays central (tenant-wide) only, so
// every guard that predates entity scope keeps refusing an entity-only principal.
export const ENTITY_CAPABILITIES_HEADER = "x-keel-entity-capabilities";

export interface ResolvedIdentity {
  principalId: string | null;
  capabilities: string[];
  entityCapabilities?: Record<string, string[]>;
}

export interface EntityScope {
  central: boolean;
  entities: string[];
}

interface HeaderSource {
  get(name: string): string | null;
}

export function encodeEntityCapabilities(entities: Record<string, string[]> | undefined): string {
  return Object.entries(entities ?? {})
    .flatMap(([entity, capabilities]) => capabilities.map((capability) => `${capability}:${entity}`))
    .sort()
    .join(" ");
}

// Where the downstreamed principal holds `capability`: central, or only for some
// entities. Read from proxy-set headers only; a malformed token grants nothing.
export function entityScopeFrom(requestHeaders: HeaderSource, capability: string): EntityScope {
  const central = (requestHeaders.get(CAPABILITIES_HEADER) ?? "").split(" ").includes(capability);
  if (central) return { central: true, entities: [] };
  const entities = (requestHeaders.get(ENTITY_CAPABILITIES_HEADER) ?? "")
    .split(" ")
    .map((token) => /^([a-z-]+):([A-Z][A-Z0-9_]{1,31})$/.exec(token))
    .filter((match): match is RegExpExecArray => match !== null && match[1] === capability)
    .map((match) => match[2]);
  return { central: false, entities: [...new Set(entities)].sort() };
}

interface KeelClient {
  end(): Promise<void>;
}

// The portal's single identity-resolution seam (§2.4): one verified email in, one
// principal id plus its resolved capabilities out. When Entra ID SSO replaces
// Cloudflare Access, this module's contract is what stays — the identity provider is
// swapped behind it, not scattered across routes.
export async function resolveIdentity(email: string): Promise<ResolvedIdentity> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const { principal, capabilities, entityCapabilities } = (await resolvePrincipal(client, email)) as {
      principal: { id: string } | null;
      capabilities: string[];
      entityCapabilities: Record<string, string[]>;
    };
    return {
      principalId: principal ? String(principal.id) : null,
      capabilities,
      entityCapabilities,
    };
  } finally {
    await client.end();
  }
}
