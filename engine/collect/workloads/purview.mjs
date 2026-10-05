/**
 * Roadmap task-106: the Purview sensitivity label configuration read adapter.
 *
 * Two observation families, each its own task-101 operation:
 *  - label definitions (`purview.label-definitions`, Get-Label): one observation per
 *    label, keyed by its immutable id;
 *  - label publishing policies (`purview.label-publication`, Get-LabelPolicy): one
 *    observation per policy, with the labels it publishes and where.
 *
 * Rules:
 *  - Definitions, never labeled content. The inventory is the tenant's label
 *    DEFINITIONS. KEEL never lists files, mail or sites to see which carry a label,
 *    never reads an item-applied label, and never counts label usage. Only the two
 *    Get cmdlets above run, with no parameters; anything a definition answer carries
 *    beyond the declared fields is dropped unread.
 *  - Changes are tracked between runs. trackLabelChanges() compares each label and
 *    policy with the previous recorded run, field by field, and the run records which
 *    were added, removed or changed. That comparison uses the recorded definitions
 *    only; it reads nothing new.
 *  - Locks are observed. A definition answer that reports a preservation lock
 *    (`RestrictiveRetention`, `IsPreservationLocked`, `PreservationLock`) marks the
 *    object `locked`; one that reports none is `not-reported`, which is not proof of
 *    no lock. The restore refuses to change a locked object.
 *  - Its own qualification. Purview runs in the Security & Compliance session of the
 *    ExchangeOnlineManagement module; Exchange proof is never Purview proof.
 *    Activation needs Exchange qualified first AND both Purview rows enabled.
 */
import { createHash } from 'node:crypto';

import { registerWorkload } from '../registry.mjs';
import { runCmdlet } from '../../powershell/jobQueue.mjs';
import { exchangeActivation, structuredFailure } from './exchange.mjs';

export const PURVIEW_WORKLOAD = 'purview-labels';
export const PURVIEW_MODULE = 'ExchangeOnlineManagement';
export const PURVIEW_OPERATIONS = Object.freeze(['purview.label-definitions', 'purview.label-publication']);
export const DEFAULT_MAX_OBJECTS = 500;

/** The registry descriptor. `enabledByDefault: false` until live qualification. */
export const PURVIEW_DESCRIPTOR = Object.freeze({
  type: 'purviewLabel',
  workload: PURVIEW_WORKLOAD,
  adapter: 'purview-labels',
  readOnly: true,
  enabledByDefault: false,
  operations: PURVIEW_OPERATIONS,
});

// What each observation keeps. Declared from the Get-Label, Set-Label,
// Get-LabelPolicy and Set-LabelPolicy documentation; not measured against a tenant.
export const LABEL_FIELDS = Object.freeze([
  'Name', 'DisplayName', 'ParentId', 'Priority', 'ContentType', 'Disabled', 'Tooltip', 'Comment',
  'EncryptionEnabled', 'EncryptionProtectionType', 'EncryptionOfflineAccessDays',
  'ApplyContentMarkingHeaderEnabled', 'ApplyContentMarkingFooterEnabled', 'ApplyWaterMarkingEnabled',
  'SiteAndGroupProtectionEnabled', 'SiteAndGroupProtectionPrivacy', 'SiteAndGroupProtectionAllowAccessToGuestUsers',
  'SiteExternalSharingControlType', 'WhenChangedUTC',
]);
// Live Get-Label (ExchangeOnlineManagement 3.10.1, 2026-10-05) returns none of these as
// properties: protection settings live in LabelActions, which KEEL does not read yet. They
// stay declared so a module that does return them is compared, but a live gate qualifies
// them only when observed, and otherwise records them as not qualified.
export const LABEL_ACTION_FIELDS = Object.freeze([
  'EncryptionEnabled', 'EncryptionProtectionType', 'EncryptionOfflineAccessDays',
  'ApplyContentMarkingHeaderEnabled', 'ApplyContentMarkingFooterEnabled', 'ApplyWaterMarkingEnabled',
  'SiteAndGroupProtectionEnabled', 'SiteAndGroupProtectionPrivacy', 'SiteAndGroupProtectionAllowAccessToGuestUsers',
  'SiteExternalSharingControlType',
]);
export const POLICY_FIELDS = Object.freeze([
  'Name', 'Enabled', 'Mode', 'Priority', 'Labels',
  'ExchangeLocation', 'ModernGroupLocation', 'SharePointLocation', 'OneDriveLocation',
  'Settings', 'WhenChangedUTC',
]);
// Platform preservation-lock markers. Read when present; never inferred.
export const LOCK_MARKERS = Object.freeze(['RestrictiveRetention', 'IsPreservationLocked', 'PreservationLock']);
// Fields that change on every save and say nothing about the configuration itself.
const VOLATILE = new Set(['WhenChangedUTC']);

export const PURVIEW_GROUPS = Object.freeze({
  label: Object.freeze({ fields: LABEL_FIELDS, operation: 'purview.label-definitions', cmdlet: 'Get-Label', prefix: 'label' }),
  policy: Object.freeze({ fields: POLICY_FIELDS, operation: 'purview.label-publication', cmdlet: 'Get-LabelPolicy', prefix: 'label-policy' }),
});

// Never requested, never stored, never counted as configuration.
export const PURVIEW_EXCLUDED_CONTENT = Object.freeze([
  'itemAppliedLabels', 'labelUsagePerItem', 'contentExplorer', 'activityExplorer', 'autoLabelingMatches',
  'labeledFiles', 'labeledMessages', 'perFilePermissions',
]);

// The only cmdlets this workload runs, and the only parameters each may receive.
// ops/powershell/run-cmdlet.ps1 ($AllowedPurview) holds the same list and checks it again.
export const PURVIEW_CMDLET_PARAMETERS = Object.freeze({
  'Get-Label': Object.freeze([]),
  'Get-LabelPolicy': Object.freeze([]),
  'Set-Label': Object.freeze(['Identity', 'DisplayName', 'Tooltip', 'Comment']),
  'Set-LabelPolicy': Object.freeze(['Identity', 'AddLabels']),
});
export const PURVIEW_CMDLETS = new Set(Object.keys(PURVIEW_CMDLET_PARAMETERS));

export class PurviewScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PurviewScopeError';
  }
}

/** Throws unless the cmdlet and every parameter name are allowlisted. */
export function assertPurviewCmdlet({ cmdlet, parameters = {} }) {
  const allowed = PURVIEW_CMDLET_PARAMETERS[cmdlet];
  if (!allowed) throw new PurviewScopeError(`${cmdlet} is not a Purview label configuration cmdlet KEEL runs; labeled items, usage and content are never read`);
  for (const name of Object.keys(parameters)) {
    if (!allowed.includes(name)) throw new PurviewScopeError(`${cmdlet} does not take ${name} from KEEL`);
  }
  return true;
}

/** Runs one Purview cmdlet through the bounded job transport. */
export async function purviewCmdlet({ cmdlet, parameters = {} }, powershell = {}) {
  assertPurviewCmdlet({ cmdlet, parameters });
  const { tenantConfigPath = null, ...options } = powershell;
  return runCmdlet({ module: PURVIEW_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: PURVIEW_CMDLETS });
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The immutable id of a label or policy answer; null when it has none KEEL trusts. */
export function objectId(body) {
  const id = String(body?.ImmutableId ?? body?.Guid ?? '');
  return GUID.test(id) ? id.toLowerCase() : null;
}
export const labelKey = (id) => `label:${String(id).toLowerCase()}`;
export const policyKey = (id) => `label-policy:${String(id).toLowerCase()}`;

/** `locked`, `unlocked` or `not-reported`, from the markers the answer carries. */
export function lockState(body) {
  const present = LOCK_MARKERS.filter((marker) => body?.[marker] !== undefined && body?.[marker] !== null);
  if (present.length === 0) return 'not-reported';
  return present.some((marker) => body[marker] === true || body[marker] === 'True' || body[marker] === 'true') ? 'locked' : 'unlocked';
}

function observeObject(group, body) {
  const { fields, operation } = PURVIEW_GROUPS[group];
  const entry = { id: objectId(body), fields: {}, fieldCoverage: {}, lock: lockState(body) };
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) {
      entry.fieldCoverage[field] = { status: 'unknown', operation };
      continue;
    }
    entry.fields[field] = value;
    entry.fieldCoverage[field] = { status: 'observed', operation };
  }
  return entry;
}

/** Reads one family. Returns { resources, failure }: a failure covers the whole family. */
async function readFamily(group, { powershell, maxObjects }) {
  const { cmdlet, prefix } = PURVIEW_GROUPS[group];
  let output;
  try {
    ({ output } = await purviewCmdlet({ cmdlet }, powershell));
  } catch (error) {
    return { resources: [], failure: { group, operation: PURVIEW_GROUPS[group].operation, ...structuredFailure(error) }, capped: false, unidentified: 0 };
  }
  const resources = [];
  const seen = new Set();
  let unidentified = 0;
  let capped = false;
  for (const body of output) {
    const id = objectId(body);
    if (!id) { unidentified += 1; continue; }
    if (seen.has(id)) continue;
    if (resources.length >= maxObjects) { capped = true; continue; }
    seen.add(id);
    resources.push({ resourceKey: `${prefix}:${id}`, kind: group, ...observeObject(group, body) });
  }
  return { resources, failure: null, capped, unidentified };
}

const canonical = (value) => JSON.stringify(value ?? null, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.keys(inner).sort().map((key) => [key, inner[key]]))
  : inner));

/** The configuration identity of one observation: observed, non-volatile fields only. */
export function definitionFingerprint(observation) {
  const kept = {};
  for (const [field, coverage] of Object.entries(observation?.fieldCoverage ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (VOLATILE.has(field)) continue;
    kept[field] = coverage?.status === 'observed' ? { value: observation.fields?.[field] ?? null } : { status: coverage?.status ?? 'unknown' };
  }
  return createHash('sha256').update(canonical(kept)).digest('hex');
}

/**
 * Compares the label and policy definitions of two runs. `previous` and `current`
 * are lists of { resourceKey, fields, fieldCoverage }. A field is compared only when
 * both runs observed it; a field observed on one side only is listed as unknown.
 * Returns { added, removed, changed: [{ resourceKey, fields: [...] , unknown: [...] }] }.
 */
export function trackLabelChanges(previous, current) {
  const before = new Map((previous ?? []).map((item) => [item.resourceKey, item]));
  const after = new Map((current ?? []).map((item) => [item.resourceKey, item]));
  const added = [...after.keys()].filter((key) => !before.has(key)).sort();
  const removed = [...before.keys()].filter((key) => !after.has(key)).sort();
  const changed = [];
  for (const [key, now] of after) {
    const then = before.get(key);
    if (!then) continue;
    const fields = [];
    const unknown = [];
    const names = new Set([...Object.keys(then.fieldCoverage ?? {}), ...Object.keys(now.fieldCoverage ?? {})]);
    for (const field of [...names].sort()) {
      if (VOLATILE.has(field)) continue;
      const b = then.fieldCoverage?.[field]?.status;
      const a = now.fieldCoverage?.[field]?.status;
      if (b !== 'observed' || a !== 'observed') {
        if (b !== a) unknown.push(field);
        continue;
      }
      if (canonical(then.fields?.[field]) !== canonical(now.fields?.[field])) fields.push(field);
    }
    if (fields.length || unknown.length) changed.push({ resourceKey: key, fields, unknown });
  }
  return { added, removed, changed };
}

/**
 * Reads both families. Pure apart from the injected PowerShell options: no
 * database, no gate. `previous` is the prior run's observations, for change
 * tracking. Callers outside tests use collectPurview.
 */
export async function readPurview({ powershell = {}, previous = null, maxObjects = DEFAULT_MAX_OBJECTS, now = () => new Date() }) {
  const observedFrom = now().toISOString();
  const labels = await readFamily('label', { powershell, maxObjects });
  const policies = await readFamily('policy', { powershell, maxObjects });
  const resources = [...labels.resources, ...policies.resources];
  const failures = [labels.failure, policies.failure].filter(Boolean);
  const statuses = resources.flatMap((entry) => Object.values(entry.fieldCoverage).map((coverage) => coverage.status));
  const fieldCounts = statuses.reduce((counts, status) => ({ ...counts, [status]: (counts[status] ?? 0) + 1 }), {});
  const capped = labels.capped || policies.capped;
  const unidentified = labels.unidentified + policies.unidentified;
  let outcome;
  if (failures.length === 2) outcome = 'failed';
  else if (resources.length === 0 && failures.length === 0 && unidentified === 0) outcome = 'complete-empty';
  else if (failures.length || capped || unidentified || statuses.some((status) => status !== 'observed')) outcome = 'partial';
  else outcome = 'complete';
  // A family that failed is unknown, never "every label was removed".
  const comparable = previous
    ? trackLabelChanges(previous.filter((item) => !failures.some((failure) => item.resourceKey.startsWith(`${PURVIEW_GROUPS[failure.group].prefix}:`))), resources)
    : null;
  return {
    workload: PURVIEW_WORKLOAD,
    outcome,
    observedFrom,
    observedTo: now().toISOString(),
    discovery: { labels: labels.resources.length, policies: policies.resources.length, capped, unidentified, maxObjects, itemCrawl: false },
    resources,
    failures,
    labelChanges: comparable,
    fieldCounts,
  };
}

/**
 * Whether live collection may run. Exchange (which follows Teams and SharePoint)
 * must be qualified first, and both Purview reads must be live-qualified and
 * enabled on their own rows.
 */
export function purviewActivation(ledger) {
  const rows = new Map((ledger?.rows ?? []).map((row) => [row.id, row]));
  const reasons = [];
  const exchange = exchangeActivation(ledger);
  if (!exchange.enabled) reasons.push(`Exchange is not qualified yet, and Purview follows it: ${exchange.reasons.join('; ')}`);
  for (const id of PURVIEW_OPERATIONS) {
    const row = rows.get(id);
    if (!row?.enabled) reasons.push(`${id} is ${row?.state ?? 'not in the ledger'}${row?.prerequisite ? `: ${row.prerequisite.message}` : ''}`);
  }
  return { enabled: reasons.length === 0, reasons };
}

/** Persists one run in one transaction; one row per label and per policy. */
export async function recordPurviewRun(client, { tenantRef, result }) {
  await client.query('BEGIN');
  try {
    const { rows: [run] } = await client.query(
      `INSERT INTO workload_collection (tenant_ref, workload, outcome, observed_from, observed_to, digest)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [tenantRef, PURVIEW_WORKLOAD, result.outcome, result.observedFrom, result.observedTo, {
        discovery: result.discovery ?? null,
        fieldCounts: result.fieldCounts ?? {},
        failures: result.failures ?? [],
        labelChanges: result.labelChanges ?? null,
        reasons: result.reasons ?? [],
      }],
    );
    for (const resource of result.resources ?? []) {
      await client.query(
        `INSERT INTO workload_observation (collection_id, resource_key, fields, field_coverage)
         VALUES ($1,$2,$3,$4) ON CONFLICT (collection_id, resource_key) DO NOTHING`,
        [run.id, resource.resourceKey, { id: resource.id, kind: resource.kind, lock: resource.lock, fingerprint: definitionFingerprint(resource), ...resource.fields }, resource.fieldCoverage],
      );
    }
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const META = new Set(['id', 'kind', 'lock', 'fingerprint']);
/** A stored observation, split back into fields and metadata. Rows from before a key existed read as unknown. */
export function storedObservation(row) {
  const stored = row.fields ?? {};
  const fields = Object.fromEntries(Object.entries(stored).filter(([key]) => !META.has(key)));
  const kind = stored.kind ?? (row.resource_key.startsWith('label-policy:') ? 'policy' : 'label');
  return {
    resourceKey: row.resource_key,
    id: stored.id ?? row.resource_key.split(':').slice(1).join(':'),
    kind,
    lock: ['locked', 'unlocked', 'not-reported'].includes(stored.lock) ? stored.lock : 'not-reported',
    fields,
    fieldCoverage: row.field_coverage ?? {},
  };
}

/** Reads one recorded Purview run (or the latest one that read anything). */
export async function loadPurviewCollection(client, { tenantRef, collectionId = null }) {
  const { rows: [run] } = collectionId
    ? await client.query(`SELECT * FROM workload_collection WHERE id::text = $1 AND tenant_ref = $2 AND workload = $3`, [collectionId, tenantRef, PURVIEW_WORKLOAD])
    : await client.query(
      `SELECT * FROM workload_collection WHERE tenant_ref = $1 AND workload = $2 AND outcome IN ('complete','complete-empty','partial')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantRef, PURVIEW_WORKLOAD],
    );
  if (!run) return null;
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`,
    [run.id],
  );
  return {
    collectionId: run.id,
    outcome: run.outcome,
    observedTo: new Date(run.observed_to).toISOString(),
    digest: run.digest,
    observations: rows.map(storedObservation),
  };
}

/** The gated entry point. Without qualification it records a `disabled` run and sends nothing. */
export async function collectPurview(client, { tenantRef, ledger, powershell, maxObjects, now }) {
  const activation = purviewActivation(ledger);
  if (!activation.enabled) {
    const at = (now?.() ?? new Date()).toISOString();
    const run = await recordPurviewRun(client, { tenantRef, result: { outcome: 'disabled', observedFrom: at, observedTo: at, reasons: activation.reasons } });
    return { run, result: null, activation };
  }
  const previous = await loadPurviewCollection(client, { tenantRef });
  const result = await readPurview({ powershell, previous: previous?.observations ?? null, maxObjects, now });
  const run = await recordPurviewRun(client, { tenantRef, result });
  return { run, result, activation };
}

/** Registry adapter: a direct call is refused until the workload is enabled. */
export const purviewAdapter = Object.freeze({
  async collect() {
    throw new Error('the Purview label workload adapter is disabled until live qualification; use collectPurview with the ledger');
  },
});

registerWorkload(PURVIEW_DESCRIPTOR, purviewAdapter);
