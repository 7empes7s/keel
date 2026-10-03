/**
 * Roadmap task-98: decision-focused semantic drift and cross-linked reports.
 *
 * Two server-side readers behind the Changes page.
 *
 * semanticChange() turns one open change's stored before/after payloads into the
 * field-level differences that change behaviour. It compares the same projection drift
 * detection hashes (engine/cir/canonicalHash.mjs#canonicalize, through task-51's
 * `comparison` classification): fields Microsoft sets itself (ids, timestamps, server
 * computed values, @odata annotations) are never listed, only counted. A change whose
 * baseline copy KEEL did not keep is "earlier value not known", never "removed" or
 * "added": an unknown before state is not evidence that anything was deleted.
 *
 * driftEvidence() links each change the reader may already see to the records a
 * decision rests on: the collection that saw it, the baseline's backup copy, the
 * compliance findings that cite it (task-87's same-collection rule), the approval
 * requests that name it, the roll-back plans that cover it and their recorded result.
 * A link is stated as matching only when the stored hashes or collections agree; any
 * other pairing is reported as a mismatch rather than joined. Nothing here reads a
 * change the caller has not already authorized, and nothing outside the reader's
 * entities (other changes in the same request or plan, other owners of a shared
 * resource) is serialized for an entity-scoped reader: it collapses to a boolean.
 */
import { canonicalize } from '../cir/canonicalHash.mjs';
import { SERVER_OWNED_ALWAYS, fieldClass } from '../cir/serverOwned.mjs';
import { classifyForOperation } from '../contracts/fieldProjection.mjs';
import { ownershipOfResources } from '../authz/entityScope.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { complianceFindings } from './baselineCompliance.mjs';

/** At most this many settings per change are serialized; the rest are counted. */
export const MAX_SEMANTIC_FIELDS = 50;
/** At most this many changes get evidence links per read. */
export const MAX_EVIDENCE_CHANGES = 200;
/** At most this many findings, approvals and plans per change. */
export const MAX_LINKS_PER_KIND = 5;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function iso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The comparison class of a field, with the rules drift detection uses. A resource
 * type KEEL has no field rules for falls back to the rules every type shares (ids,
 * creation and modification times, @odata annotations), and says so.
 */
function classifier(resourceType) {
  try {
    fieldClass('', resourceType);
    return {
      rules: 'reviewed',
      classOf: (path) => classifyForOperation('comparison', path, resourceType),
      project: (value) => canonicalize(value, resourceType),
    };
  } catch {
    const classOf = (path) => (/(^|\.)@odata\./.test(path) || (!path.includes('.') && SERVER_OWNED_ALWAYS.has(path)) ? 'serverOwned' : 'writable');
    const project = (value, path = '') => {
      if (Array.isArray(value)) return value.map((item) => project(item, path));
      if (isPlainObject(value)) {
        const out = {};
        for (const key of Object.keys(value).sort()) {
          const child = path ? `${path}.${key}` : key;
          if (classOf(child) === 'serverOwned') continue;
          out[key] = project(value[key], child);
        }
        return out;
      }
      return value;
    };
    return { rules: 'generic', classOf, project };
  }
}

/**
 * A payload without the fields Microsoft sets itself, for display: what the page and
 * its client props carry instead of the stored copy. Null stays null.
 */
export function comparedSettings(resourceType, payload) {
  if (payload === null || payload === undefined) return null;
  return classifier(resourceType).project(payload);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function impactOf(classOf, path) {
  const top = path.includes('.') ? path.slice(0, path.indexOf('.')) : path;
  return classOf(top) === 'immutable' ? 'fixed' : 'behaviour';
}

/**
 * Field-level differences that change behaviour, for one change.
 * Returns { state, rules, fields, total, shown, cosmetic, groups, projected }:
 * - state: 'compared' | 'added' | 'removed' | 'unknown-before' | 'unknown-after'
 * - fields: at most MAX_SEMANTIC_FIELDS entries
 *   { path, kind: 'changed'|'added'|'removed'|'unknown-before', before?, after?, impact }
 *   where impact is 'behaviour' (can be put back), 'fixed' (cannot be changed in place)
 *   or 'unknown-before' (the earlier value is not known).
 * - total: every behavioural difference; cosmetic: differing fields Microsoft sets
 *   itself, counted and never listed.
 * - projected: both payloads without those fields, for display.
 */
export function semanticChange({ resourceType, changeType, before, after, limit = MAX_SEMANTIC_FIELDS }) {
  const { rules, classOf, project } = classifier(resourceType);
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  const projected = { before: hasBefore ? project(before) : null, after: hasAfter ? project(after) : null };
  const fields = [];
  let cosmetic = 0;
  let state = 'compared';

  const push = (entry) => { fields.push(entry); };

  if (changeType === 'added') state = 'added';
  else if (changeType === 'removed') state = 'removed';
  else if (!hasBefore && hasAfter) {
    // The baseline's copy was not kept: every current setting is listed with an
    // unknown earlier value. None of them is reported as added or removed.
    state = 'unknown-before';
    const current = projected.after;
    if (isPlainObject(current)) {
      for (const key of Object.keys(current).sort()) push({ path: key, kind: 'unknown-before', after: current[key], impact: 'unknown-before' });
    } else {
      push({ path: '(value)', kind: 'unknown-before', after: current, impact: 'unknown-before' });
    }
  } else if (!hasAfter) {
    state = hasBefore ? 'unknown-after' : 'unknown-before';
  } else {
    const walk = (a, b, path) => {
      if (isPlainObject(a) && isPlainObject(b)) {
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        for (const key of keys) {
          const child = path ? `${path}.${key}` : key;
          const inA = Object.prototype.hasOwnProperty.call(a, key);
          const inB = Object.prototype.hasOwnProperty.call(b, key);
          if (classOf(child) === 'serverOwned') {
            if (!(inA && inB && same(a[key], b[key]))) cosmetic += 1;
            continue;
          }
          if (!inB) push({ path: child, kind: 'removed', before: project(a[key], child), impact: impactOf(classOf, child) });
          else if (!inA) push({ path: child, kind: 'added', after: project(b[key], child), impact: impactOf(classOf, child) });
          else walk(a[key], b[key], child);
        }
        return;
      }
      // Arrays and scalars compare as whole values after projection: a reordered or
      // re-annotated list that is otherwise equal is not a change.
      const pa = project(a, path);
      const pb = project(b, path);
      if (!same(pa, pb)) push({ path: path || '(value)', kind: 'changed', before: pa, after: pb, impact: impactOf(classOf, path || '(value)') });
      else if (!same(a, b)) cosmetic += 1;
    };
    walk(before, after, '');
  }

  const groups = { behaviour: 0, fixed: 0, 'unknown-before': 0 };
  for (const field of fields) groups[field.impact] += 1;
  // Fixed settings first: they are the ones a roll back cannot simply write back.
  const order = { fixed: 0, behaviour: 1, 'unknown-before': 2 };
  const sorted = [...fields].sort((a, b) => order[a.impact] - order[b.impact] || a.path.localeCompare(b.path));
  const shown = sorted.slice(0, Math.max(0, limit));
  return {
    state,
    rules,
    fields: shown,
    total: fields.length,
    shown: shown.length,
    cosmetic,
    groups,
    projected,
  };
}

/* ------------------------------------------------------------- evidence -- */

const BLAST_ORDER = ['tenant-lockout', 'access-affecting', 'cosmetic'];

/**
 * Page-level counts that reconcile: every change is in exactly one impact group, and
 * the group totals add up to the number of changes.
 */
export function summarizeSemanticDrift(items) {
  const groups = new Map();
  let behaviouralSettings = 0;
  let fixedSettings = 0;
  let cosmeticOnly = 0;
  let unknownBefore = 0;
  let mismatched = 0;
  for (const item of items) {
    const key = item.blastRadius;
    const group = groups.get(key) ?? { blastRadius: key, changes: 0, settings: 0 };
    group.changes += 1;
    const semantic = item.semantic;
    if (semantic) {
      group.settings += semantic.groups.behaviour + semantic.groups.fixed;
      behaviouralSettings += semantic.groups.behaviour;
      fixedSettings += semantic.groups.fixed;
      if (semantic.state === 'compared' && semantic.total === 0) cosmeticOnly += 1;
      if (semantic.state === 'unknown-before') unknownBefore += 1;
    }
    if (item.evidence && item.evidence.mismatches > 0) mismatched += 1;
    groups.set(key, group);
  }
  const byImpact = [...groups.values()].sort((a, b) => {
    const ra = BLAST_ORDER.indexOf(a.blastRadius);
    const rb = BLAST_ORDER.indexOf(b.blastRadius);
    return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.blastRadius.localeCompare(b.blastRadius);
  });
  return { total: items.length, byImpact, behaviouralSettings, fixedSettings, cosmeticOnly, unknownBefore, mismatched };
}

function hashState(expected, actual, { present }) {
  if (!present) return 'missing';
  if (!expected || !actual) return 'unchecked';
  return expected === actual ? 'matches' : 'mismatch';
}

function ownershipFor(answer, scope, at) {
  if (!answer || answer.state === 'unattributed' || answer.state === 'never-resolved') {
    return { state: 'unknown', entityCode: null, sharedWith: [], othersWithheld: false };
  }
  const fresh = answer.expiresAt && new Date(answer.expiresAt) > at;
  const central = scope?.central === true;
  const mine = new Set(central ? [] : scope?.entities ?? []);
  if (answer.state === 'owned') {
    const visible = central || mine.has(answer.entityCode);
    return {
      state: fresh ? 'owned' : 'stale',
      entityCode: visible ? answer.entityCode : null,
      sharedWith: [],
      othersWithheld: !visible,
    };
  }
  if (answer.state === 'shared') {
    // An entity-scoped reader sees only their own entities among a shared resource's
    // owners; the others are withheld, not counted.
    const codes = central ? answer.entityCodes : answer.entityCodes.filter((code) => mine.has(code));
    return {
      state: fresh ? 'shared' : 'stale',
      entityCode: null,
      sharedWith: codes,
      othersWithheld: codes.length < answer.entityCodes.length,
    };
  }
  return { state: 'unknown', entityCode: null, sharedWith: [], othersWithheld: false };
}

/**
 * Evidence links for changes the caller has already authorized for this reader.
 * `items` are { id, naturalKey, resourceType, changeType, detectedAt }.
 * Returns a Map of change id → evidence. Every query is tenant-scoped.
 */
export async function driftEvidence(client, { tenantRef, items, scope = { central: true }, now = new Date() }) {
  assertTenantRef(tenantRef);
  const bounded = items.slice(0, MAX_EVIDENCE_CHANGES);
  const result = new Map();
  if (bounded.length === 0) return result;
  const ids = bounded.map((item) => item.id);
  const visibleIds = new Set(ids);
  const central = scope?.central === true;

  const { rows: rows } = await client.query(
    `SELECT d.id::text AS id, d.natural_key, d.change_type, d.before_hash, d.after_hash, d.detected_at,
            d.observed_snapshot::text AS observed_snapshot,
            os.completed_at AS observed_at, os.started_at AS observed_started,
            orv.id::text AS observed_version, orv.payload_hash AS observed_hash,
            brv.id::text AS backup_version, brv.payload_hash AS backup_hash,
            brv.snapshot_id::text AS backup_snapshot, bs.completed_at AS backup_at,
            b.source_snapshot_id::text AS baseline_source
       FROM drift d
       JOIN baseline b ON b.id = d.baseline_id AND b.tenant_ref = d.tenant_ref
       LEFT JOIN snapshot os ON os.id = d.observed_snapshot AND os.tenant_ref = d.tenant_ref
       LEFT JOIN resource_version orv ON orv.snapshot_id = d.observed_snapshot AND orv.natural_key = d.natural_key
       LEFT JOIN baseline_resource br ON br.baseline_id = d.baseline_id AND br.natural_key = d.natural_key
       LEFT JOIN resource_version brv ON brv.id = br.resource_version_id
       LEFT JOIN snapshot bs ON bs.id = brv.snapshot_id AND bs.tenant_ref = d.tenant_ref
      WHERE d.tenant_ref = $1 AND d.id = ANY($2::uuid[])`,
    [tenantRef, ids],
  );
  const byId = new Map(rows.map((row) => [row.id, row]));

  // Compliance findings that cite these changes (task-87). The reader returns its own
  // linked and mismatched change ids; only this reader's visible ids are kept.
  const findingsByChange = new Map();
  try {
    const { findings } = await complianceFindings(client, { tenantRef, now });
    for (const finding of findings) {
      const entry = (link) => ({
        evaluationId: finding.id, controlId: finding.controlId, title: finding.title,
        verdict: finding.verdict, exposed: finding.exposed, link,
      });
      for (const change of finding.links.change.linked) {
        if (visibleIds.has(change.id)) findingsByChange.set(change.id, [...(findingsByChange.get(change.id) ?? []), entry('linked')]);
      }
      for (const change of finding.links.change.mismatched) {
        if (visibleIds.has(change.id)) findingsByChange.set(change.id, [...(findingsByChange.get(change.id) ?? []), entry('mismatch')]);
      }
    }
  } catch {
    // No compliance tables or evaluations: no findings, never a guess.
  }

  // Approval requests that name these changes (remediate), newest first.
  const { rows: requests } = await client.query(
    `SELECT a.id::text AS id, a.action, a.status, a.params, a.created_at, a.decided_at, a.expires_at,
            j.id::text AS job_id, j.status AS job_status
       FROM approval_request a
       LEFT JOIN job j ON j.idempotency_key = 'approval:' || a.id::text
      WHERE a.action = 'remediate' AND jsonb_typeof(a.params->'driftIds') = 'array'
        AND a.params->'driftIds' ?| $1::text[]
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 500`,
    [ids],
  );

  // Roll-back plans whose scope covers a change's resource, made after it was found.
  const keys = [...new Set(bounded.map((item) => item.naturalKey))];
  const { rows: plans } = await client.query(
    `SELECT r.id::text AS id, r.snapshot_id::text AS snapshot_id, r.status, r.created_at, r.closure_keys
       FROM restore_dry_run r
      WHERE r.tenant_ref = $1 AND jsonb_typeof(r.closure_keys) = 'array' AND r.closure_keys ?| $2::text[]
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 500`,
    [tenantRef, keys],
  );
  const planIds = plans.map((plan) => plan.id);
  const { rows: planRequests } = planIds.length ? await client.query(
    `SELECT a.id::text AS id, a.action, a.status, a.params, a.created_at, a.decided_at, a.expires_at,
            j.id::text AS job_id, j.status AS job_status
       FROM approval_request a
       LEFT JOIN job j ON j.idempotency_key = 'approval:' || a.id::text
      WHERE a.action = 'restore' AND a.params->>'artifactId' = ANY($1::text[])
      ORDER BY a.created_at DESC, a.id DESC`,
    [planIds],
  ) : { rows: [] };
  const { rows: outcomes } = planIds.length ? await client.query(
    `SELECT DISTINCT ON (restore_ref, natural_key) restore_ref, natural_key, outcome, outcome_at, recorded_at
       FROM rollback_entry
      WHERE restore_ref = ANY($1::text[]) AND natural_key = ANY($2::text[])
      ORDER BY restore_ref, natural_key, recorded_at DESC, id DESC`,
    [planIds, keys],
  ) : { rows: [] };
  const outcomeOf = new Map(outcomes.map((row) => [`${row.restore_ref}|${row.natural_key}`, row]));

  const ownership = await ownershipOfResources(client, {
    tenantRef,
    resources: bounded.map((item) => ({ resourceType: item.resourceType, naturalKey: item.naturalKey, asOf: item.detectedAt })),
  });

  const others = (list, own) => {
    const rest = list.filter((entry) => entry !== own);
    // A central reader may see how many other records share the request or plan; an
    // entity-scoped reader learns only that there are some.
    return central ? { others: rest.length, othersWithheld: false } : { others: null, othersWithheld: rest.length > 0 };
  };
  const approvalOf = (request, own) => ({
    id: request.id,
    action: request.action,
    status: request.status === 'pending' && new Date(request.expires_at) <= now ? 'expired' : request.status,
    createdAt: iso(request.created_at),
    decidedAt: iso(request.decided_at),
    expiresAt: iso(request.expires_at),
    job: request.job_id ? { id: request.job_id, status: request.job_status } : null,
    ...others(request.action === 'remediate' ? (request.params.driftIds ?? []) : [], own),
  });

  for (const [index, item] of bounded.entries()) {
    const row = byId.get(item.id);
    if (!row) continue;
    const changeType = row.change_type;
    const observation = changeType === 'removed'
      ? { state: row.observed_version ? 'mismatch' : (row.observed_at || row.observed_started ? 'matches' : 'missing') }
      : { state: hashState(row.after_hash, row.observed_hash, { present: Boolean(row.observed_version) }) };
    observation.snapshotId = row.observed_snapshot;
    observation.at = iso(row.observed_at ?? row.observed_started);
    observation.versionId = row.observed_version ?? null;

    const backup = changeType === 'added'
      ? { state: row.backup_version ? 'mismatch' : 'not-in-baseline' }
      : { state: hashState(row.before_hash, row.backup_hash, { present: Boolean(row.backup_version) }) };
    backup.snapshotId = row.backup_snapshot ?? null;
    backup.at = iso(row.backup_at);
    backup.versionId = row.backup_version ?? null;

    const restoreSource = row.backup_snapshot ?? row.baseline_source ?? null;
    const detected = new Date(row.detected_at).getTime();
    const itemPlans = plans
      .filter((plan) => (plan.closure_keys ?? []).includes(item.naturalKey) && new Date(plan.created_at).getTime() >= detected)
      .slice(0, MAX_LINKS_PER_KIND)
      .map((plan) => {
        const outcome = outcomeOf.get(`${plan.id}|${item.naturalKey}`);
        return {
          id: plan.id,
          snapshotId: plan.snapshot_id,
          status: plan.status,
          createdAt: iso(plan.created_at),
          // Linked only when the plan restores from the baseline's own backup.
          link: restoreSource ? (plan.snapshot_id === restoreSource ? 'linked' : 'mismatch') : 'unchecked',
          outcome: outcome ? { state: outcome.outcome ?? 'pending', at: iso(outcome.outcome_at ?? outcome.recorded_at) } : null,
          approvals: planRequests.filter((request) => request.params?.artifactId === plan.id).slice(0, MAX_LINKS_PER_KIND).map((request) => approvalOf(request, null)),
          ...others(plan.closure_keys ?? [], item.naturalKey),
        };
      });

    const itemApprovals = requests
      .filter((request) => (request.params?.driftIds ?? []).includes(item.id))
      .slice(0, MAX_LINKS_PER_KIND)
      .map((request) => approvalOf(request, item.id));

    const findings = (findingsByChange.get(item.id) ?? []).slice(0, MAX_LINKS_PER_KIND);
    const mismatches = [observation.state, backup.state].filter((state) => state === 'mismatch').length
      + findings.filter((finding) => finding.link === 'mismatch').length
      + itemPlans.filter((plan) => plan.link === 'mismatch').length;

    result.set(item.id, {
      ownership: ownershipFor(ownership[index], scope, now),
      observation,
      backup,
      findings,
      approvals: itemApprovals,
      plans: itemPlans,
      mismatches,
    });
  }
  return result;
}
