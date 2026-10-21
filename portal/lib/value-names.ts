// Names for the ids inside setting values ("includeGroups: [<id>]"), read from the
// backups the values came from, so a before/after shows "Finance approvers", never an
// id. Matched on the object id, an app's appId and a role's template id. Bounded, and
// a failed read leaves the ids unnamed, never the page down.
import { holdsObjectId, objectIdsIn } from "@/lib/object-ids";

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const NAME_FIELDS = ["displayName", "name", "title", "userPrincipalName", "mail"];
const NAME_SQL = `COALESCE(${NAME_FIELDS.map((field) => `NULLIF(rv.payload->>'${field}', '')`).join(", ")})`;
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
  } catch (error) {
    console.error("[keel-portal] names for ids in values unavailable", error);
  }
  return names;
}
