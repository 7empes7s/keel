// engine/restore/dryRunArtifact.mjs
//
// Plan task 8 (portal-design §4.1): restore promotion must review an IMMUTABLE dry-run
// artifact, never a mutable selection. A dry run persists here — the exact source
// snapshot, raw selection, server-computed closure, target identity, waves, deferred
// patches, guard outcomes and per-resource result — with a stable digest over its
// planning inputs and a genuine fingerprint of the target state the closure would
// touch. An approval references the artifact by id, never repeating the restore's
// mutable parameters; execution recomputes the digest and the fingerprint fresh and
// refuses to write on any mismatch, so a changed snapshot/selection/closure/target, or
// a target that drifted since the dry run ran, forces a new dry run instead of silently
// promoting stale parameters.
import { createHash } from 'node:crypto';

const TERMINAL_STATUSES = Object.freeze(['completed', 'refused', 'failed']);

function sortedUnique(values) {
  return [...new Set(values ?? [])].sort((a, b) => a.localeCompare(b));
}

// A generic, resourceType-agnostic canonical stringify: object keys are sorted
// recursively so the same logical value always yields the same digest input
// regardless of property insertion order. Unlike cir/canonicalHash.mjs's
// canonicalize(), this has no notion of server-owned fields — it hashes plain
// planning data (natural keys, wave arrays, patch descriptors), not Graph payloads.
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

/** The plan's identity: everything that must never change without a fresh dry run.
 * Deliberately excludes anything read live from the target — that is
 * computeCurrentStateFingerprint's job — so this digest is reproducible from the
 * snapshot and its own selection alone, at both dry-run creation and promotion.
 * automationContext (task-55: policy identity/version and expanded scope) is folded
 * in only when present, so artifacts persisted before that field existed keep the
 * exact digest inputs they were created with and remain promotable.
 * relationshipOperations (task-61: ordered group member/owner edge adds/removes)
 * follow the same rule — folded in only when the plan carries at least one, so a
 * plan with no edge work keeps its pre-task-61 digest, while an artifact persisted
 * without edge operations can never be promoted into a run that has some. */
export function computePlanDigest({
  snapshotId, selection, closureKeys, targetTenantId, collectorConfigPath, targetConfigPath,
  reconciliationResources, waves, patches, automationContext = null, relationshipOperations = null,
  recoveryMechanisms = null, contentEffects = null,
}) {
  return sha256(canonicalStringify({
    snapshotId,
    selection: sortedUnique(selection),
    closureKeys: sortedUnique(closureKeys),
    targetTenantId,
    collectorConfigPath,
    targetConfigPath,
    reconciliationResources,
    waves,
    patches,
    ...(automationContext ? { automationContext } : {}),
    ...(relationshipOperations?.length ? { relationshipOperations } : {}),
    // Task-64: the recovery mechanism per resource (mechanism, retained/new id,
    // deadline, credential, proof). Folded whenever supplied — every new dry run
    // supplies it — and left out only for an artifact persisted before task-64,
    // so a mechanism change after review always invalidates a new artifact.
    ...(recoveryMechanisms ? { recoveryMechanisms } : {}),
    // Task-66: content effects (with their disclosures) of the plan. Folded only
    // when there is at least one, so effect-free plans keep their digest.
    ...(contentEffects?.length ? { contentEffects } : {}),
  }));
}

/** What the target looks like right now, restricted to the resources this restore
 * would touch. Recomputed fresh at execution: any drift in the target between the
 * dry run and promotion — a resource created, changed, or removed out from under the
 * plan — changes this fingerprint and refuses the enforce run before it writes.
 *
 * Task-61: a parent object's payload never carries its membership, so the live edge
 * sets of every group whose edges the plan reconciles are folded in separately
 * (`relationships`: { parentNaturalKey, family, outcome, targetIds }). A member added
 * or removed concurrently — even legitimately — changes the fingerprint and forces a
 * new dry run. Folded in only when present, so edge-free plans keep their old value. */
export function computeCurrentStateFingerprint(targetResources, closureKeys, { relationships = null } = {}) {
  const closureSet = new Set(closureKeys ?? []);
  const relevant = (targetResources ?? [])
    .filter((resource) => closureSet.has(resource.naturalKey))
    .map((resource) => ({
      naturalKey: resource.naturalKey,
      sourceId: resource.sourceId ?? null,
      payload: resource.payload ?? null,
    }))
    .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey));
  if (!relationships?.length) return sha256(canonicalStringify(relevant));
  const edges = relationships
    .map((entry) => ({
      parentNaturalKey: entry.parentNaturalKey,
      family: entry.family,
      outcome: entry.outcome ?? null,
      targetIds: sortedUnique((entry.targetIds ?? []).map((id) => String(id).toLowerCase())),
    }))
    .sort((a, b) => `${a.parentNaturalKey}|${a.family}`.localeCompare(`${b.parentNaturalKey}|${b.family}`));
  return sha256(canonicalStringify({ resources: relevant, relationships: edges }));
}

/** Step 1: a dry run's terminal status is explicit, never inferred by a caller
 * downstream. Any verification failure (an unresolved reference, a residual-drift
 * mismatch surfaced by applyWave even in dry-run mode) fails the whole artifact
 * closed; any guard refusal (synced object, unsafe deletion, tenant-lockout without
 * simulation) makes it refused — promotable only once the selection changes and a
 * fresh dry run is clean. */
export function classifyDryRunStatus({ failed, skipped }) {
  if ((failed?.length ?? 0) > 0) return 'failed';
  if ((skipped?.length ?? 0) > 0) return 'refused';
  return 'completed';
}

export async function createDryRunArtifact(client, {
  id, tenantRef, snapshotId, selection, closureKeys, targetTenantId,
  collectorConfigPath, targetConfigPath, reconciliationResources, waves, patches, guardRefusals, results,
  currentStateFingerprint, digest, status, requestedBy, automationContext = null, relationshipOperations = null,
  recoveryMechanisms = null, contentEffects = null,
}) {
  if (!TERMINAL_STATUSES.includes(status)) {
    throw new Error(`invalid dry-run artifact status: ${status}`);
  }
  const { rows } = await client.query(
    `INSERT INTO restore_dry_run
       (id, tenant_ref, snapshot_id, selection, closure_keys, target_tenant_id,
        collector_config_path, target_config_path, reconciliation_resources, waves, patches, guard_refusals,
        results, current_state_fingerprint, digest, status, requested_by, automation_context,
        relationship_operations, recovery_mechanisms, content_effects)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      // pg serializes a top-level JS array as a Postgres array literal, not JSON —
      // every jsonb column here that holds an array must be stringified explicitly.
      // The plain-object columns (results, automation_context) are left as-is; pg
      // JSON-serializes those correctly, arrays and all, once they are nested rather
      // than top-level.
      id, tenantRef, snapshotId, JSON.stringify(selection), JSON.stringify(closureKeys), targetTenantId,
      collectorConfigPath, targetConfigPath, JSON.stringify(reconciliationResources ?? null), JSON.stringify(waves),
      JSON.stringify(patches), JSON.stringify(guardRefusals ?? []), results, currentStateFingerprint, digest,
      status, requestedBy, automationContext ?? null,
      relationshipOperations?.length ? JSON.stringify(relationshipOperations) : null,
      recoveryMechanisms ? JSON.stringify(recoveryMechanisms) : null,
      contentEffects?.length ? JSON.stringify(contentEffects) : null,
    ],
  );
  return normalizeArtifact(rows[0]);
}

export async function getDryRunArtifact(client, { id, tenantRef }) {
  const { rows } = await client.query(
    `SELECT * FROM restore_dry_run WHERE id = $1 AND tenant_ref = $2`,
    [id, tenantRef],
  );
  return rows[0] ? normalizeArtifact(rows[0]) : null;
}

// CLI/worker execution (cli/keel-restore.mjs) already operates with direct database
// access and a single tenant per deployment — unlike the portal, which derives
// tenantRef from request context and must never show one tenant's artifact to
// another. No tenant scoping is needed at this trust boundary.
export async function getDryRunArtifactById(client, { id }) {
  const { rows } = await client.query(`SELECT * FROM restore_dry_run WHERE id = $1`, [id]);
  return rows[0] ? normalizeArtifact(rows[0]) : null;
}

function normalizeArtifact(row) {
  return {
    id: row.id,
    tenantRef: row.tenant_ref,
    snapshotId: row.snapshot_id,
    selection: row.selection,
    closureKeys: row.closure_keys,
    targetTenantId: row.target_tenant_id,
    collectorConfigPath: row.collector_config_path,
    targetConfigPath: row.target_config_path,
    reconciliationResources: row.reconciliation_resources,
    waves: row.waves,
    patches: row.patches,
    guardRefusals: row.guard_refusals,
    results: row.results,
    currentStateFingerprint: row.current_state_fingerprint,
    digest: row.digest,
    status: row.status,
    requestedBy: row.requested_by,
    automationContext: row.automation_context ?? null,
    // Task-61: null for every artifact persisted before edge restore existed (and
    // for plans with no edge work) — read as "no edge operations", never guessed.
    relationshipOperations: row.relationship_operations ?? null,
    // Task-64: null only for artifacts persisted before mechanisms were recorded.
    recoveryMechanisms: row.recovery_mechanisms ?? null,
    // Task-66: null when the dry run had no content effects (or predates them).
    contentEffects: row.content_effects ?? null,
    createdAt: row.created_at,
  };
}

/** Step 3: promotion (the approve decision) fails closed if the artifact does not
 * exist or is not in a promotable terminal state. This check is deliberately DB-only
 * and live-read-free — it runs inside the approval transaction. The check that needs a
 * fresh read of the target (computeCurrentStateFingerprint) runs at execution instead,
 * where the target might have moved since the dry run ran (validateArtifactForExecution). */
export function validateArtifactForApproval(artifact) {
  if (!artifact) return { ok: false, reason: 'no dry-run artifact found for this restore' };
  if (artifact.status === 'refused') {
    return { ok: false, reason: 'the dry-run artifact was refused (a guard refusal is unresolved) and cannot be promoted' };
  }
  if (artifact.status === 'failed') {
    return { ok: false, reason: 'the dry-run artifact failed and cannot be promoted' };
  }
  if (artifact.status !== 'completed') {
    return { ok: false, reason: `the dry-run artifact is not complete (status: ${artifact.status})` };
  }
  return { ok: true };
}

/** Step 4: execution recomputes the plan digest and the current-state fingerprint and
 * refuses to write on ANY mismatch — a changed snapshot, selection, dependency
 * closure, or target identity changes the digest; a target that drifted since the dry
 * run ran changes the fingerprint. Either one refuses the run before anything writes. */
export function validateArtifactForExecution(artifact, { digest, currentStateFingerprint }) {
  const approval = validateArtifactForApproval(artifact);
  if (!approval.ok) return approval;
  if (artifact.digest !== digest) {
    return { ok: false, reason: 'the recomputed restore plan no longer matches the dry-run artifact — a new dry run is required' };
  }
  if (artifact.currentStateFingerprint !== currentStateFingerprint) {
    return { ok: false, reason: 'the target has changed since the dry run — a new dry run is required' };
  }
  return { ok: true };
}
