// Names for the ids inside setting values ("includeGroups: [<id>]"), read from the
// backups the values came from, so a before/after shows "Finance approvers", never an
// id. Matched on the object id, an app's appId and a role's template id. Bounded, and
// a failed read leaves the ids unnamed, never the page down.
import { objectNameSql } from "../../engine/cir/objectName.mjs";
import { holdsObjectId, objectIdsIn } from "@/lib/object-ids";

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const NAME_SQL = objectNameSql("rv.payload", "rv.resource_type");
const MAX_IDS = 500;

/** Every id inside the values, lower-cased, at most MAX_IDS. */
export function idsInValues(values: unknown[]): string[] {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (found.size >= MAX_IDS) return;
    if (typeof value === "string") { for (const id of objectIdsIn(value)) found.add(id.toLowerCase()); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  values.forEach(walk);
  return [...found].slice(0, MAX_IDS);
}

export async function idNames(client: QueryClient, snapshotIds: (string | null | undefined)[], values: unknown[]): Promise<Record<string, string>> {
  const snapshots = [...new Set(snapshotIds.filter((id): id is string => typeof id === "string" && Boolean(id)))];
  const wanted = idsInValues(values);
  if (!snapshots.length || !wanted.length) return {};
  const names: Record<string, string> = {};
  try {
    const { rows } = await client.query(
      `SELECT lower(rv.payload->>'id') AS id, lower(rv.payload->>'appId') AS app_id,
              lower(rv.payload->>'roleTemplateId') AS template_id, ${NAME_SQL} AS name
         FROM resource_version rv
        WHERE rv.snapshot_id = ANY($1::uuid[])
          AND (lower(rv.payload->>'id') = ANY($2::text[])
            OR lower(rv.payload->>'appId') = ANY($2::text[])
            OR lower(rv.payload->>'roleTemplateId') = ANY($2::text[]))`,
      [snapshots, wanted],
    );
    for (const row of rows) {
      const name = typeof row.name === "string" ? row.name.trim() : "";
      if (!name || holdsObjectId(name)) continue;
      for (const id of [row.id, row.app_id, row.template_id]) {
        if (typeof id === "string" && wanted.includes(id) && !names[id]) names[id] = name;
      }
    }
    const missing = wanted.filter((id) => !names[id]);
    if (missing.length) Object.assign(names, await namesFromOtherBackups(client, snapshots, missing));
  } catch (error) {
    console.error("[keel-portal] names for ids in values unavailable", error);
  }
  return names;
}

// What a value points to but its own backup does not hold: backups run by tier, so a
// Tier 1 policy's excluded people and administrative units are backed up in Tier 2.
// Each such type is read from the same tenant's newest backup that holds it.
const POINTED_TO_TYPES = [
  "user", "group", "servicePrincipal", "application", "administrativeUnit",
  "roleDefinition", "directoryRole", "directoryRoleTemplate", "namedLocation", "authenticationStrengthPolicy",
];

async function namesFromOtherBackups(client: QueryClient, snapshots: string[], wanted: string[]): Promise<Record<string, string>> {
  const { rows } = await client.query(
    `WITH tenants AS (SELECT DISTINCT tenant_ref FROM snapshot WHERE id = ANY($1::uuid[])),
          latest AS (
            SELECT types.type, newest.id
              FROM unnest($3::text[]) AS types(type)
              CROSS JOIN LATERAL (
                SELECT s.id FROM snapshot s
                 WHERE s.tenant_ref IN (SELECT tenant_ref FROM tenants)
                   AND EXISTS (SELECT 1 FROM resource_version r WHERE r.snapshot_id = s.id AND r.resource_type = types.type)
                 ORDER BY s.started_at DESC LIMIT 1
              ) newest
          )
     SELECT lower(rv.payload->>'id') AS id, lower(rv.payload->>'appId') AS app_id,
            lower(COALESCE(rv.payload->>'roleTemplateId', rv.payload->>'templateId')) AS template_id, ${NAME_SQL} AS name
       FROM resource_version rv
      WHERE (rv.snapshot_id, rv.resource_type) IN (SELECT id, type FROM latest)
        AND (lower(rv.payload->>'id') = ANY($2::text[])
          OR lower(rv.payload->>'appId') = ANY($2::text[])
          OR lower(COALESCE(rv.payload->>'roleTemplateId', rv.payload->>'templateId')) = ANY($2::text[]))`,
    [snapshots, wanted, POINTED_TO_TYPES],
  );
  const names: Record<string, string> = {};
  for (const row of rows) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name || holdsObjectId(name)) continue;
    for (const id of [row.id, row.app_id, row.template_id]) {
      if (typeof id === "string" && wanted.includes(id) && !names[id]) names[id] = name;
    }
  }
  return names;
}
