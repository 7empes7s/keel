import { learnDisplayName } from "../../engine/authz/displayName.mjs";
import { findPrincipalById, resolvePrincipal } from "../../engine/authz/principals.mjs";
import { connect } from "@/lib/db";

import { databaseUrl, tenantRef } from "@/lib/runtime-config";

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

/** What the sign-in knows about the person beyond their email, to fill a missing name. */
export interface SignInHints {
  claims?: Record<string, unknown>;
  /** The identity the sign-in service holds for this sign-in; asked last. */
  lookupIdentity?: () => Promise<Record<string, unknown> | null>;
}

// A nameless person is looked up at most once an hour per portal process, so a sign-in
// service that has no name for them costs one lookup, not one per request.
const NAME_RETRY_MS = 60 * 60 * 1000;
const nameAttempts = new Map<string, number>();

function shouldLearnName(principalId: string, now = Date.now()): boolean {
  const last = nameAttempts.get(principalId);
  if (last !== undefined && now - last < NAME_RETRY_MS) return false;
  nameAttempts.set(principalId, now);
  return true;
}

/** Test seam: forget past name lookups. */
export function resetNameAttempts(): void {
  nameAttempts.clear();
}

function currentTenantRef(): string | null {
  try {
    return tenantRef();
  } catch {
    return null;
  }
}

// The portal's single identity-resolution seam (§2.4): one verified email in, one
// principal id plus its resolved capabilities out. When Entra ID SSO replaces
// Cloudflare Access, this module's contract is what stays — the identity provider is
// swapped behind it, not scattered across routes. A person with no display name gets
// one filled from the sign-in or the directory (engine/authz/displayName.mjs), so jobs,
// approvals and activity name them properly instead of guessing from their email.
export async function resolveIdentity(email: string, hints?: SignInHints): Promise<ResolvedIdentity> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const { principal, capabilities, entityCapabilities } = (await resolvePrincipal(client, email)) as {
      principal: { id: string; display_name?: string | null; system_kind?: string | null } | null;
      capabilities: string[];
      entityCapabilities: Record<string, string[]>;
    };
    if (hints && principal && !principal.system_kind && !principal.display_name?.trim() && shouldLearnName(String(principal.id))) {
      try {
        await learnDisplayName(client, {
          principalId: String(principal.id),
          email,
          tenantRef: currentTenantRef(),
          claims: hints.claims ?? null,
          lookupIdentity: hints.lookupIdentity ?? null,
        });
      } catch {
        // A missing name never blocks sign-in.
      }
    }
    return {
      principalId: principal ? String(principal.id) : null,
      capabilities,
      entityCapabilities,
    };
  } finally {
    await client.end();
  }
}

/** The menu's "who you are": the principal's display name, or null when it has none. */
export async function principalDisplayName(principalId: string): Promise<string | null> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const principal = (await findPrincipalById(client, principalId)) as { display_name?: string | null } | null;
    return principal?.display_name?.trim() || null;
  } finally {
    await client.end();
  }
}
