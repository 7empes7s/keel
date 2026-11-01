// The name each saved setting carries, read from the tenant's most recent backup that
// holds one. The job page uses it so follow-ups and undo items never show a bare id.
import { objectNameSql } from "../../engine/cir/objectName.mjs";
import { DERIVED_NAME_TYPES, derivedName, edgeKeyType, type IdNames, NO_ID_NAMES, referencedIds, unnamedReferences } from "@/lib/app-names";
import { holdsObjectId, type NamedKeys, namedSubject } from "@/lib/job-names";
import type { ChangeRef } from "@/lib/sentences";

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const NAME_SQL = objectNameSql("rv.payload", "rv.resource_type");

/** Every key, and each side of a relationship edge ("parent|family|target"). */
export function keysToName(keys: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || !key) continue;
    const [parent, family, target] = key.split("|");
    if (family && target) {
      out.add(parent);
      out.add(target);
    } else {
      out.add(key);
    }
  }
  return [...out];
}

export async function savedNames(client: QueryClient, tenantRef: string, keys: (string | null | undefined)[]): Promise<NamedKeys> {
  const wanted = keysToName(keys);
  if (wanted.length === 0) return {};
  const { rows } = await client.query(
    `SELECT DISTINCT ON (rv.natural_key) rv.natural_key, rv.resource_type, ${NAME_SQL} AS name,
            CASE WHEN rv.resource_type = ANY($3::text[]) THEN rv.payload END AS payload,
            rv.payload->'templateReference'->>'templateFamily' AS template_family,
            rv.payload->'isBuiltIn' AS is_built_in
       FROM resource_version rv
       JOIN snapshot s ON s.id = rv.snapshot_id
      WHERE s.tenant_ref = $1 AND rv.natural_key = ANY($2::text[])
      ORDER BY rv.natural_key, (${NAME_SQL} IS NULL), s.started_at DESC`,
    [tenantRef, wanted, DERIVED_NAME_TYPES],
  );
  const names: NamedKeys = {};
  // App settings that carry no name (app consent, app permissions, owners, provisioning
  // jobs) are named from the apps and people they point to.
  const unnamed: { key: string; type: string; payload: unknown }[] = [];
  for (const row of rows) {
    const key = String(row.natural_key);
    const type = String(row.resource_type);
    names[key] = {
      name: row.name == null ? null : String(row.name),
      resourceType: type,
      ...(typeof row.template_family === "string" && row.template_family ? { templateFamily: row.template_family } : {}),
      ...(typeof row.is_built_in === "boolean" ? { builtIn: row.is_built_in } : {}),
    };
    if (row.name == null && (DERIVED_NAME_TYPES as readonly string[]).includes(type)) unnamed.push({ key, type, payload: row.payload });
  }
  for (const key of wanted) {
    const type = edgeKeyType(key);
    if (type && !names[key]) unnamed.push({ key, type, payload: null });
  }
  if (unnamed.length === 0) return names;
  const refs = unnamed.map((entry) => referencedIds(entry.type, entry.key, entry.payload));
  const lookup = await idNames(client, tenantRef, refs.flatMap((ref) => ref.ids), refs.flatMap((ref) => ref.roles));
  const known = new Set(Object.keys(lookup.ids));
  for (const entry of unnamed) {
    // What it points to that no backup names, with a lookup link, for Technical details.
    const unnamedRefs = unnamedReferences(entry.type, entry.key, entry.payload, known);
    names[entry.key] = { name: derivedName(entry.type, entry.key, entry.payload, lookup), resourceType: entry.type, ...(unnamedRefs.length ? { unnamedRefs } : {}) };
  }
  return names;
}

// At most this many ids are looked up per page load; the rest stay unnamed (bounded).
const MAX_LOOKUP_IDS = 5000;
// What settings point to by id: apps and people, plus the groups, admin roles, scopes,
// access packages and partner organizations that role assignments, access package
// assignments and cross-tenant settings name (lib/app-names.ts).
const LOOKUP_TYPES = [
  "servicePrincipal", "application", "user", "group", "administrativeUnit",
  "roleDefinition", "directoryRole", "directoryRoleTemplate", "deviceManagementRoleDefinition",
  "exchangeRoleDefinition", "exchangeCustomAppScope", "defenderRoleDefinition", "defenderCustomAppScope",
  "accessPackage", "accessPackageCatalog", "crossTenantIdentitySyncPolicyPartner",
];

/**
 * Names for the apps, people and app roles that settings point to by id. Each type is
 * read from the tenant's newest backup that holds that type (the backup given first,
 * when a page shows one backup and it holds the type): backups run by tier, so people,
 * Exchange and Defender roles and access packages (Tier 2) sit in other backups than
 * enterprise apps and directory roles (Tier 1). An app is found by its object id
 * or its app id (the enterprise app's name first), an admin role by its id or template
 * id, a partner organization by its tenant id, an app role by its id in an
 * enterprise app's appRoles. A failed read leaves them unnamed, never the page down.
 */
export async function idNames(client: QueryClient, tenantRef: string, ids: string[], roleIds: string[] = [], snapshotId: string | null = null): Promise<IdNames> {
  const wantedIds = [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
  const wantedRoles = [...new Set(roleIds.map((id) => id.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
  if (!wantedIds.length && !wantedRoles.length) return NO_ID_NAMES;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await client.query(
      // The newest complete backup of each type comes from type_coverage_latest (one row
      // per tenant and type, kept by triggers), so no backup history is walked. A type it
      // has no row for falls back to the newest backup holding enterprise apps.
      `WITH covered AS (
         SELECT tcl.resource_type AS type, tcl.snapshot_id AS id
           FROM type_coverage_latest tcl JOIN snapshot s ON s.id = tcl.snapshot_id
          WHERE tcl.tenant_ref = $1 AND tcl.resource_type = ANY($4::text[])
       ),
       apps AS (
         SELECT s.id FROM snapshot s
          WHERE s.tenant_ref = $1
            AND EXISTS (SELECT 1 FROM resource_version r WHERE r.snapshot_id = s.id AND r.resource_type = 'servicePrincipal')
          ORDER BY s.started_at DESC LIMIT 1
       ),
       latest AS (
         SELECT type, id FROM covered
         UNION
         SELECT types.type, apps.id FROM unnest($4::text[]) AS types(type), apps
          WHERE types.type NOT IN (SELECT type FROM covered)
         UNION
         SELECT types.type, s.id FROM unnest($4::text[]) AS types(type), snapshot s WHERE s.id = $5::uuid AND s.tenant_ref = $1
       )
       SELECT rv.resource_type, lower(rv.payload->>'id') AS id, lower(rv.payload->>'appId') AS app_id,
              lower(COALESCE(rv.payload->>'templateId', rv.payload->>'roleTemplateId')) AS template_id,
              CASE WHEN rv.resource_type = 'crossTenantIdentitySyncPolicyPartner' THEN lower(rv.payload->>'tenantId') END AS tenant_id,
              ${NAME_SQL} AS name,
              CASE WHEN rv.resource_type = 'servicePrincipal' AND jsonb_typeof(rv.payload->'appRoles') = 'array'
                   THEN rv.payload->'appRoles' END AS roles
         FROM resource_version rv
        WHERE (rv.snapshot_id, rv.resource_type) IN (SELECT id, type FROM latest)
          AND (lower(rv.payload->>'id') = ANY($2::text[])
            OR lower(rv.payload->>'appId') = ANY($2::text[])
            OR lower(COALESCE(rv.payload->>'templateId', rv.payload->>'roleTemplateId')) = ANY($2::text[])
            OR (rv.resource_type = 'crossTenantIdentitySyncPolicyPartner' AND lower(rv.payload->>'tenantId') = ANY($2::text[]))
            OR (rv.resource_type = 'servicePrincipal' AND jsonb_typeof(rv.payload->'appRoles') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(rv.payload->'appRoles') role WHERE lower(role->>'id') = ANY($3::text[]))))
        ORDER BY (rv.resource_type = 'servicePrincipal') DESC, (rv.snapshot_id = $5::uuid) IS TRUE DESC`,
      [tenantRef, wantedIds, wantedRoles, LOOKUP_TYPES, snapshotId],
    ));
  } catch (error) {
    console.error("[keel-portal] app names unavailable", error);
    return NO_ID_NAMES;
  }
  const found: Record<string, string> = await roleGroupNames(client, tenantRef, wantedIds);
  const roles: Record<string, string> = {};
  const wantedRole = new Set(wantedRoles);
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name && !holdsObjectId(name)) {
      for (const id of [row.id, row.app_id, row.template_id, row.tenant_id]) {
        if (typeof id === "string" && id && !(id in found)) found[id] = name;
      }
    }
    for (const role of Array.isArray(row.roles) ? row.roles as Record<string, unknown>[] : []) {
      const id = typeof role?.id === "string" ? role.id.toLowerCase() : "";
      if (!wantedRole.has(id) || id in roles) continue;
      const roleName = [role.value, role.displayName].find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (roleName && !holdsObjectId(roleName)) roles[id] = roleName.trim();
    }
  }
  return { ids: found, roles };
}

// Exchange admin role groups are read with Get-RoleGroup (workload exchange-role-groups),
// not from Microsoft Graph, so Graph's "/RoleGroups/<id>" in an Exchange role assignment
// is named from the newest usable read of them.
const ROLE_GROUP_WORKLOAD = "exchange-role-groups";

/** Names of the Exchange role groups among `ids` (by Guid or ExchangeObjectId). A failed
 * read names none, never the page down. */
export async function roleGroupNames(client: QueryClient, tenantRef: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await client.query(
      `WITH latest AS (
         SELECT c.id FROM workload_collection c
          WHERE c.tenant_ref = $1 AND c.workload = $3 AND c.outcome IN ('complete', 'partial')
            AND EXISTS (SELECT 1 FROM workload_observation w WHERE w.collection_id = c.id)
          ORDER BY c.observed_to DESC LIMIT 1
       )
       SELECT lower(o.fields->>'identity') AS id, lower(o.fields->>'ExchangeObjectId') AS object_id,
              COALESCE(NULLIF(btrim(o.fields->>'DisplayName'), ''), NULLIF(btrim(o.fields->>'Name'), '')) AS name
         FROM workload_observation o
        WHERE o.collection_id IN (SELECT id FROM latest)
          AND (lower(o.fields->>'identity') = ANY($2::text[]) OR lower(o.fields->>'ExchangeObjectId') = ANY($2::text[]))`,
      [tenantRef, ids, ROLE_GROUP_WORKLOAD],
    ));
  } catch (error) {
    console.error("[keel-portal] role group names unavailable", error);
    return {};
  }
  const found: Record<string, string> = {};
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || holdsObjectId(name)) continue;
    for (const id of [row.id, row.object_id]) {
      if (typeof id === "string" && id && !(id in found)) found[id] = name;
    }
  }
  return found;
}

interface WithChanges {
  references?: { changes: (ChangeRef | undefined)[] };
}

/**
 * Each change a job or request rolls back, named by the name its backup holds, so a
 * roll back reads "Roll back of 2 changes, including Finance (group)", never an id. A
 * change with no saved name keeps a null name; a failed lookup leaves every change
 * unnamed rather than taking the page down.
 */
export async function withSavedChangeNames<T extends WithChanges>(client: QueryClient, tenantRef: string, rows: T[]): Promise<T[]> {
  const keys = rows.flatMap((row) => (row.references?.changes ?? []).map((change) => change?.naturalKey));
  if (!keys.some(Boolean)) return rows;
  let names: NamedKeys;
  try {
    names = await savedNames(client, tenantRef, keys);
  } catch (error) {
    console.error("[keel-portal] change names unavailable", error);
    return rows;
  }
  return rows.map((row) => nameChanges(row, names));
}

/** One row's changes with their saved names. Pure, so it is tested directly. */
export function nameChanges<T extends WithChanges>(row: T, names: NamedKeys): T {
  const refs = row.references;
  if (!refs?.changes.length) return row;
  return {
    ...row,
    references: {
      ...refs,
      changes: refs.changes.map((change) => {
        if (!change?.readable || !change.naturalKey) return change;
        const name = namedSubject(change.naturalKey, names, change.resourceType);
        return name.startsWith("Unnamed ") || holdsObjectId(name) ? change : { ...change, name };
      }),
    },
  } as T;
}
