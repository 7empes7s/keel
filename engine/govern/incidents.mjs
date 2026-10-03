// engine/govern/incidents.mjs
//
// Roadmap task-71: incident-qualified recovery points and retention pins.
//
// During a compromise the newest snapshot is the one most likely to carry the
// attacker's changes, so "restore the latest backup" is exactly wrong. Recovery
// points are therefore qualified per incident:
//
//  - an investigator records compromise intervals (when the tenant may have been
//    under attacker control) and assesses snapshots: clean (optionally with
//    malicious-field exclusions) or compromised. Assessments are append-only
//    versions; the newest is current;
//  - a point is `qualified` only by a current clean assessment. Compromised is
//    `unsuitable`; no assessment, or one made before the compromise window moved
//    across the snapshot, is `unassessed`. Pins never qualify anything;
//  - an unsuitable or unassessed point is selectable only through an explicit
//    investigator override with a reason, bound to the exact assessment state it was
//    made against; otherwise the restore is refused;
//  - the assessment version, fingerprint, exclusions and override are bound into the
//    restore plan digest, so any change after review invalidates promotion, and the
//    exclusions become post-restore checks;
//  - a retention pin keeps a snapshot from routine prune until an authorized release.
//
// Every read and write is tenant-scoped and every write re-checks the actor's
// CURRENT `investigate` grant against the database clock.
import { createHash } from 'node:crypto';

import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { appendEvidence } from './evidence.mjs';

export const INCIDENT_EVIDENCE_KIND = 'incident-recovery';
export const INCIDENT_CHECK_EVIDENCE_KIND = 'incident-recovery-check';
export const INVESTIGATE_CAPABILITY = 'investigate';

export const RECOVERY_POINT_STATUSES = Object.freeze(['qualified', 'unsuitable', 'unassessed']);
const VERDICTS = Object.freeze(['clean', 'compromised']);

export class IncidentAuthorizationError extends Error {
  constructor(message) { super(message); this.name = 'IncidentAuthorizationError'; }
}
export class IncidentNotFoundError extends Error {
  constructor(message) { super(message); this.name = 'IncidentNotFoundError'; }
}
export class IncidentValidationError extends Error {
  constructor(message) { super(message); this.name = 'IncidentValidationError'; }
}
export class IncidentRecoveryRefusal extends Error {
  constructor(message) { super(message); this.name = 'IncidentRecoveryRefusal'; }
}

// ------------------------------------------------------------------ helpers

function canonicalStringify(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of a configuration value (canonical JSON), so checks never copy the value itself. */
export function valueHash(value) {
  return sha256(canonicalStringify(value ?? null));
}

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new IncidentValidationError(`${name} is required`);
  }
  return value.trim();
}

// Grants are windowed by the database clock; check them against it (a JS Date
// truncates to milliseconds and can read a just-made grant as not yet active).
async function databaseNow(client) {
  const { rows } = await client.query('SELECT now()::text AS now');
  return rows[0].now;
}

async function holdsInvestigate(client, actorId, at) {
  const principal = await findPrincipalById(client, actorId);
  return Boolean(principal) && await can(client, principal, INVESTIGATE_CAPABILITY, at);
}

async function requireInvestigator(client, actorId) {
  const at = await databaseNow(client);
  if (!actorId || !(await holdsInvestigate(client, actorId, at))) {
    throw new IncidentAuthorizationError('only a principal currently holding investigate can change incident recovery state');
  }
  return at;
}

async function evidence(client, tenantRef, actor, subject) {
  await appendEvidence(client, { tenantRef, kind: INCIDENT_EVIDENCE_KIND, subject, actor });
}

async function loadIncidentRow(client, { tenantRef, incidentId }) {
  if (typeof incidentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(incidentId)) return null;
  const { rows } = await client.query('SELECT * FROM incident WHERE id = $1 AND tenant_ref = $2', [incidentId, tenantRef]);
  return rows[0] ?? null;
}

async function requireOpenIncident(client, { tenantRef, incidentId }) {
  const incident = await loadIncidentRow(client, { tenantRef, incidentId });
  if (!incident) throw new IncidentNotFoundError('incident not found');
  if (incident.status !== 'open') throw new IncidentValidationError('the incident is closed');
  return incident;
}

async function loadSnapshotRow(client, { tenantRef, snapshotId }) {
  if (typeof snapshotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(snapshotId)) return null;
  const { rows } = await client.query(
    'SELECT id, tenant_ref, started_at, completed_at, status FROM snapshot WHERE id = $1 AND tenant_ref = $2',
    [snapshotId, tenantRef],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------ pure qualification

function normalizeInterval(row) {
  return {
    id: row.id,
    tenantRef: row.tenant_ref ?? row.tenantRef,
    incidentId: row.incident_id ?? row.incidentId,
    startsAt: iso(row.starts_at ?? row.startsAt),
    endsAt: iso(row.ends_at ?? row.endsAt),
    reason: row.reason ?? null,
    recordedBy: row.recorded_by ?? row.recordedBy ?? null,
  };
}

function normalizeSnapshot(row) {
  return {
    id: row.id,
    tenantRef: row.tenant_ref ?? row.tenantRef,
    startedAt: iso(row.started_at ?? row.startedAt),
    completedAt: iso(row.completed_at ?? row.completedAt),
    status: row.status ?? null,
  };
}

/** Exclusions in canonical order with only their identity fields. */
export function normalizeExclusions(exclusions) {
  if (!Array.isArray(exclusions)) throw new IncidentValidationError('exclusions must be an array');
  const normalized = exclusions.map((exclusion) => {
    if (!exclusion || typeof exclusion !== 'object') throw new IncidentValidationError('each exclusion must be an object');
    const naturalKey = requireText(exclusion.naturalKey, 'exclusion naturalKey');
    const field = exclusion.field === undefined || exclusion.field === null || exclusion.field === ''
      ? null
      : requireText(exclusion.field, 'exclusion field');
    return { naturalKey, field, reason: requireText(exclusion.reason, 'exclusion reason') };
  });
  const seen = new Set();
  for (const exclusion of normalized) {
    const key = `${exclusion.naturalKey}|${exclusion.field ?? ''}`;
    if (seen.has(key)) throw new IncidentValidationError(`duplicate exclusion: ${key}`);
    seen.add(key);
  }
  return normalized.sort((a, b) => a.naturalKey.localeCompare(b.naturalKey)
    || String(a.field ?? '').localeCompare(String(b.field ?? '')));
}

function normalizeAssessment(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantRef: row.tenant_ref ?? row.tenantRef,
    incidentId: row.incident_id ?? row.incidentId,
    snapshotId: row.snapshot_id ?? row.snapshotId,
    version: Number(row.version),
    verdict: row.verdict,
    exclusions: normalizeExclusions(row.exclusions ?? []),
    inCompromiseWindow: Boolean(row.in_compromise_window ?? row.inCompromiseWindow),
    rationale: row.rationale ?? null,
    assessedBy: row.assessed_by ?? row.assessedBy ?? null,
    assessedAt: iso(row.assessed_at ?? row.assessedAt),
  };
}

/** The identity of one assessment version: everything a reviewer relied on —
 * including every exclusion — so any change yields a different fingerprint. */
export function assessmentFingerprint(assessment) {
  return sha256(canonicalStringify({
    incidentId: assessment.incidentId,
    snapshotId: assessment.snapshotId,
    version: assessment.version,
    verdict: assessment.verdict,
    exclusions: normalizeExclusions(assessment.exclusions ?? []),
    inCompromiseWindow: Boolean(assessment.inCompromiseWindow),
  }));
}

/** True when the snapshot's observation span [startedAt, completedAt] overlaps any
 * compromise interval [startsAt, endsAt) (an open interval runs to now). A tiered
 * observation spans time — it is never treated as one atomic instant. */
export function inCompromiseWindow(snapshot, intervals) {
  const from = new Date(snapshot.startedAt ?? snapshot.completedAt).getTime();
  const to = new Date(snapshot.completedAt ?? snapshot.startedAt).getTime();
  return intervals.some((interval) => {
    const start = new Date(interval.startsAt).getTime();
    const end = interval.endsAt ? new Date(interval.endsAt).getTime() : Infinity;
    return to >= start && from < end;
  });
}

/**
 * Qualify one snapshot as an incident recovery point. Pure: callers load the rows.
 * Only a current, in-scope, clean assessment qualifies. Rows from another tenant,
 * incident or snapshot are ignored (they can never qualify a point), and an
 * assessment whose recorded window status no longer matches the intervals is stale.
 */
export function qualifyRecoveryPoint({ tenantRef, incident, intervals = [], snapshot, assessment = null }) {
  const point = normalizeSnapshot(snapshot);
  if (!incident || (incident.tenant_ref ?? incident.tenantRef) !== tenantRef) {
    throw new IncidentRecoveryRefusal('incident-recovery-refused: the incident does not belong to this tenant');
  }
  if (point.tenantRef !== tenantRef) {
    throw new IncidentRecoveryRefusal('incident-recovery-refused: the snapshot does not belong to this tenant');
  }
  const scoped = intervals.map(normalizeInterval)
    .filter((interval) => interval.tenantRef === tenantRef && interval.incidentId === incident.id);
  const inWindow = inCompromiseWindow(point, scoped);
  const reasons = [];
  if (inWindow) reasons.push('observed during a compromise interval');

  let current = normalizeAssessment(assessment);
  if (current && (current.tenantRef !== tenantRef || current.incidentId !== incident.id || current.snapshotId !== point.id)) {
    reasons.push('an assessment from another tenant, incident or snapshot cannot qualify this point');
    current = null;
  }
  let status;
  let stale = false;
  if (!current) {
    status = 'unassessed';
    reasons.push('not assessed for this incident');
  } else if (current.inCompromiseWindow !== inWindow) {
    status = 'unassessed';
    stale = true;
    reasons.push(`assessment v${current.version} predates a compromise-interval change across this snapshot — reassess`);
  } else if (current.verdict === 'compromised') {
    status = 'unsuitable';
    reasons.push(`assessed compromised (v${current.version})`);
  } else {
    status = 'qualified';
    reasons.push(current.exclusions.length
      ? `assessed clean with ${current.exclusions.length} malicious-field exclusion(s) (v${current.version})`
      : `assessed clean (v${current.version})`);
  }
  return {
    snapshotId: point.id,
    observedFrom: point.startedAt,
    observedTo: point.completedAt,
    inCompromiseWindow: inWindow,
    status,
    stale,
    reasons,
    assessment: current && !stale
      ? { ...current, fingerprint: assessmentFingerprint(current) }
      : null,
  };
}

/** Newest first; `recommended` is the newest QUALIFIED point — never simply the newest. */
export function rankRecoveryPoints(points) {
  const ordered = [...points].sort((a, b) => String(b.observedTo ?? b.observedFrom)
    .localeCompare(String(a.observedTo ?? a.observedFrom)));
  const recommended = ordered.find((point) => point.status === 'qualified') ?? null;
  return { points: ordered, recommended: recommended?.snapshotId ?? null };
}

// ------------------------------------------------------------------ loaders

async function loadIntervals(client, { tenantRef, incidentId }) {
  const { rows } = await client.query(
    `SELECT * FROM incident_compromise_interval WHERE tenant_ref = $1 AND incident_id = $2 ORDER BY starts_at`,
    [tenantRef, incidentId],
  );
  return rows;
}

async function loadCurrentAssessment(client, { tenantRef, incidentId, snapshotId }) {
  const { rows } = await client.query(
    `SELECT * FROM incident_snapshot_assessment
      WHERE tenant_ref = $1 AND incident_id = $2 AND snapshot_id = $3
      ORDER BY version DESC LIMIT 1`,
    [tenantRef, incidentId, snapshotId],
  );
  return rows[0] ?? null;
}

async function loadActivePins(client, { tenantRef, incidentId = null }) {
  const { rows } = await client.query(
    `SELECT * FROM retention_pin
      WHERE tenant_ref = $1 AND released_at IS NULL AND ($2::uuid IS NULL OR incident_id = $2::uuid)
      ORDER BY pinned_at`,
    [tenantRef, incidentId],
  );
  return rows.map(normalizePin);
}

function normalizePin(row) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    snapshotId: row.snapshot_id,
    reason: row.reason,
    pinnedBy: row.pinned_by,
    pinnedAt: iso(row.pinned_at),
    releasedAt: iso(row.released_at),
    releasedBy: row.released_by ?? null,
    releaseReason: row.release_reason ?? null,
  };
}

function normalizeIncident(row) {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    status: row.status,
    openedAt: iso(row.opened_at),
    closedAt: iso(row.closed_at),
  };
}

/** Qualify one snapshot under one incident from the database. */
export async function qualifySnapshotForIncident(client, { tenantRef, incidentId, snapshotId }) {
  const incident = await loadIncidentRow(client, { tenantRef, incidentId });
  if (!incident) throw new IncidentNotFoundError('incident not found');
  const snapshot = await loadSnapshotRow(client, { tenantRef, snapshotId });
  if (!snapshot) throw new IncidentNotFoundError('snapshot not found');
  return {
    incident,
    point: qualifyRecoveryPoint({
      tenantRef,
      incident,
      intervals: await loadIntervals(client, { tenantRef, incidentId }),
      snapshot,
      assessment: await loadCurrentAssessment(client, { tenantRef, incidentId, snapshotId }),
    }),
  };
}

/** Every completed snapshot of the tenant qualified under one incident, newest first,
 * with the recommended (newest qualified) point, intervals and active pins. */
export async function listIncidentRecoveryPoints(client, { tenantRef, incidentId, limit = 50 }) {
  const incident = await loadIncidentRow(client, { tenantRef, incidentId });
  if (!incident) throw new IncidentNotFoundError('incident not found');
  const intervals = await loadIntervals(client, { tenantRef, incidentId });
  const { rows: snapshots } = await client.query(
    `SELECT id, tenant_ref, started_at, completed_at, status FROM snapshot
      WHERE tenant_ref = $1 AND status = 'complete'
      ORDER BY COALESCE(completed_at, started_at) DESC LIMIT $2`,
    [tenantRef, limit],
  );
  const { rows: assessments } = await client.query(
    `SELECT DISTINCT ON (snapshot_id) * FROM incident_snapshot_assessment
      WHERE tenant_ref = $1 AND incident_id = $2
      ORDER BY snapshot_id, version DESC`,
    [tenantRef, incidentId],
  );
  const bySnapshot = new Map(assessments.map((row) => [row.snapshot_id, row]));
  const pins = await loadActivePins(client, { tenantRef, incidentId });
  const pinned = new Set(pins.map((pin) => pin.snapshotId));
  const ranked = rankRecoveryPoints(snapshots.map((snapshot) => ({
    ...qualifyRecoveryPoint({ tenantRef, incident, intervals, snapshot, assessment: bySnapshot.get(snapshot.id) ?? null }),
    pinned: pinned.has(snapshot.id),
  })));
  return {
    incident: normalizeIncident(incident),
    intervals: intervals.map(normalizeInterval),
    pins,
    ...ranked,
  };
}

export async function listIncidents(client, { tenantRef }) {
  const { rows } = await client.query(
    'SELECT * FROM incident WHERE tenant_ref = $1 ORDER BY (status = \'open\') DESC, opened_at DESC LIMIT 100',
    [tenantRef],
  );
  return rows.map(normalizeIncident);
}

// ------------------------------------------------------------------- writes

export async function openIncident(client, { tenantRef, title, actorId }) {
  await requireInvestigator(client, actorId);
  const { rows } = await client.query(
    'INSERT INTO incident (tenant_ref, title, owner) VALUES ($1,$2,$3) RETURNING *',
    [tenantRef, requireText(title, 'title'), actorId],
  );
  await evidence(client, tenantRef, actorId, { transition: 'incident-opened', incidentId: rows[0].id });
  return normalizeIncident(rows[0]);
}

export async function closeIncident(client, { tenantRef, incidentId, actorId }) {
  await requireInvestigator(client, actorId);
  await requireOpenIncident(client, { tenantRef, incidentId });
  const { rows } = await client.query(
    `UPDATE incident SET status = 'closed', closed_at = now(), closed_by = $3
      WHERE id = $1 AND tenant_ref = $2 AND status = 'open' RETURNING *`,
    [incidentId, tenantRef, actorId],
  );
  await evidence(client, tenantRef, actorId, { transition: 'incident-closed', incidentId });
  return normalizeIncident(rows[0]);
}

/** @param {any} client
 * @param {{ tenantRef: string, incidentId: string, startsAt: string, endsAt?: string | null, reason: string, actorId: string }} options */
export async function recordCompromiseInterval(client, { tenantRef, incidentId, startsAt, endsAt = null, reason, actorId }) {
  await requireInvestigator(client, actorId);
  await requireOpenIncident(client, { tenantRef, incidentId });
  const start = iso(startsAt);
  const end = endsAt === null || endsAt === undefined || endsAt === '' ? null : iso(endsAt);
  if (!start) throw new IncidentValidationError('startsAt must be a timestamp');
  if (endsAt && !end) throw new IncidentValidationError('endsAt must be a timestamp');
  if (end && end <= start) throw new IncidentValidationError('endsAt must be after startsAt');
  const { rows } = await client.query(
    `INSERT INTO incident_compromise_interval (tenant_ref, incident_id, starts_at, ends_at, reason, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenantRef, incidentId, start, end, requireText(reason, 'reason'), actorId],
  );
  await evidence(client, tenantRef, actorId, {
    transition: 'compromise-interval-recorded', incidentId, intervalId: rows[0].id, startsAt: start, endsAt: end,
  });
  return normalizeInterval(rows[0]);
}

/**
 * Record a new assessment version for one snapshot. Exclusions name malicious
 * resources (naturalKey) or fields (naturalKey + dot path) the snapshot carries;
 * each must exist in that snapshot, so an exclusion can never silently match nothing.
 */
export async function assessSnapshot(client, {
  tenantRef, incidentId, snapshotId, verdict, exclusions = [], rationale, actorId,
}) {
  await requireInvestigator(client, actorId);
  await requireOpenIncident(client, { tenantRef, incidentId });
  if (!VERDICTS.includes(verdict)) throw new IncidentValidationError(`verdict must be one of ${VERDICTS.join(', ')}`);
  const snapshot = await loadSnapshotRow(client, { tenantRef, snapshotId });
  if (!snapshot) throw new IncidentNotFoundError('snapshot not found');
  const normalized = normalizeExclusions(exclusions);
  if (verdict === 'compromised' && normalized.length > 0) {
    throw new IncidentValidationError('a compromised verdict refuses the whole point — exclusions apply only to a clean verdict');
  }
  if (normalized.length > 0) {
    const { rows: versions } = await client.query(
      'SELECT natural_key, payload FROM resource_version WHERE snapshot_id = $1 AND natural_key = ANY($2::text[])',
      [snapshotId, normalized.map((exclusion) => exclusion.naturalKey)],
    );
    const payloads = new Map(versions.map((row) => [row.natural_key, row.payload]));
    for (const exclusion of normalized) {
      if (!payloads.has(exclusion.naturalKey)) {
        throw new IncidentValidationError(`exclusion ${exclusion.naturalKey} is not in this snapshot`);
      }
      if (exclusion.field && readPath(payloads.get(exclusion.naturalKey), exclusion.field) === undefined) {
        throw new IncidentValidationError(`exclusion ${exclusion.naturalKey} field ${exclusion.field} is not in this snapshot`);
      }
    }
  }
  const intervals = await loadIntervals(client, { tenantRef, incidentId });
  const inWindow = inCompromiseWindow(normalizeSnapshot(snapshot), intervals.map(normalizeInterval));
  const { rows } = await client.query(
    `INSERT INTO incident_snapshot_assessment
       (tenant_ref, incident_id, snapshot_id, version, verdict, exclusions, in_compromise_window, rationale, assessed_by)
     SELECT $1, $2, $3, COALESCE(MAX(version), 0) + 1, $4, $5, $6, $7, $8
       FROM incident_snapshot_assessment WHERE incident_id = $2 AND snapshot_id = $3
     RETURNING *`,
    [tenantRef, incidentId, snapshotId, verdict, JSON.stringify(normalized), inWindow, requireText(rationale, 'rationale'), actorId],
  );
  const assessment = normalizeAssessment(rows[0]);
  const fingerprint = assessmentFingerprint(assessment);
  await evidence(client, tenantRef, actorId, {
    transition: 'snapshot-assessed', incidentId, snapshotId, version: assessment.version, verdict, fingerprint,
    exclusions: normalized.map(({ naturalKey, field }) => ({ naturalKey, field })),
  });
  return { ...assessment, fingerprint };
}

/** An investigator's explicit, reasoned authorization to recover from a point that is
 * unsuitable or unassessed — bound to the assessment state it was made against. A
 * qualified point needs no override and is refused one. */
export async function authorizeRecoveryOverride(client, { tenantRef, incidentId, snapshotId, reason, actorId }) {
  await requireInvestigator(client, actorId);
  await requireOpenIncident(client, { tenantRef, incidentId });
  const { point } = await qualifySnapshotForIncident(client, { tenantRef, incidentId, snapshotId });
  if (point.status === 'qualified') throw new IncidentValidationError('this point is already qualified — no override is needed');
  const binding = await overrideBinding(client, { tenantRef, incidentId, snapshotId, point });
  const { rows } = await client.query(
    `INSERT INTO incident_recovery_override
       (tenant_ref, incident_id, snapshot_id, assessment_fingerprint, in_compromise_window, reason, authorized_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [tenantRef, incidentId, snapshotId, binding.assessmentFingerprint, binding.inCompromiseWindow, requireText(reason, 'reason'), actorId],
  );
  await evidence(client, tenantRef, actorId, {
    transition: 'recovery-override-authorized', incidentId, snapshotId, overrideId: rows[0].id, status: point.status,
  });
  return rows[0];
}

export async function revokeRecoveryOverride(client, { tenantRef, overrideId, actorId }) {
  await requireInvestigator(client, actorId);
  const { rows } = await client.query(
    `UPDATE incident_recovery_override SET revoked_at = now(), revoked_by = $3
      WHERE id::text = $1 AND tenant_ref = $2 AND revoked_at IS NULL RETURNING *`,
    [overrideId, tenantRef, actorId],
  );
  if (!rows[0]) throw new IncidentNotFoundError('override not found');
  await evidence(client, tenantRef, actorId, { transition: 'recovery-override-revoked', overrideId });
  return rows[0];
}

// What an override binds to: the current assessment version's fingerprint (even a
// stale or compromised one) or null when nothing is assessed, plus whether the point
// lies in a compromise window. A new assessment version or a window change across the
// point voids the override.
async function overrideBinding(client, { tenantRef, incidentId, snapshotId, point }) {
  const raw = normalizeAssessment(await loadCurrentAssessment(client, { tenantRef, incidentId, snapshotId }));
  return {
    assessmentFingerprint: raw && raw.tenantRef === tenantRef ? assessmentFingerprint(raw) : null,
    inCompromiseWindow: point.inCompromiseWindow,
  };
}

export async function pinSnapshot(client, { tenantRef, incidentId, snapshotId, reason, actorId }) {
  await requireInvestigator(client, actorId);
  await requireOpenIncident(client, { tenantRef, incidentId });
  if (!(await loadSnapshotRow(client, { tenantRef, snapshotId }))) throw new IncidentNotFoundError('snapshot not found');
  const { rows } = await client.query(
    `INSERT INTO retention_pin (tenant_ref, incident_id, snapshot_id, reason, pinned_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (incident_id, snapshot_id) WHERE released_at IS NULL DO NOTHING
     RETURNING *`,
    [tenantRef, incidentId, snapshotId, requireText(reason, 'reason'), actorId],
  );
  if (!rows[0]) throw new IncidentValidationError('this snapshot is already pinned for this incident');
  await evidence(client, tenantRef, actorId, { transition: 'retention-pinned', incidentId, snapshotId, pinId: rows[0].id });
  return normalizePin(rows[0]);
}

/** Authorized release: a current investigator with a reason. Releasing a pin only
 * returns the snapshot to routine retention; it does not delete anything itself. */
export async function releasePin(client, { tenantRef, pinId, reason, actorId }) {
  await requireInvestigator(client, actorId);
  const { rows } = await client.query(
    `UPDATE retention_pin SET released_at = now(), released_by = $3, release_reason = $4
      WHERE id::text = $1 AND tenant_ref = $2 AND released_at IS NULL RETURNING *`,
    [pinId, tenantRef, actorId, requireText(reason, 'reason')],
  );
  if (!rows[0]) throw new IncidentNotFoundError('active pin not found');
  await evidence(client, tenantRef, actorId, {
    transition: 'retention-pin-released', incidentId: rows[0].incident_id, snapshotId: rows[0].snapshot_id, pinId: rows[0].id,
  });
  return normalizePin(rows[0]);
}

// ---------------------------------------------------------- restore binding

/** Open incidents whose compromise intervals overlap the snapshot. A restore from such
 * a snapshot must run under one of them, so the incident gate cannot be sidestepped
 * by simply not naming the incident. */
export async function incidentsCoveringSnapshot(client, { tenantRef, snapshotId }) {
  const snapshot = await loadSnapshotRow(client, { tenantRef, snapshotId });
  if (!snapshot) return [];
  const { rows } = await client.query(
    `SELECT i.id, ci.tenant_ref, ci.incident_id, ci.starts_at, ci.ends_at
       FROM incident i JOIN incident_compromise_interval ci ON ci.incident_id = i.id AND ci.tenant_ref = i.tenant_ref
      WHERE i.tenant_ref = $1 AND i.status = 'open'`,
    [tenantRef],
  );
  const point = normalizeSnapshot(snapshot);
  return [...new Set(rows
    .filter((row) => inCompromiseWindow(point, [normalizeInterval(row)]))
    .map((row) => row.id))].sort();
}

/**
 * The incident recovery context of a restore: re-derived from the database every
 * time (dry run AND promotion). A qualified point proceeds; an unsuitable or
 * unassessed point proceeds only under a valid override — bound to the current
 * assessment state, not revoked, authorized by someone other than the requester who
 * CURRENTLY holds investigate. Anything else is refused.
 */
export async function resolveIncidentRecovery(client, { tenantRef, incidentId, snapshotId, requestedBy }) {
  const incident = await loadIncidentRow(client, { tenantRef, incidentId });
  if (!incident) throw new IncidentRecoveryRefusal(`incident-recovery-refused: incident ${incidentId} not found for this tenant`);
  const snapshot = await loadSnapshotRow(client, { tenantRef, snapshotId });
  if (!snapshot) throw new IncidentRecoveryRefusal(`incident-recovery-refused: snapshot ${snapshotId} not found for this tenant`);
  const intervals = await loadIntervals(client, { tenantRef, incidentId });
  const assessmentRow = await loadCurrentAssessment(client, { tenantRef, incidentId, snapshotId });
  const point = qualifyRecoveryPoint({ tenantRef, incident, intervals, snapshot, assessment: assessmentRow });
  const rawAssessment = normalizeAssessment(assessmentRow);
  const binding = await overrideBinding(client, { tenantRef, incidentId, snapshotId, point });
  const rawFingerprint = binding.assessmentFingerprint;

  let override = null;
  if (point.status !== 'qualified') {
    const at = await databaseNow(client);
    const { rows } = await client.query(
      `SELECT * FROM incident_recovery_override
        WHERE tenant_ref = $1 AND incident_id = $2 AND snapshot_id = $3 AND revoked_at IS NULL
          AND assessment_fingerprint IS NOT DISTINCT FROM $4 AND in_compromise_window = $5
        ORDER BY authorized_at DESC`,
      [tenantRef, incidentId, snapshotId, rawFingerprint, binding.inCompromiseWindow],
    );
    for (const row of rows) {
      if (requestedBy !== undefined && requestedBy !== null && String(row.authorized_by) === String(requestedBy)) continue;
      if (await holdsInvestigate(client, row.authorized_by, at)) {
        override = { id: row.id, reason: row.reason, authorizedBy: row.authorized_by };
        break;
      }
    }
    if (!override) {
      throw new IncidentRecoveryRefusal(
        `incident-recovery-refused: snapshot ${snapshotId} is ${point.status} for incident ${incidentId} (${point.reasons.join('; ')}) — `
        + 'choose a qualified recovery point, or an investigator other than the requester must authorize an override with a reason',
      );
    }
  }
  const exclusions = point.status === 'qualified' ? point.assessment.exclusions : [];
  return {
    incidentId,
    snapshotId,
    status: point.status,
    qualification: override ? 'overridden' : 'qualified',
    inCompromiseWindow: point.inCompromiseWindow,
    reasons: point.reasons,
    assessment: rawAssessment
      ? { id: rawAssessment.id, version: rawAssessment.version, verdict: rawAssessment.verdict, fingerprint: rawFingerprint }
      : null,
    exclusions,
    override,
  };
}

function readPath(payload, path) {
  let value = payload;
  for (const segment of String(path).split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function withoutPath(payload, path) {
  const [head, ...rest] = String(path).split('.');
  if (payload === null || typeof payload !== 'object' || !Object.hasOwn(payload, head)) return payload;
  const copy = { ...payload };
  if (rest.length === 0) delete copy[head];
  else copy[head] = withoutPath(copy[head], rest.join('.'));
  return copy;
}

/**
 * Apply the assessment's exclusions to the restore's resources (the snapshot's
 * versions in wave-planner shape). A whole-resource exclusion inside the closure is a
 * refusal — restoring around it would leave a dangling reference or restore the
 * malicious object. A field exclusion removes that field from what is written (the
 * resource is never mutated; a copy carries a recomputed hash). Returns the
 * post-restore checks the exclusions become.
 */
export function applyIncidentExclusions(resources, exclusions, { hash }) {
  const keys = new Set(resources.map((resource) => resource.naturalKey));
  const whole = exclusions.filter((exclusion) => exclusion.field === null);
  const blocked = whole.filter((exclusion) => keys.has(exclusion.naturalKey));
  if (blocked.length > 0) {
    throw new IncidentRecoveryRefusal(
      `incident-recovery-refused: the restore closure includes ${blocked.map((e) => e.naturalKey).join(', ')}, excluded as malicious by the assessment — deselect it and anything that requires it`,
    );
  }
  const fields = exclusions.filter((exclusion) => exclusion.field !== null);
  const checks = whole.map((exclusion) => ({
    naturalKey: exclusion.naturalKey, field: null, expectation: 'absent', reason: exclusion.reason,
  }));
  const out = resources.map((resource) => {
    const own = fields.filter((exclusion) => exclusion.naturalKey === resource.naturalKey);
    if (own.length === 0) return resource;
    let payload = resource.payload;
    for (const exclusion of own) {
      const malicious = readPath(resource.payload, exclusion.field);
      checks.push({
        naturalKey: exclusion.naturalKey,
        field: exclusion.field,
        expectation: 'not-equal',
        valueHash: valueHash(malicious),
        reason: exclusion.reason,
      });
      payload = withoutPath(payload, exclusion.field);
    }
    return { ...resource, payload, payloadHash: hash(payload, resource.resourceType), excludedFields: own.map((e) => e.field) };
  });
  // Field exclusions on resources outside the closure are still checked: the malicious
  // value must not be live after recovery either.
  for (const exclusion of fields.filter((e) => !keys.has(e.naturalKey))) {
    checks.push({
      naturalKey: exclusion.naturalKey, field: exclusion.field, expectation: 'not-equal', valueHash: null, reason: exclusion.reason,
    });
  }
  checks.sort((a, b) => a.naturalKey.localeCompare(b.naturalKey) || String(a.field ?? '').localeCompare(String(b.field ?? '')));
  return { resources: out, checks };
}

/** What the plan digest binds: the qualification, the assessment identity (version +
 * fingerprint, which covers every exclusion), the exclusions themselves, the override
 * and the post-restore checks. */
export function incidentRecoveryDigestInput(context) {
  return {
    incidentId: context.incidentId,
    snapshotId: context.snapshotId,
    status: context.status,
    qualification: context.qualification,
    inCompromiseWindow: context.inCompromiseWindow,
    assessment: context.assessment,
    exclusions: context.exclusions,
    override: context.override,
    postRestoreChecks: context.postRestoreChecks ?? [],
  };
}

/**
 * Post-restore checks against a FRESH read of the target. An excluded malicious
 * resource must be absent; an excluded malicious field must not hold the excluded
 * value. Absence proves nothing about a type the read did not cover
 * (`collectedTypes`; a natural key's type is its prefix), so such a check — and one
 * whose value could not be resolved from the snapshot — is reported as unverified,
 * never as passed.
 */
export function evaluatePostRestoreChecks(checks, targetResources, { collectedTypes = null } = {}) {
  const byKey = new Map(targetResources.map((resource) => [resource.naturalKey, resource]));
  const covered = new Set([...(collectedTypes ?? []), ...targetResources.map((resource) => resource.resourceType)]);
  const typeOf = (naturalKey) => String(naturalKey).split(':')[0];
  return checks.map((check) => {
    const live = byKey.get(check.naturalKey);
    if (!live && !covered.has(typeOf(check.naturalKey))) {
      return { ...check, outcome: 'unverified', detail: `the post-restore read does not cover ${typeOf(check.naturalKey)}; verify by hand` };
    }
    if (check.expectation === 'absent') {
      return live
        ? { ...check, outcome: 'failed', detail: `excluded malicious resource ${check.naturalKey} is present in the target after recovery` }
        : { ...check, outcome: 'passed', detail: 'absent from the target' };
    }
    if (!live) return { ...check, outcome: 'passed', detail: 'resource absent from the target' };
    if (!check.valueHash) {
      return { ...check, outcome: 'unverified', detail: 'the excluded value is not in the restored scope; verify by hand' };
    }
    const current = readPath(live.payload, check.field);
    return current !== undefined && valueHash(current) === check.valueHash
      ? { ...check, outcome: 'failed', detail: `excluded malicious value is live at ${check.naturalKey} ${check.field} after recovery` }
      : { ...check, outcome: 'passed', detail: 'the excluded value is not live' };
  });
}

export async function recordPostRestoreChecks(client, { tenantRef, artifactId, incidentId, results, actor }) {
  await appendEvidence(client, {
    tenantRef,
    kind: INCIDENT_CHECK_EVIDENCE_KIND,
    subject: {
      artifactId,
      incidentId,
      checks: results.map(({ naturalKey, field, expectation, outcome }) => ({ naturalKey, field, expectation, outcome })),
    },
    actor,
  });
}
