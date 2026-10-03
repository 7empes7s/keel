// engine/authz/principals.mjs
//
// Resolving an authenticated email to a principal and its capabilities (§2.4, §3.2).
// Authentication is not authorisation: an email with no principal row resolves to no
// capabilities, and a disabled principal resolves to no capabilities even with live
// grants. A grant counts only while `at` is inside its [active_from, active_until)
// window; a null active_until is open-ended. Nothing sets a bounded window yet;
// everything honours one.
import { capabilitiesForRole, parseGrantScope } from './permissions.mjs';

export async function findPrincipalByEmail(client, email) {
  const { rows } = await client.query(
    `SELECT * FROM principal WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

// The worker re-authorizes a job against the principal recorded in requested_by, which
// is the portal-downstreamed principal id. Comparing as text keeps a stale or foreign
// requested_by (never a uuid) a clean miss instead of a cast error — deny by default.
export async function findPrincipalById(client, id) {
  if (typeof id !== 'string' || id.length === 0) return null;
  const { rows } = await client.query(
    `SELECT * FROM principal WHERE id::text = $1`,
    [id],
  );
  return rows[0] ?? null;
}

// Task 90: the active grants with their parsed scope. A grant whose scope does not
// parse is dropped here, so a malformed scope can never read as central.
async function activeScopedRoles(client, principal, at) {
  const { rows } = await client.query(
    `SELECT rg.role, rg.scope
       FROM role_grant rg
       JOIN principal p ON p.id = rg.principal_id
      WHERE rg.principal_id = $1
        AND p.disabled_at IS NULL
        AND rg.active_from <= $2
        AND (rg.active_until IS NULL OR rg.active_until > $2)`,
    [principal.id, at],
  );
  return rows.map((row) => ({ role: row.role, scope: parseGrantScope(row.scope) })).filter((row) => row.scope);
}

// Central (tenant-wide, scope `*`) capabilities only. Every existing `can` caller asks
// a tenant-wide question, so an entity-scoped grant must never answer it: that is the
// fail-closed reading for code that predates entity scope.
export async function capabilitiesForPrincipal(client, principal, at = new Date()) {
  return (await scopedCapabilitiesForPrincipal(client, principal, at)).central;
}

// Task 90: { central: [capability], entities: { CODE: [capability] } }. An entity entry
// lists only what that entity's grants add; central capabilities apply everywhere.
export async function scopedCapabilitiesForPrincipal(client, principal, at = new Date()) {
  const empty = { central: [], entities: {} };
  if (!principal?.id || principal.disabled_at) return empty;
  // System identities still pass through the normal disabled-principal and worker checks.
  if (principal.system_kind === 'scheduler') {
    const { rows } = await client.query(
      "SELECT id FROM principal WHERE id = $1 AND system_kind = 'scheduler' AND disabled_at IS NULL", [principal.id],
    );
    return rows.length ? { central: ['collect', 'configuration'], entities: {} } : empty;
  }
  const central = new Set();
  const entities = {};
  for (const { role, scope } of await activeScopedRoles(client, principal, at)) {
    const target = scope.kind === 'central' ? central : (entities[scope.entityCode] ??= new Set());
    for (const capability of capabilitiesForRole(role)) target.add(capability);
  }
  return {
    central: [...central],
    entities: Object.fromEntries(Object.entries(entities).sort(([a], [b]) => a.localeCompare(b)).map(([code, caps]) => [code, [...caps]])),
  };
}

export async function resolvePrincipal(client, email, at = new Date()) {
  const principal = await findPrincipalByEmail(client, email);
  const scoped = await scopedCapabilitiesForPrincipal(client, principal, at);
  return { principal, capabilities: scoped.central, entityCapabilities: scoped.entities };
}

// Keep raw grants (including scheduled/expired windows) beside the engine's effective
// answer. A disabled identity remains visible for administration, with no capabilities.
export async function listPrincipals(client) {
  const { rows } = await client.query('SELECT id, email, display_name, system_kind, disabled_at FROM principal ORDER BY lower(email), id');
  const grants = await client.query('SELECT * FROM role_grant ORDER BY active_from, id');
  const at = new Date();
  return Promise.all(rows.map(async (principal) => {
    const scoped = await scopedCapabilitiesForPrincipal(client, principal, at);
    return {
      ...principal,
      role_grants: grants.rows.filter((grant) => grant.principal_id === principal.id),
      capabilities: scoped.central,
      entity_capabilities: scoped.entities,
    };
  }));
}
