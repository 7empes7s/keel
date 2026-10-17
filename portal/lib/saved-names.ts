// The name each saved setting carries, read from the tenant's most recent backup that
// holds one. The job page uses it so follow-ups and undo items never show a bare id.
import type { NamedKeys } from "@/lib/job-names";

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const NAME_FIELDS = ["displayName", "name", "title", "userPrincipalName", "mail", "subject"];
const NAME_SQL = `COALESCE(${NAME_FIELDS.map((field) => `NULLIF(rv.payload->>'${field}', '')`).join(", ")})`;

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
    `SELECT DISTINCT ON (rv.natural_key) rv.natural_key, rv.resource_type, ${NAME_SQL} AS name
       FROM resource_version rv
       JOIN snapshot s ON s.id = rv.snapshot_id
      WHERE s.tenant_ref = $1 AND rv.natural_key = ANY($2::text[])
      ORDER BY rv.natural_key, (${NAME_SQL} IS NULL), s.started_at DESC`,
    [tenantRef, wanted],
  );
  const names: NamedKeys = {};
  for (const row of rows) {
    names[String(row.natural_key)] = {
      name: row.name == null ? null : String(row.name),
      resourceType: String(row.resource_type),
    };
  }
  return names;
}
