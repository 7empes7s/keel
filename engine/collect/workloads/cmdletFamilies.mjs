/**
 * Shared pieces for the read-only cmdlet workloads of Wave 1 (teamsExtended.mjs and
 * purviewExtended.mjs). Each of those declares its families: one Get cmdlet per
 * family, the fields KEEL keeps, and how an answer is identified. This module turns
 * one family's answer into observations, works out a run's outcome and stores the run,
 * the same way teamsPolicies.mjs and purviewRetentionDlp.mjs do for their families.
 *
 * Rules every caller inherits:
 *  - Declared fields only. Anything an answer carries beyond a family's fields is
 *    dropped unread. A field the answer lacks is `unknown`. A credential-shaped value is
 *    redacted by the shared telemetry redactor and marked `redacted`.
 *  - Identity is never guessed. An answer with no identity KEEL trusts is counted as
 *    unidentified and makes the run partial.
 *  - Duplicates are checked. An identity answered twice keeps the first copy; a second
 *    copy that disagrees on a declared field is a conflict and makes the run partial.
 */
import { CmdletError } from '../../powershell/jobQueue.mjs';
import { redactPayload } from '../../telemetry/events.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A Guid, lower-cased, or null when the value is not one. */
export const guidOf = (value) => {
  const id = String(value ?? '');
  return GUID.test(id) ? id.toLowerCase() : null;
};

// A Teams policy Identity: `Global` or `Tag:<name>` (administrator text, bounded).
// eslint-disable-next-line no-control-regex
const POLICY_IDENTITY = /^(global|tag:[^\u0000-\u001f\u007f]{1,256})$/;
/** A Teams policy identity, lower-cased (Teams compares them without case), or null. */
export function policyIdentityOf(value) {
  const identity = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return POLICY_IDENTITY.test(identity) ? identity : null;
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

// A session that does not expose a cmdlet (no licence, or no role granting it)
// answers with CommandNotFoundException.
const NOT_FOUND = /CommandNotFoundException|is not recognized as (?:the |a )?name of a cmdlet/i;
export function notExposed(error) {
  return error instanceof CmdletError && NOT_FOUND.test(`${error.detail.errorId ?? ''} ${error.detail.message ?? ''}`);
}

/** The declared fields of one answer, with each field's coverage. */
export function observeFields(fields, operation, body) {
  const entry = { fields: {}, fieldCoverage: {} };
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation };
      continue;
    }
    const redaction = { redactedFields: 0, seen: new WeakSet() };
    const clean = redactPayload(value, redaction);
    if (redaction.redactedFields > 0) {
      entry.fields[field] = clean;
      entry.fieldCoverage[field] = { status: 'redacted', operation, reason: 'the value looked like a credential and was not stored' };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation };
  }
  return entry;
}

/**
 * Turns one family's answer into resources. `spec` is { operation, prefix, fields,
 * identity(body) }; `extra(body)` adds per-resource metadata (a parent, say).
 * `kept` may be shared between calls so one family read in several calls (holds per
 * case) still keeps each identity once.
 */
export function objectsFrom(family, spec, output, { maxObjects, extra = () => ({}), kept = new Map(), count = { value: 0 } }) {
  const resources = [];
  const conflicts = [];
  let unidentified = 0;
  let capped = false;
  for (const body of output) {
    const identity = body && typeof body === 'object' ? spec.identity(body) : null;
    if (!identity) { unidentified += 1; continue; }
    if (kept.has(identity)) {
      const first = kept.get(identity);
      if (first) {
        const other = observeFields(spec.fields, spec.operation, body);
        const fields = Object.keys(first.fieldCoverage).filter((field) => canonical(first.fields[field]) !== canonical(other.fields[field]));
        if (fields.length) conflicts.push({ resourceKey: first.resourceKey, fields });
      }
      continue;
    }
    if (count.value >= maxObjects) { capped = true; kept.set(identity, null); continue; }
    count.value += 1;
    const resource = { resourceKey: `${spec.prefix}:${identity}`, kind: family, identity, ...extra(body), ...observeFields(spec.fields, spec.operation, body) };
    kept.set(identity, resource);
    resources.push(resource);
  }
  return { resources, conflicts, unidentified, capped };
}

/**
 * Which declared fields an answer did not carry, per family, with how many objects
 * lacked each, so a partial run names what it is missing (names only, never values).
 */
export function unknownFieldsOf(resources) {
  const unknownFields = {};
  for (const entry of resources) {
    for (const [field, coverage] of Object.entries(entry.fieldCoverage)) {
      if (coverage.status !== 'unknown') continue;
      const family = (unknownFields[entry.kind] ??= {});
      family[field] = (family[field] ?? 0) + 1;
    }
  }
  return unknownFields;
}

/** A family read that did not start or did not succeed, with nothing kept. */
export const emptyRead = (extra = {}) => ({ resources: [], conflicts: [], unidentified: 0, capped: false, failure: null, unavailable: null, ...extra });

/**
 * A run's outcome and digest from its family reads. `required` lists families that
 * can never be empty in a working tenant (Teams always has its Global policies), so an
 * empty answer there is a gap. `unparented` counts children whose parent is missing.
 */
export function summarize({ workload, families, reads, skipped = [], required = [], unparented = 0, maxObjects, observedFrom, observedTo }) {
  const resources = families.flatMap((family) => reads[family].resources);
  const failures = families.flatMap((family) => reads[family].failures ?? (reads[family].failure ? [reads[family].failure] : []));
  const unavailable = families.map((family) => reads[family].unavailable).filter(Boolean);
  const capped = families.some((family) => reads[family].capped);
  const unidentified = families.reduce((sum, family) => sum + reads[family].unidentified, 0);
  const conflicts = families.flatMap((family) => reads[family].conflicts);
  const empty = families.filter((family) => required.includes(family) && !reads[family].failure && !reads[family].unavailable && reads[family].resources.length === 0);
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const perFamily = Object.fromEntries(families.map((family) => {
    const read = reads[family];
    const status = read.failure ? read.failure.status : read.unavailable ? read.unavailable.status : (read.failures?.length ? 'partial' : 'read');
    return [family, { status, objects: read.resources.length }];
  }));
  let outcome;
  if (families.length > 0 && resources.length === 0
    && families.every((family) => reads[family].failure || reads[family].unavailable || reads[family].unidentified > 0)
    && families.some((family) => reads[family].failure || reads[family].unidentified > 0)) outcome = 'failed';
  else if (failures.length || unavailable.length || skipped.length || empty.length || capped || unidentified || unparented || conflicts.length
    || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else if (resources.length === 0) outcome = 'complete-empty';
  else outcome = 'complete';
  return {
    workload,
    outcome,
    observedFrom,
    observedTo,
    discovery: { families: perFamily, objects: resources.length, capped, unidentified, unparented, conflicts, empty, maxObjects, contentRead: false },
    resources,
    failures,
    unavailable,
    skipped,
    fieldCounts,
    unknownFields: unknownFieldsOf(resources),
  };
}

/** Each ledger row by operation id, and a sentence for one that is not enabled. */
export function ledgerRows(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const describe = (id) => {
    const row = rows.get(id);
    return `${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`;
  };
  return { rows, describe };
}

// Per-resource metadata stored beside the fields (never a declared field name).
const META = ['identity', 'kind', 'parent', 'parentStatus', 'case'];

/** Persists one run of `workload` in one transaction; one row per object. */
export async function recordCmdletRun(client, workload, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, workload, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        unknownFields: result.unknownFields ?? {},
        failures: result.failures ?? [],
        unavailable: result.unavailable ?? [],
        skipped: result.skipped ?? [],
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      const meta = Object.fromEntries(META.filter((key) => key in resource).map((key) => [key, resource[key]]));
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { ...meta, ...resource.fields }, resource.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** Records a `disabled` run: nothing was sent. */
export async function recordDisabledRun(client, workload, { tenantRef, reasons, now }) {
  const at = (now?.() ?? new Date()).toISOString();
  return recordCmdletRun(client, workload, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons } });
}
