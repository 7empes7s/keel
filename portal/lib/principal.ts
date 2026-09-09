import { resolvePrincipal } from "../../engine/authz/principals.mjs";
import { connect } from "../../engine/store/db.mjs";

import { databaseUrl } from "@/lib/runtime-config";

export const PRINCIPAL_ID_HEADER = "x-keel-principal-id";
export const CAPABILITIES_HEADER = "x-keel-capabilities";

export interface ResolvedIdentity {
  principalId: string | null;
  capabilities: string[];
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
    const { principal, capabilities } = (await resolvePrincipal(client, email)) as {
      principal: { id: string } | null;
      capabilities: string[];
    };
    return {
      principalId: principal ? String(principal.id) : null,
      capabilities,
    };
  } finally {
    await client.end();
  }
}
