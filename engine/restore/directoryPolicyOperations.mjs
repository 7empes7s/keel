/**
 * Wave 2 ENTRA: writers for directory policies and app consents.
 *
 * Before this module these types were backed up in full but restored by hand
 * (incomplete configurations, coverage plan v3):
 *  - token lifetime, token issuance, claims mapping and home realm discovery
 *    policies (one shape: a displayName, a `definition` array of JSON strings
 *    and an isOrganizationDefault flag);
 *  - permission grant policies (app consent policies), custom ones only;
 *  - delegated app consents (oauth2PermissionGrants).
 *
 * Each type is an explicit record naming its collection, the fields a write may
 * send and how an existing object is recognised. Nothing outside those fields
 * is ever sent. Every write is journaled, read back and verified; a write that
 * does not read back as intended is 'uncertain', never 'applied'.
 *
 * Best-effort rules (engine/restore/bestEffortRecreate.mjs):
 *  - A policy that was the organization default is recreated as an ordinary
 *    policy. Making it the default changes sign-in for every app at once (for
 *    home realm discovery, where every federated user signs in), so it is a
 *    follow-up step for a person, never written by KEEL. An update never
 *    changes the flag either.
 *  - Which apps a policy is assigned to is not in the backup yet; it is a
 *    follow-up step from the type's completeness record.
 *  - A permission grant policy's include and exclude condition sets are
 *    written when the backup holds them (missing ones added, extra live ones
 *    left alone); otherwise they are a follow-up step. Built-in microsoft-*
 *    policies are Microsoft-managed and skipped.
 *  - A consent is matched on (app, resource, consent type, user): Graph keeps
 *    one grant per such pair, so a re-run updates the grant it made instead of
 *    adding a second one. Its scopes are written as the backup had them.
 *
 * The capability registry (capabilities.d/entra.mjs) holds the claims; this
 * module never raises one. Routes and fields below follow the Graph v1.0
 * reference; learn.microsoft.com is not reachable from the build container, so
 * they are declarations to confirm in each type's live check.
 */
import { isDeepStrictEqual } from 'node:util';

import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { qualificationFor, remappingFor, withExplicitReferences } from '../coverage/qualification.mjs';
import { followUpSteps } from './bestEffortRecreate.mjs';
import { classifyWriteOutcome, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';

export const DIRECTORY_POLICY_OPERATIONS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const APP_CONFIG = 'Policy.ReadWrite.ApplicationConfiguration';

const stsPolicy = (resourceType, collection, docsName) => Object.freeze({
  resourceType,
  family: 'sts-policy',
  collection,
  version: 'v1.0',
  permission: APP_CONFIG,
  docs: `${DOCS}/resources/${docsName}?view=graph-rest-1.0`,
  createFields: Object.freeze(['displayName', 'definition']),
  updateFields: Object.freeze(['displayName', 'definition']),
});

export const DIRECTORY_POLICY_RECORDS = Object.freeze({
  tokenLifetimePolicy: stsPolicy('tokenLifetimePolicy', '/policies/tokenLifetimePolicies', 'tokenlifetimepolicy'),
  tokenIssuancePolicy: stsPolicy('tokenIssuancePolicy', '/policies/tokenIssuancePolicies', 'tokenissuancepolicy'),
  claimsMappingPolicy: stsPolicy('claimsMappingPolicy', '/policies/claimsMappingPolicies', 'claimsmappingpolicy'),
  homeRealmDiscoveryPolicy: stsPolicy('homeRealmDiscoveryPolicy', '/policies/homeRealmDiscoveryPolicies', 'homerealmdiscoverypolicy'),
  permissionGrantPolicy: Object.freeze({
    resourceType: 'permissionGrantPolicy',
    family: 'permission-grant-policy',
    collection: '/policies/permissionGrantPolicies',
    version: 'v1.0',
    permission: 'Policy.ReadWrite.PermissionGrant',
    docs: `${DOCS}/resources/permissiongrantpolicy?view=graph-rest-1.0`,
    // The id is chosen by the admin and sent on create; it names the policy.
    createFields: Object.freeze(['id', 'displayName', 'description']),
    updateFields: Object.freeze(['displayName', 'description']),
  }),
  oauth2PermissionGrant: Object.freeze({
    resourceType: 'oauth2PermissionGrant',
    family: 'consent',
    collection: '/oauth2PermissionGrants',
    version: 'v1.0',
    permission: 'DelegatedPermissionGrant.ReadWrite.All',
    docs: `${DOCS}/resources/oauth2permissiongrant?view=graph-rest-1.0`,
    createFields: Object.freeze(['clientId', 'consentType', 'principalId', 'resourceId', 'scope']),
    updateFields: Object.freeze(['scope']),
  }),
});

/** The operations registered for these types (capabilities.d/entra.mjs). */
export const DIRECTORY_POLICY_OPERATIONS = Object.freeze(['create', 'update']);

export function isDirectoryPolicyGoverned(resourceType) {
  return Object.hasOwn(DIRECTORY_POLICY_RECORDS, resourceType);
}

const PERMISSION_GRANT_CONDITION_FIELDS = Object.freeze([
  'permissionClassification', 'permissionType', 'resourceApplication', 'permissions', 'clientApplicationIds',
  'clientApplicationTenantIds', 'clientApplicationPublisherIds', 'clientApplicationsFromVerifiedPublisherOnly',
  'certifiedClientApplicationsOnly',
]);
const CONDITION_SETS = Object.freeze(['includes', 'excludes']);

const isBuiltInGrantPolicy = (payload) => /^microsoft-/i.test(String(payload?.id ?? ''));

/** The definition of an STS policy: a non-empty array of JSON strings, or the reason it is not. */
export function definitionProblem(definition) {
  if (!Array.isArray(definition) || definition.length === 0) return 'definition is not a non-empty list';
  for (const [index, entry] of definition.entries()) {
    if (typeof entry !== 'string') return `definition[${index}] is not a string`;
    try {
      JSON.parse(entry);
    } catch {
      return `definition[${index}] is not valid JSON`;
    }
  }
  return null;
}

// Two definitions are the same when every entry parses to the same value:
// Graph may return the JSON with different spacing than it was written.
function sameDefinition(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  try {
    return left.every((entry, index) => isDeepStrictEqual(JSON.parse(entry), JSON.parse(right[index])));
  } catch {
    return false;
  }
}

const scopeSet = (scope) => [...new Set(String(scope ?? '').split(/\s+/).filter(Boolean))].sort();
const sameText = (left, right) => (left ?? null) === (right ?? null) || (left ?? '') === (right ?? '');

/** Field equality as each record means it. */
function sameField(field, desired, live) {
  if (field === 'definition') return sameDefinition(desired, live);
  if (field === 'scope') return isDeepStrictEqual(scopeSet(desired), scopeSet(live));
  if (field === 'description' || field === 'displayName') return sameText(desired, live);
  return isDeepStrictEqual(desired ?? null, live ?? null);
}

function conditionSetBody(condition) {
  const body = {};
  for (const field of PERMISSION_GRANT_CONDITION_FIELDS) {
    if (condition?.[field] !== undefined && condition[field] !== null) body[field] = condition[field];
  }
  return body;
}
const sameCondition = (left, right) => isDeepStrictEqual(conditionSetBody(left), conditionSetBody(right));

/**
 * Refuses a write before any Graph call, or returns null. A refusal is
 * { outcome: 'skipped' | 'failed', reason }.
 */
export function directoryPolicyWriteRefusal(resource, verb) {
  const entry = DIRECTORY_POLICY_RECORDS[resource?.resourceType];
  if (!entry) return null;
  if (!DIRECTORY_POLICY_OPERATIONS.includes(verb)) {
    return { outcome: 'failed', reason: `${entry.resourceType} ${verb} is not written by KEEL` };
  }
  const capability = capabilityFor(entry.resourceType, verb);
  if (!isSupportedClaim(capability.claim)) {
    return { outcome: 'failed', reason: `${entry.resourceType} ${verb} is not a registered write capability (claim: ${capability.claim})` };
  }
  const payload = resource.payload ?? {};
  if (entry.family === 'sts-policy') {
    const problem = definitionProblem(payload.definition);
    if (problem) return { outcome: 'failed', reason: `${entry.resourceType}: the backed-up ${problem}, so it cannot be written` };
    if (typeof payload.displayName !== 'string' || payload.displayName.length === 0) {
      return { outcome: 'failed', reason: `${entry.resourceType}: the backup has no displayName` };
    }
  }
  if (entry.family === 'permission-grant-policy') {
    if (isBuiltInGrantPolicy(payload)) {
      return { outcome: 'skipped', reason: `${payload.id} is a built-in app consent policy: Microsoft manages it and nobody can change it` };
    }
    if (typeof payload.id !== 'string' || payload.id.length === 0) return { outcome: 'failed', reason: 'permissionGrantPolicy: the backup has no id to recreate the policy under' };
  }
  if (entry.family === 'consent') {
    for (const field of ['clientId', 'resourceId', 'consentType']) {
      if (typeof payload[field] !== 'string' || payload[field].length === 0) return { outcome: 'failed', reason: `oauth2PermissionGrant: the backup has no ${field}` };
    }
    if (!['AllPrincipals', 'Principal'].includes(payload.consentType)) {
      return { outcome: 'failed', reason: `oauth2PermissionGrant: consent type ${payload.consentType} is not AllPrincipals or Principal` };
    }
    if (payload.consentType === 'Principal' && (typeof payload.principalId !== 'string' || payload.principalId.length === 0)) {
      return { outcome: 'failed', reason: 'oauth2PermissionGrant: a consent for one user has no principalId' };
    }
    if (scopeSet(payload.scope).length === 0) return { outcome: 'failed', reason: 'oauth2PermissionGrant: the backed-up consent grants no scope' };
  }
  return null;
}

/** The body a write sends: only the record's fields, as the backup has them. */
export function directoryPolicyBody(entry, desired, verb) {
  const fields = verb === 'create' ? entry.createFields : entry.updateFields;
  const body = {};
  for (const field of fields) {
    if (desired[field] === undefined) continue;
    if (field === 'principalId' && desired.consentType !== 'Principal') continue;
    body[field] = field === 'scope' ? scopeSet(desired.scope).join(' ') : desired[field];
  }
  // A recreated policy is never the organization default (see the header).
  if (entry.family === 'sts-policy' && verb === 'create') body.isOrganizationDefault = false;
  return body;
}

/** The fields an update must change: those whose live value differs. */
export function changedDirectoryPolicyFields(entry, desired, live) {
  return entry.updateFields.filter((field) => desired[field] !== undefined && !sameField(field, desired[field], live?.[field]));
}

/** Null when `live` holds every written field as intended, otherwise the reason. */
export function directoryPolicyPostStateRefusal(entry, desired, live, fields) {
  if (!live || typeof live !== 'object') return `${entry.resourceType}: the read-back returned no object`;
  const off = fields.filter((field) => !sameField(field, directoryPolicyBody(entry, desired, 'create')[field] ?? desired[field], live[field]));
  return off.length === 0 ? null : `${entry.resourceType} post-state did not verify: ${off.join(', ')} read back different from what was written`;
}

/** How an existing object of the type is recognised on create. */
function matcherFor(entry, desired) {
  if (entry.family === 'sts-policy') {
    return (object) => sameText(object.displayName, desired.displayName) && sameDefinition(object.definition, desired.definition);
  }
  if (entry.family === 'consent') {
    return (object) => String(object.clientId).toLowerCase() === String(desired.clientId).toLowerCase()
      && String(object.resourceId).toLowerCase() === String(desired.resourceId).toLowerCase()
      && object.consentType === desired.consentType
      && (desired.consentType !== 'Principal' || String(object.principalId).toLowerCase() === String(desired.principalId).toLowerCase());
  }
  return null;
}

function listPath(entry, desired) {
  // Graph filters grants by client; the policies are few and listed whole.
  if (entry.family === 'consent') return `${entry.collection}?$filter=clientId eq '${encodeURIComponent(desired.clientId)}'`;
  return entry.collection;
}

/**
 * Follow-up steps this write leaves: the type's missing parts, plus making a
 * policy the organization default again when the backup had it so.
 */
export function directoryPolicyFollowUp(entry, resource, verb, desired, live, decision) {
  const steps = [...followUpSteps(entry.resourceType, resource.payload, decision)];
  if (entry.family === 'permission-grant-policy') {
    // Condition sets the backup holds are written, so their step is dropped.
    const held = CONDITION_SETS.every((set) => Array.isArray(resource.payload?.[set]));
    if (held) return steps.filter((step) => !/include and exclude rules/i.test(step.part));
  }
  if (entry.family === 'sts-policy' && desired.isOrganizationDefault === true && (verb === 'create' || live?.isOrganizationDefault !== true)) {
    steps.push(Object.freeze({
      kind: 'follow-up',
      actionable: true,
      requirement: 'followUp:organization-default',
      part: 'Organization default',
      reason: 'not-written',
      why: 'in the backup, but KEEL does not write it yet',
      values: Object.freeze([Object.freeze({ name: desired.displayName, expires: null })]),
      portalPath: steps[0]?.portalPath ?? entry.collection,
      description: `The backup had "${desired.displayName}" as the organization default, which applies it to every app at once. `
        + 'KEEL restored it as an ordinary policy. Check it, then set isOrganizationDefault to true on it if it should apply everywhere again',
    }));
  }
  return steps;
}

// ---- journal helpers (the same rows applyEngine.mjs writes)

async function journalBefore(rollbackClient, { runId, restoreRef, resource, operation, targetId, priorState, intendedState }) {
  if (!rollbackClient) return { ok: true, entryId: null };
  try {
    const entryId = await recordPriorState(rollbackClient, restoreRef
      ? {
        runId, naturalKey: resource.naturalKey, priorState, restoreRef,
        resourceType: resource.resourceType, operation, targetId, blastRadius: resource.blastRadius ?? null, intendedState,
      }
      : { runId, naturalKey: resource.naturalKey, priorState });
    return { ok: true, entryId: restoreRef ? entryId : null };
  } catch {
    return { ok: false, entryId: null };
  }
}

async function journalOutcome(rollbackClient, journal, outcome, extras = {}) {
  if (!rollbackClient || !journal?.entryId) return;
  try {
    await recordWriteOutcome(rollbackClient, { entryId: journal.entryId, outcome, ...extras });
  } catch {
    // left pending; compensation reconciles it by reading
  }
}

const failure = (naturalKey, result) => ({
  naturalKey,
  error: JSON.stringify(result?.body?.error ?? result?.body ?? result?.error ?? null),
  ...(result?.status !== undefined ? { status: result.status } : {}),
});
const detailOf = (result) => (result?.status !== undefined ? `status ${result.status}` : String(result?.error ?? 'no response').slice(0, 200));

async function readBack(writer, version, path, isStale, { retryOperation, attempts = 6, delayMs = 3000 }) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await retryOperation(() => writer.read(version, path));
    if (!isStale(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

const isNotFound = (result) => result?.ok === false && result?.status === 404;

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * Roadmap task-63's rule, as applyWave applies it to its built-in writers: a
 * rewrite that moves a reference to a different id (an app recreated in this
 * run) needs a remapping proof for this operation. Returns the reason or null.
 */
function remappingRefusal(resource, verb, before, after) {
  const changed = withExplicitReferences(resource).filter((ref) => {
    const field = ref.field.split('.')[0];
    return lower(before?.[field]) !== lower(after?.[field]);
  });
  if (changed.length === 0 || remappingFor(resource.resourceType, verb).qualified) return null;
  return `unqualified-remapping: ${resource.resourceType} ${verb} would rewrite ${changed.map((ref) => ref.field).join(', ')} to a different id, and reference remapping is not proven for this operation`;
}

/**
 * One write of a governed type: the registered writer applyWave calls
 * (engine/restore/writers/entra.mjs), with the registry's ctx
 * (writers/registry.mjs): mode, retryOperation, rollbackClient, runId,
 * restoreRef, readAfterWriteOptions and rewriteReferences(payload).
 * Returns { applied } (with `followUp` steps), { skipped } or { failed }.
 */
export async function applyDirectoryPolicyWrite(writer, resource, verb, ctx = {}) {
  const {
    mode = 'enforce', retryOperation = (operation) => operation(), rollbackClient = null, runId = null, restoreRef = null,
    rewriteReferences = (payload) => payload, readAfterWriteOptions = {},
  } = ctx;
  const readAfterWrite = readAfterWriteOptions;
  const decision = qualificationFor(resource.resourceType);
  const rewrite = (r) => {
    const desired = rewriteReferences(r.payload);
    const refusal = remappingRefusal(r, verb, r.payload, desired);
    if (refusal) throw new Error(refusal);
    return desired;
  };
  const { naturalKey } = resource;
  const entry = DIRECTORY_POLICY_RECORDS[resource.resourceType];
  if (!entry) return { failed: { naturalKey, error: `${resource.resourceType} is not a directory policy type` } };

  const refusal = directoryPolicyWriteRefusal(resource, verb);
  if (refusal) {
    return refusal.outcome === 'skipped'
      ? { skipped: { naturalKey, reason: refusal.reason } }
      : { failed: { naturalKey, error: refusal.reason } };
  }

  let desired;
  try {
    desired = rewrite(resource);
  } catch (err) {
    return { failed: { naturalKey, error: err.message } };
  }

  const { version } = entry;
  let targetId = resource.targetId ?? resource.live?.targetId ?? null;
  let live = resource.live?.payload ?? null;
  let operation = verb;

  // A create first looks for the object a previous run (or a person) made.
  if (verb === 'create') {
    if (entry.family === 'permission-grant-policy') {
      const found = await retryOperation(() => writer.read(version, `${entry.collection}/${encodeURIComponent(desired.id)}`));
      if (found?.ok === true) {
        operation = 'update';
        targetId = desired.id;
        live = found.body;
      } else if (!isNotFound(found)) {
        return { failed: { naturalKey, error: `could not check for an existing app consent policy ${desired.id}: ${detailOf(found)}` } };
      }
    } else {
      const listed = await retryOperation(() => writer.read(version, listPath(entry, desired)));
      if (listed?.ok !== true) return { failed: { naturalKey, error: `could not list ${entry.collection} to look for an existing object: ${detailOf(listed)}` } };
      const existing = (listed.body?.value ?? []).filter(matcherFor(entry, desired));
      if (existing.length > 1) {
        return { failed: { naturalKey, error: `${existing.length} existing ${entry.resourceType} objects match the backup, so KEEL cannot tell which one to keep` } };
      }
      if (existing.length === 1) {
        operation = 'update';
        targetId = existing[0].id;
        live = existing[0];
      }
    }
  }
  if (operation === 'update' && !targetId) return { failed: { naturalKey, error: `${entry.resourceType} update has no target id` } };

  const followUp = directoryPolicyFollowUp(entry, resource, verb, desired, live, decision);
  const body = operation === 'create'
    ? directoryPolicyBody(entry, desired, 'create')
    : Object.fromEntries(changedDirectoryPolicyFields(entry, desired, live).map((field) => [field, directoryPolicyBody(entry, desired, 'update')[field]]));
  const conditionWrites = entry.family === 'permission-grant-policy'
    ? await missingConditionSets(writer, entry, desired, operation === 'create' ? null : targetId, { retryOperation })
    : [];
  if (conditionWrites.failed) return { failed: { naturalKey, error: conditionWrites.failed } };

  if (operation === 'update' && Object.keys(body).length === 0 && conditionWrites.length === 0) {
    return { applied: { naturalKey, targetId, followUp } };
  }
  if (mode === 'dry-run') return { applied: { naturalKey, targetId, followUp } };

  const journal = await journalBefore(rollbackClient, {
    runId, restoreRef, resource, operation, targetId, priorState: live ?? null, intendedState: desired,
  });
  if (!journal.ok) return { failed: { naturalKey, error: `refusing to ${operation}: rollback journal write failed` } };

  if (operation === 'create') {
    const created = await retryOperation(() => writer.write(version, entry.collection, { method: 'POST', body }));
    if (!created?.ok) {
      await journalOutcome(rollbackClient, journal, classifyWriteOutcome(created), { detail: detailOf(created) });
      return { failed: failure(naturalKey, created) };
    }
    targetId = created.body?.id ?? (entry.family === 'permission-grant-policy' ? desired.id : null);
    if (!targetId) {
      await journalOutcome(rollbackClient, journal, 'uncertain', { detail: 'create returned no id' });
      return { failed: { naturalKey, error: `${entry.resourceType} create returned no id` } };
    }
  } else if (Object.keys(body).length > 0) {
    const updated = await retryOperation(() => writer.write(version, `${entry.collection}/${encodeURIComponent(targetId)}`, { method: 'PATCH', body }));
    if (!updated?.ok) {
      await journalOutcome(rollbackClient, journal, classifyWriteOutcome(updated), { detail: detailOf(updated) });
      return { failed: failure(naturalKey, updated) };
    }
  }
  for (const write of conditionWrites) {
    const path = `${entry.collection}/${encodeURIComponent(targetId)}/${write.set}`;
    const added = await retryOperation(() => writer.write(version, path, { method: 'POST', body: write.body }));
    if (!added?.ok) {
      await journalOutcome(rollbackClient, journal, classifyWriteOutcome(added), { targetId, detail: `${write.set}: ${detailOf(added)}` });
      return { failed: failure(naturalKey, added) };
    }
  }

  const written = Object.keys(body).filter((field) => field !== 'id' && field !== 'isOrganizationDefault');
  const readPath = `${entry.collection}/${encodeURIComponent(targetId)}`;
  const reRead = await readBack(writer, version, readPath,
    (r) => isNotFound(r) || (r?.ok === true && directoryPolicyPostStateRefusal(entry, desired, r.body, written) !== null),
    { retryOperation, ...readAfterWrite });
  if (reRead?.ok !== true) {
    await journalOutcome(rollbackClient, journal, 'uncertain', { targetId, detail: `${operation} could not be re-read` });
    return { failed: failure(naturalKey, reRead) };
  }
  const postStateRefusal = directoryPolicyPostStateRefusal(entry, desired, reRead.body, written)
    ?? (operation === 'create' && entry.family === 'sts-policy' && reRead.body?.isOrganizationDefault === true
      ? `${entry.resourceType}: the recreated policy reads back as the organization default` : null);
  if (postStateRefusal) {
    await journalOutcome(rollbackClient, journal, 'uncertain', { targetId, postState: reRead.body, detail: 'directory policy post-state did not verify' });
    return { failed: { naturalKey, error: postStateRefusal } };
  }
  await journalOutcome(rollbackClient, journal, 'succeeded', { targetId, postState: reRead.body });
  return { applied: { naturalKey, targetId, followUp } };
}

/**
 * The include and exclude condition sets the backup holds that the live policy
 * lacks, as POST bodies. Extra live sets are left alone: removing one could
 * widen or narrow consent in ways a person must judge. A policy recreated in
 * this run (`targetId` null) has none.
 */
async function missingConditionSets(writer, entry, desired, targetId, { retryOperation }) {
  const writes = [];
  for (const set of CONDITION_SETS) {
    if (!Array.isArray(desired[set])) continue;
    let live = [];
    if (targetId) {
      const listed = await retryOperation(() => writer.read(entry.version, `${entry.collection}/${encodeURIComponent(targetId)}/${set}`));
      if (listed?.ok !== true) return Object.assign([], { failed: `could not read the ${set} of ${targetId}: ${detailOf(listed)}` });
      live = listed.body?.value ?? [];
    }
    for (const condition of desired[set]) {
      if (!live.some((existing) => sameCondition(existing, condition))) writes.push({ set, body: conditionSetBody(condition) });
    }
  }
  return writes;
}
