// The name each saved setting carries, read from the tenant's most recent backup that
// holds one. The job page uses it so follow-ups and undo items never show a bare id.
import { objectNameSql } from "../../engine/cir/objectName.mjs";
import { DERIVED_NAME_TYPES, derivedName, edgeKeyType, type IdNames, NO_ID_NAMES, referencedIds } from "@/lib/app-names";
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
            CASE WHEN rv.resource_type = ANY($3::text[]) THEN rv.payload END AS payload
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
    names[key] = { name: row.name == null ? null : String(row.name), resourceType: type };
    if (row.name == null && (DERIVED_NAME_TYPES as readonly string[]).includes(type)) unnamed.push({ key, type, payload: row.payload });
  }
  for (const key of wanted) {
    const type = edgeKeyType(key);
    if (type && !names[key]) unnamed.push({ key, type, payload: null });
  }
  if (unnamed.length === 0) return names;
  const refs = unnamed.map((entry) => referencedIds(entry.type, entry.key, entry.payload));
  const lookup = await idNames(client, tenantRef, refs.flatMap((ref) => ref.ids), refs.flatMap((ref) => ref.roles));
  for (const entry of unnamed) {
    names[entry.key] = { name: derivedName(entry.type, entry.key, entry.payload, lookup), resourceType: entry.type };
  }
  return names;
}

// At most this many ids are looked up per page load; the rest stay unnamed (bounded).
const MAX_LOOKUP_IDS = 5000;
const LOOKUP_TYPES = ["servicePrincipal", "application", "user"];

/**
 * Names for the apps, people and app roles that settings point to by id, from the
 * tenant's newest backup that holds enterprise apps (or from the backup given, when a
 * page shows one backup). An app is found by its object id
 * or its app id (the enterprise app's name first), an app role by its id in an
 * enterprise app's appRoles. A failed read leaves them unnamed, never the page down.
 */
export async function idNames(client: QueryClient, tenantRef: string, ids: string[], roleIds: string[] = [], snapshotId: string | null = null): Promise<IdNames> {
  const wantedIds = [...new Set(ids.map((id) => id.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
  const wantedRoles = [...new Set(roleIds.map((id) => id.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
  if (!wantedIds.length && !wantedRoles.length) return NO_ID_NAMES;
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await client.query(
      `WITH latest AS (
         SELECT s.id FROM snapshot s
          WHERE s.tenant_ref = $1 AND ($5::uuid IS NULL OR s.id = $5::uuid)
            AND EXISTS (SELECT 1 FROM resource_version r WHERE r.snapshot_id = s.id AND r.resource_type = 'servicePrincipal')
          ORDER BY s.started_at DESC LIMIT 1
       )
       SELECT rv.resource_type, lower(rv.payload->>'id') AS id, lower(rv.payload->>'appId') AS app_id, ${NAME_SQL} AS name,
              CASE WHEN rv.resource_type = 'servicePrincipal' AND jsonb_typeof(rv.payload->'appRoles') = 'array'
                   THEN rv.payload->'appRoles' END AS roles
         FROM resource_version rv
        WHERE rv.snapshot_id IN (SELECT id FROM latest)
          AND rv.resource_type = ANY($4::text[])
          AND (lower(rv.payload->>'id') = ANY($2::text[])
            OR lower(rv.payload->>'appId') = ANY($2::text[])
            OR (rv.resource_type = 'servicePrincipal' AND jsonb_typeof(rv.payload->'appRoles') = 'array'
                AND EXISTS (SELECT 1 FROM jsonb_array_elements(rv.payload->'appRoles') role WHERE lower(role->>'id') = ANY($3::text[]))))
        ORDER BY (rv.resource_type = 'servicePrincipal') DESC`,
      [tenantRef, wantedIds, wantedRoles, LOOKUP_TYPES, snapshotId],
    ));
  } catch (error) {
    console.error("[keel-portal] app names unavailable", error);
    return NO_ID_NAMES;
  }
  const found: Record<string, string> = {};
  const roles: Record<string, string> = {};
  const wantedRole = new Set(wantedRoles);
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (name && !holdsObjectId(name)) {
      for (const id of [row.id, row.app_id]) {
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
