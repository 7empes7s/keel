// What a job or an audit entry on the Activity page changed: each object with the
// settings that differ, before and after. Read-only, and read on demand for the one
// row a person opens (GET /api/activity/changes), never for the whole timeline.
//
// - A backup: its backup against the one before it that read the same kinds.
// - A roll back: each change it puts back, as Keel found it and as the approved setup has it.
// - A restore: the restored settings as the last backup before the restore had them,
//   and as the restored backup has them.
// - A found change (an audit entry about one): the approved setup and what was found.
// - A rule edit or delete (its audit entry): each rule setting before and after.
import { CompareError, compareSnapshots, presenceFields, typeOutcome } from "../../engine/govern/compare.mjs";
import { semanticChange } from "../../engine/govern/semanticDrift.mjs";
import { payloadName } from "@/lib/changes-view";
import { connect } from "@/lib/db";

import type { ActivityChanges, ChangeKind, ChangedObject } from "@/lib/changed-values";
import { objectName } from "@/lib/changed-values";
import type { CompareResult } from "@/lib/compare-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { savedNames } from "@/lib/saved-names";
import { idNames } from "@/lib/value-names";
import { ruleChangeFields } from "@/lib/policy-view";

interface Client {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export const MAX_CHANGED_OBJECTS = 50;
const MAX_FIELDS = 20;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChangesRequest = { job: string } | { drift: string } | { record: string };

export function changesRequestFrom(params: URLSearchParams): ChangesRequest | null {
  const job = params.get("job");
  const drift = params.get("drift");
  const record = params.get("record");
  if (job && ID.test(job)) return { job };
  if (drift && ID.test(drift)) return { drift };
  if (record && /^\d{1,18}$/.test(record)) return { record };
  return null;
}

type Fields = { fields: { path: string; before: unknown; after: unknown }[]; fieldsTotal: number };

function settingsBetween(resourceType: string, before: unknown, after: unknown): Fields {
  const change = semanticChange({ resourceType, changeType: "modified", before, after, limit: MAX_FIELDS }) as {
    fields: { path: string; before?: unknown; after?: unknown }[]; total: number;
  };
  return { fields: change.fields.map((field) => ({ path: field.path, before: field.before ?? null, after: field.after ?? null })), fieldsTotal: change.total };
}

function presence(resourceType: string, payload: unknown, change: "added" | "removed"): Fields {
  const result = presenceFields(resourceType, payload, change) as Fields;
  return { fields: result.fields.map((field) => ({ path: field.path, before: field.before ?? null, after: field.after ?? null })), fieldsTotal: result.fieldsTotal };
}

const nameOf = (payload: unknown, resourceType: string): string | null => payloadName(payload, resourceType);

interface Draft extends Omit<ChangedObject, "name"> { naturalKey: string; name: string | null }

// Names: the payload's own, else the saved name of the key, else a plain stand-in.
async function finish(client: Client, ref: string, base: Omit<ActivityChanges, "changes" | "names" | "total">, drafts: Draft[], total: number, snapshots: (string | null)[]): Promise<ActivityChanges> {
  const shown = drafts.slice(0, MAX_CHANGED_OBJECTS);
  let saved: Record<string, { name?: string | null } | undefined> = {};
  const unnamed = shown.filter((draft) => !draft.name).map((draft) => draft.naturalKey);
  if (unnamed.length) {
    try { saved = await savedNames(client, ref, unnamed); } catch (error) { console.error("[keel-portal] activity change names unavailable", error); }
  }
  const names = await idNames(client, snapshots, shown.flatMap((draft) => draft.fields.flatMap((field) => [field.before, field.after])));
  return {
    ...base,
    total,
    names,
    changes: shown.map(({ naturalKey, name, ...rest }) => ({ ...rest, name: objectName(naturalKey, rest.resourceType, name ?? saved[naturalKey]?.name ?? null) })),
  };
}

interface DriftRow { natural_key: string; resource_type: string; change_type: string; before_payload: unknown; after_payload: unknown; observed_snapshot: string }

async function driftRows(client: Client, ref: string, ids: string[]): Promise<DriftRow[]> {
  const { rows } = await client.query(
    `SELECT natural_key, resource_type, change_type, before_payload, after_payload, observed_snapshot::text AS observed_snapshot
       FROM drift WHERE tenant_ref = $1 AND id = ANY($2::uuid[])
      ORDER BY resource_type, natural_key`,
    [ref, ids.filter((id) => ID.test(id))],
  );
  return rows as unknown as DriftRow[];
}

// A found change reads approved -> found; a roll back reads found -> put back.
function driftDraft(row: DriftRow, direction: "found" | "rollback"): Draft {
  const approved = row.before_payload;
  const found = row.after_payload;
  const [before, after] = direction === "found" ? [approved, found] : [found, approved];
  let change: ChangeKind = "changed";
  if (row.change_type === "added") change = direction === "found" ? "added" : "removed";
  if (row.change_type === "removed") change = direction === "found" ? "removed" : "added";
  const fields = change === "changed" ? settingsBetween(row.resource_type, before, after)
    : change === "added" ? presence(row.resource_type, after, "added") : presence(row.resource_type, before, "removed");
  return { naturalKey: row.natural_key, resourceType: row.resource_type, name: nameOf(found, row.resource_type) ?? nameOf(approved, row.resource_type), change, ...fields };
}

async function forDrift(client: Client, ref: string, id: string): Promise<ActivityChanges | null> {
  const rows = await driftRows(client, ref, [id]);
  if (!rows.length) return null;
  return finish(client, ref, {
    basis: "found",
    sides: { before: "Approved setup", after: "Found" },
    about: "Each setting as the approved setup has it, and as Keel found it in the tenant.",
    compare: null,
  }, rows.map((row) => driftDraft(row, "found")), rows.length, rows.map((row) => row.observed_snapshot));
}

async function forRollback(client: Client, ref: string, job: Record<string, unknown>): Promise<ActivityChanges | null> {
  const params = (job.params ?? {}) as Record<string, unknown>;
  const ids = (Array.isArray(params.driftIds) ? params.driftIds : []).filter((id): id is string => typeof id === "string");
  const rows = await driftRows(client, ref, ids);
  if (!rows.length) return null;
  const done = job.status === "succeeded";
  return finish(client, ref, {
    basis: "rollback",
    sides: { before: "As found", after: done ? "Put back to" : "Puts back to" },
    about: done
      ? "Each setting as Keel found it, and as the roll back put it back to match the approved setup."
      : "Each setting as Keel found it, and what the roll back puts back to match the approved setup.",
    compare: null,
  }, rows.map((row) => driftDraft(row, "rollback")), rows.length, rows.map((row) => row.observed_snapshot));
}

interface SnapshotRow { id: string; started_at: string; coverage_digest: unknown }

// Two backups compare when they read at least one kind in common: a backup of one tier
// against a backup of another tier would find nothing to compare.
function sharesKinds(a: unknown, b: unknown): boolean {
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return true;
  return Object.keys(a).some((type) => typeOutcome(a, type) !== "not-requested" && typeOutcome(b, type) !== "not-requested");
}

async function forBackup(client: Client, ref: string, job: Record<string, unknown>): Promise<ActivityChanges | null> {
  if (!job.started_at) return null;
  const { rows: [made] } = await client.query(
    `SELECT id::text AS id, started_at::text AS started_at, coverage_digest FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete'
        AND started_at >= $2::timestamptz - interval '1 minute' AND started_at <= COALESCE($3::timestamptz, now())
      ORDER BY started_at LIMIT 1`,
    [ref, job.started_at, job.finished_at ?? null],
  );
  if (!made) return null;
  const { rows: earlier } = await client.query(
    `SELECT id::text AS id, started_at::text AS started_at, coverage_digest FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete' AND started_at < $2::timestamptz AND id <> $3::uuid
      ORDER BY started_at DESC LIMIT 20`,
    [ref, made.started_at, made.id],
  );
  const previous = (earlier as unknown as SnapshotRow[]).find((row) => sharesKinds((made as unknown as SnapshotRow).coverage_digest, row.coverage_digest));
  const base = { basis: "backup" as const, sides: { before: "Previous backup", after: "This backup" } };
  if (!previous) {
    return { ...base, about: "This is the first backup of these kinds, so there is nothing earlier to compare it with.", changes: [], total: 0, names: {}, compare: null };
  }
  let result: CompareResult;
  try {
    result = await compareSnapshots(client, { leftSnapshotId: previous.id, rightSnapshotId: String(made.id), sections: ["settings"] }) as CompareResult;
  } catch (error) {
    if (error instanceof CompareError) return null;
    throw error;
  }
  const groups = result.settings?.groups ?? [];
  const drafts: Draft[] = groups.flatMap((group) => group.items.map((item) => ({
    naturalKey: item.naturalKey,
    resourceType: group.resourceType,
    name: item.name,
    change: item.changeType,
    fields: (item.fields ?? []).map((field) => ({ path: field.path, before: field.before, after: field.after })),
    fieldsTotal: item.fieldsTotal ?? item.fields?.length ?? 0,
  })));
  // Removed and changed first: they are the ones a person acts on.
  const order: Record<ChangeKind, number> = { removed: 0, changed: 1, added: 2 };
  drafts.sort((a, b) => order[a.change] - order[b.change]);
  const totals = result.settings?.totals;
  const total = totals ? totals.added + totals.removed + totals.changed : drafts.length;
  return finish(client, ref, {
    ...base,
    about: "Each setting as the backup before this one read it, and as this backup read it.",
    compare: { from: previous.id, to: String(made.id) },
  }, drafts, total, [previous.id, String(made.id)]);
}

async function forRestore(client: Client, ref: string, job: Record<string, unknown>): Promise<ActivityChanges | null> {
  const params = (job.params ?? {}) as Record<string, unknown>;
  let source: string | null = null;
  let keys: string[] = [];
  if (typeof params.artifactId === "string" && ID.test(params.artifactId)) {
    const { rows: [artifact] } = await client.query(
      `SELECT snapshot_id::text AS snapshot_id, selection FROM restore_dry_run WHERE id = $1::uuid AND tenant_ref = $2`,
      [params.artifactId, ref],
    );
    if (artifact) { source = String(artifact.snapshot_id); keys = Array.isArray(artifact.selection) ? artifact.selection.filter((key): key is string => typeof key === "string") : []; }
  } else if (typeof params.snapshotId === "string" && ID.test(params.snapshotId) && Array.isArray(params.selection)) {
    source = params.snapshotId;
    keys = params.selection.filter((key): key is string => typeof key === "string");
  }
  if (!source || !keys.length || typeof params.compensates === "string") return null;
  const { rows: [owned] } = await client.query(`SELECT 1 FROM snapshot WHERE id = $1::uuid AND tenant_ref = $2`, [source, ref]);
  if (!owned) return null;
  // "Before": the newest complete backup taken before the restore was asked for.
  const { rows: [prior] } = await client.query(
    `SELECT id::text AS id FROM snapshot WHERE tenant_ref = $1 AND status = 'complete' AND started_at < $2::timestamptz
      ORDER BY started_at DESC LIMIT 1`,
    [ref, job.created_at ?? new Date().toISOString()],
  );
  const read = async (snapshot: string) => {
    const { rows } = await client.query(
      `SELECT natural_key, resource_type, payload FROM resource_version WHERE snapshot_id = $1::uuid AND natural_key = ANY($2::text[])`,
      [snapshot, keys],
    );
    return new Map(rows.map((row) => [String(row.natural_key), row]));
  };
  const restored = await read(source);
  const before = prior ? await read(String(prior.id)) : new Map<string, Record<string, unknown>>();
  const drafts: Draft[] = [];
  for (const key of [...keys].sort()) {
    const to = restored.get(key);
    if (!to) continue;
    const type = String(to.resource_type);
    const from = before.get(key);
    if (!from) { drafts.push({ naturalKey: key, resourceType: type, name: nameOf(to.payload, type), change: "added", ...presence(type, to.payload, "added") }); continue; }
    const fields = settingsBetween(type, from.payload, to.payload);
    if (!fields.fieldsTotal) continue;
    drafts.push({ naturalKey: key, resourceType: type, name: nameOf(to.payload, type) ?? nameOf(from.payload, type), change: "changed", ...fields });
  }
  const done = job.status === "succeeded" && params.mode === "enforce";
  return finish(client, ref, {
    basis: "restore",
    sides: { before: "Before the restore", after: done ? "Restored to" : "Would restore to" },
    about: drafts.length
      ? "Each setting as the last backup before the restore read it, and as the restored backup has it."
      : "The restored settings match the last backup before the restore, so the restore had nothing to change in them.",
    compare: prior && String(prior.id) !== source ? { from: String(prior.id), to: source } : null,
  }, drafts, drafts.length, [source, prior ? String(prior.id) : null]);
}

// A rule edit or delete reads from its own audit record, which names each setting
// with its old and new value; nothing else is read.
export async function forRuleRecord(client: Client, ref: string, seq: string): Promise<ActivityChanges | null> {
  const { rows: [entry] } = await client.query(
    `SELECT subject FROM evidence WHERE tenant_ref = $1 AND seq = $2::bigint AND kind = 'policy-change'`,
    [ref, seq],
  );
  if (!entry) return null;
  const subject = (entry.subject ?? {}) as Record<string, unknown>;
  const deleted = subject.change === "deleted";
  const fields = ruleChangeFields(deleted ? "deleted" : "edited", subject.fields);
  const name = typeof subject.name === "string" && subject.name.trim() ? subject.name.trim() : "An automatic rule";
  return {
    basis: "rule",
    sides: { before: deleted ? "When deleted" : "Before", after: "After" },
    about: deleted
      ? "The rule's settings when it was deleted. Keel keeps the deleted rule as history; it no longer runs."
      : "Each rule setting that changed, as it was before the edit and as the edit saved it.",
    compare: null,
    total: 1,
    names: {},
    changes: [{ name, resourceType: "automaticRule", change: deleted ? "removed" : "changed", fields, fieldsTotal: fields.length }],
  };
}

export async function getActivityChanges(request: ChangesRequest): Promise<ActivityChanges | null> {
  const ref = tenantRef();
  const client = (await connect(databaseUrl())) as Client;
  try {
    if ("drift" in request) return await forDrift(client, ref, request.drift);
    if ("record" in request) return await forRuleRecord(client, ref, request.record);
    const { rows: [job] } = await client.query(
      `SELECT kind, status, params, created_at::text AS created_at, started_at::text AS started_at, finished_at::text AS finished_at FROM job WHERE id = $1::uuid`,
      [request.job],
    );
    if (!job) return null;
    if ((job.kind === "collect" || job.kind === "backup") && job.status === "succeeded") return await forBackup(client, ref, job);
    if (job.kind === "remediate") return await forRollback(client, ref, job);
    if (job.kind === "restore") return await forRestore(client, ref, job);
    return null;
  } finally {
    await client.end();
  }
}
