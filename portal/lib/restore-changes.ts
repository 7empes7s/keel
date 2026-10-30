import { connect } from "@/lib/db";
import { sameContent } from "../../engine/cir/canonicalHash.mjs";
import { semanticChange } from "../../engine/govern/semanticDrift.mjs";
import { MAX_ATTRIBUTED_CHANGES, attributeChanges } from "../../engine/identity/attribution.mjs";
import { changeObjectIds } from "../../engine/identity/auditSources.mjs";
import { settingKind, templateFamilyOf, typeInfo } from "../../engine/insights/taxonomy.mjs";

import { valueWords } from "@/lib/changes-view";
import { isObjectId, replaceObjectIds } from "@/lib/object-ids";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

// The Restore page's "Changed recently" group (handoff/redesign/CHOICE.md, "Restore"):
// what differs between the chosen backup and the newest one, so a person sees what
// changed since that point, when, and who did it, and can put it back in one click.
// The newest backup stands in for "now": it is the latest state KEEL has read.

export const MAX_RESTORE_CHANGES = MAX_ATTRIBUTED_CHANGES;
const MAX_FIELDS = 6;
const MAX_VALUE_LENGTH = 90;

export interface RestoreChangeField {
  path: string;
  // In words (lib/changes-view valueWords), cut to a short line.
  before: string;
  after: string;
}

export interface RestoreChange {
  naturalKey: string;
  resourceType: string;
  service: string | null;
  // changed: it exists now with different settings; deleted: it is gone now.
  kind: "changed" | "deleted";
  // When the change was first seen: the first backup after the chosen one that has it.
  seenAt: string | null;
  // The last backup that still matched the chosen one; the change happened after it.
  sameUntil: string | null;
  // Settings that changed behaviour, as they are in the chosen backup and now.
  fields: RestoreChangeField[];
  fieldCount: number;
  // Who made the change, from the audit log; null when it cannot be told.
  who: { names: string[]; certain: boolean } | null;
}

export interface BackupPoint {
  id: string;
  takenAt: string | null;
}

export interface RestoreChangesData {
  // The newest backup, which the chosen one is compared with. Null when there is none.
  newest: BackupPoint | null;
  changes: RestoreChange[];
  // Changes found beyond the ones listed.
  more: number;
  // When the chosen backup is the newest: the backup before it, and how many settings
  // changed between the two, so the page can offer to undo those.
  earlier: (BackupPoint & { count: number }) | null;
}

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

interface SnapshotRow {
  id: string;
  startedAt: number;
  takenAt: string | null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const isId = (value: unknown) => typeof value === "string" && isObjectId(value);

// Redesign rule 4: ids never reach the screen. A list of object ids reads as a count;
// an id inside a value is dropped.
function short(value: unknown): string {
  if (Array.isArray(value) && value.length && value.every(isId)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (isId(value)) return "one item";
  const text = replaceObjectIds(valueWords(value), () => "…");
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

// Keys whose settings differ between two backups, or that are gone from the later one.
// A key counts as gone only when the later backup read its type at all: a backup of
// one tier does not make another tier's settings look deleted.
const DIFF_SQL = `
  SELECT p.natural_key, p.resource_type, p.payload_hash, p.payload AS before, n.payload AS after, (n.id IS NULL) AS deleted
    FROM resource_version p
    LEFT JOIN resource_version n ON n.snapshot_id = $2 AND n.natural_key = p.natural_key
   WHERE p.snapshot_id = $1
     AND (
       (n.id IS NOT NULL AND n.payload_hash <> p.payload_hash)
       OR (n.id IS NULL AND EXISTS (SELECT 1 FROM resource_version x WHERE x.snapshot_id = $2 AND x.resource_type = p.resource_type))
     )
   ORDER BY p.natural_key`;

interface DiffRow {
  naturalKey: string;
  resourceType: string;
  hash: string;
  // The chosen backup's payload, to compare by content where a hash was stored under other rules.
  payload: unknown;
  // The Microsoft object ids an audit record about it would name.
  objectIds: string[];
  kind: "changed" | "deleted";
  fields: RestoreChangeField[];
  fieldCount: number;
}

async function diff(client: Client, fromId: string, toId: string): Promise<DiffRow[]> {
  const { rows } = await client.query(DIFF_SQL, [fromId, toId]);
  const result: DiffRow[] = [];
  for (const row of rows) {
    const resourceType = String(row.resource_type);
    const base = {
      naturalKey: String(row.natural_key), resourceType, hash: String(row.payload_hash), payload: row.before,
      objectIds: changeObjectIds({ naturalKey: String(row.natural_key), before: row.before, after: row.after }) as string[],
    };
    if (row.deleted) {
      result.push({ ...base, kind: "deleted", fields: [], fieldCount: 0 });
      continue;
    }
    // A different hash with no behavioural difference (only fields Microsoft sets
    // itself) is not a change a person would undo.
    const semantic = semanticChange({ resourceType, changeType: "changed", before: row.before, after: row.after, limit: MAX_FIELDS }) as {
      total: number;
      fields: { path: string; before?: unknown; after?: unknown }[];
    };
    if (semantic.total === 0) continue;
    result.push({
      ...base,
      kind: "changed",
      fields: semantic.fields.map((field) => ({ path: field.path, before: short(field.before), after: short(field.after) })),
      fieldCount: semantic.total,
    });
  }
  return result;
}

/** For each changed key, the last backup that still matched the chosen one and the
 * first that did not, walking the backups taken after it in order. A backup counts as
 * matching when it holds the same content (sameContent), not only the same stored hash:
 * a hash stored before a field rule changed (#288, #294) would otherwise name the first
 * backup after the rule change as the change, and widen the who-changed window. */
async function whenChanged(client: Client, ref: string, after: SnapshotRow[], rows: DiffRow[]) {
  const found = new Map<string, { sameUntil: string | null; seenAt: string | null }>();
  if (!after.length || !rows.length) return found;
  const ids = after.map((snapshot) => snapshot.id);
  // The payload is read only where the hash differs, which is where content decides.
  const { rows: versions } = await client.query(
    `SELECT rv.snapshot_id, rv.natural_key, rv.payload_hash,
            CASE WHEN rv.payload_hash IS DISTINCT FROM k.hash THEN rv.payload END AS payload
       FROM resource_version rv
       JOIN snapshot s ON s.id = rv.snapshot_id
       JOIN unnest($3::text[], $4::text[]) AS k(natural_key, hash) ON k.natural_key = rv.natural_key
      WHERE s.tenant_ref = $1 AND rv.snapshot_id = ANY($2::uuid[])`,
    [ref, ids, rows.map((row) => row.naturalKey), rows.map((row) => row.hash)],
  );
  const { rows: types } = await client.query(
    `SELECT DISTINCT snapshot_id, resource_type FROM resource_version
      WHERE snapshot_id = ANY($1::uuid[]) AND resource_type = ANY($2::text[])`,
    [ids, [...new Set(rows.map((row) => row.resourceType))]],
  );
  const versionAt = new Map(versions.map((version) => [`${version.snapshot_id}|${version.natural_key}`, { payload_hash: String(version.payload_hash), payload: version.payload }]));
  const read = new Set(types.map((type) => `${type.snapshot_id}|${type.resource_type}`));
  for (const row of rows) {
    let sameUntil: string | null = null;
    let seenAt: string | null = null;
    const chosen = { payload_hash: row.hash, payload: row.payload };
    for (const snapshot of after) {
      if (!read.has(`${snapshot.id}|${row.resourceType}`)) continue;
      const version = versionAt.get(`${snapshot.id}|${row.naturalKey}`);
      if (version && sameContent(chosen, version, row.resourceType)) {
        sameUntil = snapshot.takenAt;
        continue;
      }
      seenAt = snapshot.takenAt;
      break;
    }
    found.set(row.naturalKey, { sameUntil, seenAt });
  }
  return found;
}

async function whoChanged(client: Client, ref: string, changes: RestoreChange[], chosenAt: string | null, objectIds: Map<string, string[]>) {
  const who = new Map<string, RestoreChange["who"]>();
  const windows = changes.filter((change) => change.seenAt);
  if (!windows.length) return who;
  try {
    const attributed = (await attributeChanges(client, {
      tenantRef: ref,
      changes: windows.map((change) => ({
        id: change.naturalKey,
        resourceType: change.resourceType,
        naturalKey: change.naturalKey,
        changeType: change.kind === "deleted" ? "removed" : "modified",
        objectIds: objectIds.get(change.naturalKey) ?? [],
        fields: [...new Set(change.fields.map((field) => field.path.split(".")[0]))],
        window: { from: change.sameUntil ?? chosenAt, until: change.seenAt },
      })),
    })) as { changeId: string; verdict: string; actors: { kind: string; name: string | null }[] }[];
    for (const entry of attributed) {
      if (entry.verdict === "unknown" || !entry.actors.length) continue;
      const names = [...new Set(entry.actors.map((actor) => actor.name ?? (actor.kind === "servicePrincipal" ? "an app" : "someone outside your view")))];
      who.set(entry.changeId, { names, certain: entry.verdict === "exact" });
    }
  } catch {
    // Attribution is a hint: without it the change is still listed, with "not known".
  }
  return who;
}

/** What changed after the chosen backup, newest first. */
export async function getRestoreChanges(snapshotId: string): Promise<RestoreChangesData> {
  const ref = tenantRef();
  const client = (await connect(databaseUrl())) as Client;
  try {
    const { rows } = await client.query(
      `SELECT id, started_at, COALESCE(completed_at, started_at) AS taken_at
         FROM snapshot WHERE tenant_ref = $1 AND status = 'complete'
        ORDER BY started_at DESC LIMIT 50`,
      [ref],
    );
    const snapshots: SnapshotRow[] = rows.map((row) => ({ id: String(row.id), startedAt: new Date(String(row.started_at)).getTime(), takenAt: iso(row.taken_at) }));
    const newest = snapshots[0] ?? null;
    const chosenIndex = snapshots.findIndex((snapshot) => snapshot.id === snapshotId);
    if (!newest || chosenIndex === -1) return { newest: newest && { id: newest.id, takenAt: newest.takenAt }, changes: [], more: 0, earlier: null };
    const chosen = snapshots[chosenIndex];

    if (chosenIndex === 0) {
      const before = snapshots[1];
      const earlier = before ? { id: before.id, takenAt: before.takenAt, count: (await diff(client, before.id, newest.id)).length } : null;
      return { newest: { id: newest.id, takenAt: newest.takenAt }, changes: [], more: 0, earlier };
    }

    const rowsChanged = await diff(client, chosen.id, newest.id);
    // Backups after the chosen one, oldest first.
    const after = snapshots.slice(0, chosenIndex).reverse();
    const when = await whenChanged(client, ref, after, rowsChanged);
    const all: RestoreChange[] = rowsChanged.map((row) => ({
      naturalKey: row.naturalKey,
      resourceType: row.resourceType,
      // An endpoint security policy made in Intune sits under Defender, as on the backup list.
      service: typeInfo(settingKind(row.resourceType, templateFamilyOf(row.payload))).service,
      kind: row.kind,
      seenAt: when.get(row.naturalKey)?.seenAt ?? newest.takenAt,
      sameUntil: when.get(row.naturalKey)?.sameUntil ?? chosen.takenAt,
      fields: row.fields,
      fieldCount: row.fieldCount,
      who: null,
    }));
    all.sort((a, b) => (b.seenAt ?? "").localeCompare(a.seenAt ?? "") || a.naturalKey.localeCompare(b.naturalKey));
    const listed = all.slice(0, MAX_RESTORE_CHANGES);
    const who = await whoChanged(client, ref, listed, chosen.takenAt, new Map(rowsChanged.map((row) => [row.naturalKey, row.objectIds])));
    return {
      newest: { id: newest.id, takenAt: newest.takenAt },
      changes: listed.map((change) => ({ ...change, who: who.get(change.naturalKey) ?? null })),
      more: all.length - listed.length,
      earlier: null,
    };
  } finally {
    await client.end();
  }
}
