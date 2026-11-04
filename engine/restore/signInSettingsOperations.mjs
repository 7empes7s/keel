/**
 * Issue #994: restore of three backed-up sign-in settings.
 *
 * 1. Authentication contexts (authenticationContextClassReference). Each one
 *    has a fixed id, c1..c99, that Conditional Access policies (and SharePoint
 *    sites and sensitivity labels) point to. A write is an upsert:
 *    PATCH /identity/conditionalAccess/authenticationContextClassReferences/{id}
 *    creates the id when it is absent, so a create and an update both write
 *    to the backup's own id and never to another. Only displayName,
 *    description and isAvailable are sent. The dry run says in plain English
 *    what uses the id: the Conditional Access policies in the backup and live
 *    that require it. Making a used context available or unavailable changes
 *    sign-in, so it is a 'changes-sign-in' effect held behind the restore
 *    approval (safety/signInSettingEffects.mjs); its name and description are
 *    written without one. Delete is not registered.
 *
 * 2. Staged rollout (featureRolloutPolicy). A rollout switches a sign-in
 *    feature (cloud authentication instead of federation, for example) for
 *    the whole organization or for groups. Its groups are their own edge
 *    (relationship family 'rolloutAppliesTo'). Create and update write
 *    displayName, description, feature and isAppliedToOrganization, and add
 *    (never remove) the backup's groups that exist live, matched by their
 *    natural key; a group that is missing live is a step for a person. Every
 *    write runs only behind the break-glass lockout gate (like the tenant
 *    policies in tenantPolicyOperations.mjs), and a change to the feature,
 *    the scope or the groups is written only once its 'changes-sign-in'
 *    effects are approved. A recreated rollout lands switched off; switching
 *    it on (or off) is a separate effect, written only once approved, like a
 *    Conditional Access policy that lands report-only.
 *
 * 3. Certificate authorities (certificateBasedAuthConfiguration) stay manual
 *    by design: a wrong trusted certificate authority can let anyone holding a
 *    certificate from it sign in, or lock every certificate user out. The
 *    list is never written. A restore reports one step per backed-up
 *    authority: its issuer, whether it is a root or an intermediate, when it
 *    expires, its revocation list and whether it is missing or different live.
 *
 * Routes and fields follow the Graph v1.0 reference as declared; the build
 * container cannot reach learn.microsoft.com, so they are confirmed by each
 * type's live capture (ops/operator-queue.md).
 */
import { X509Certificate } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { effectApproved } from '../safety/contentEffects.mjs';
import {
  SIGN_IN_EFFECT, authenticationContextEffects, featureRolloutEffects, rolloutGroupsToAdd,
} from '../safety/signInSettingEffects.mjs';
import { classifyWriteOutcome } from './rollbackJournal.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';

export const SIGN_IN_SETTINGS_CONTRACT_VERSION = 1;

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const CONTEXTS = '/identity/conditionalAccess/authenticationContextClassReferences';
const ROLLOUTS = '/policies/featureRolloutPolicies';
const CA_POLICIES = '/identity/conditionalAccess/policies';

const record = (fields) => {
  // CLAUDE.md restore-writer rule: a record never lists a trust, certificate or sign-in field.
  const trust = fields.fields.filter((field) => isTrustField(fields.resourceType, field));
  if (trust.length) throw new Error(`${fields.resourceType} declares trust, certificate or sign-in fields a restore never writes: ${trust.join(', ')}`);
  return Object.freeze(fields);
};

export const SIGN_IN_SETTING_RECORDS = Object.freeze({
  authenticationContextClassReference: record({
    resourceType: 'authenticationContextClassReference',
    collection: CONTEXTS,
    version: 'v1.0',
    permission: 'Policy.ReadWrite.ConditionalAccess',
    docs: `${DOCS}/authenticationcontextclassreference-update?view=graph-rest-1.0`,
    operations: Object.freeze(['create', 'update']),
    // Both verbs PATCH the backup's own id: Graph creates it when it is absent.
    fields: Object.freeze(['displayName', 'description', 'isAvailable']),
    lockout: false,
    portalPath: 'Entra admin center > Protection > Conditional Access > Authentication contexts',
  }),
  featureRolloutPolicy: record({
    resourceType: 'featureRolloutPolicy',
    collection: ROLLOUTS,
    version: 'v1.0',
    permission: 'Policy.ReadWrite.FeatureRollout',
    docs: `${DOCS}/featurerolloutpolicies-post?view=graph-rest-1.0`,
    operations: Object.freeze(['create', 'update']),
    fields: Object.freeze(['displayName', 'description', 'feature', 'isAppliedToOrganization']),
    lockout: true,
    portalPath: 'Entra admin center > Hybrid management > Microsoft Entra Connect > Connect Sync > Enable staged rollout',
  }),
});

/** The types whose writes need the break-glass lockout gate (cli/keel-restore.mjs loads it for them). */
export const SIGN_IN_LOCKOUT_TYPES = Object.freeze(Object.values(SIGN_IN_SETTING_RECORDS)
  .filter((entry) => entry.lockout).map((entry) => entry.resourceType));

export function isSignInSettingGoverned(resourceType) {
  return Object.hasOwn(SIGN_IN_SETTING_RECORDS, resourceType);
}

// Graph names contexts in lower case; another spelling is refused, never rewritten.
const CONTEXT_ID = /^c([1-9]|[1-9][0-9])$/;
const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';
const sameText = (left, right) => (left ?? '') === (right ?? '');
const sameField = (field, desired, live) => (field === 'description' || field === 'displayName'
  ? sameText(desired, live) : isDeepStrictEqual(desired ?? null, live ?? null));
const lower = (value) => String(value ?? '').toLowerCase();
const quoted = (names) => names.map((name) => `"${name}"`).join(', ');
const detailOf = (result) => (result?.status !== undefined ? `status ${result.status}` : String(result?.error ?? 'no response').slice(0, 200));
const isNotFound = (result) => result?.ok === false && result?.status === 404;
const odataText = (value) => String(value).replace(/'/g, "''");

// ------------------------------------------------- authentication contexts

/** The Conditional Access policies (by name) that require authentication context `id`. */
export function policiesUsingContext(policies, id) {
  const wanted = lower(id);
  return [...new Set((policies ?? [])
    .filter((policy) => (policy?.conditions?.applications?.includeAuthenticationContextClassReferences ?? [])
      .some((ref) => lower(ref) === wanted))
    .map((policy) => String(policy.displayName ?? policy.id ?? 'unnamed policy')))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * What uses one context: the Conditional Access policies in the backup and
 * live that require it. `live` null means the live read failed; `inUse` is
 * false only when both lists were read and are empty.
 */
export function contextConsumers(id, { snapshotPolicies = null, livePolicies = null } = {}) {
  const snapshot = snapshotPolicies === null ? null : policiesUsingContext(snapshotPolicies, id);
  const live = livePolicies === null ? null : policiesUsingContext(livePolicies, id);
  const inUse = snapshot === null || live === null ? null : snapshot.length > 0 || live.length > 0;
  return Object.freeze({ snapshot, live, inUse });
}

/** The plain-English line the dry run shows for what uses a context. */
export function contextUsageText(id, consumers) {
  const parts = [];
  if (consumers?.snapshot === null || consumers?.snapshot === undefined) parts.push('the backup\'s Conditional Access policies were not checked');
  else if (consumers.snapshot.length > 0) parts.push(`in the backup, Conditional Access ${consumers.snapshot.length === 1 ? 'policy' : 'policies'} ${quoted(consumers.snapshot)}`);
  if (consumers?.live === null || consumers?.live === undefined) parts.push('the live Conditional Access policies could not be read, so KEEL treats it as used');
  else if (consumers.live.length > 0) parts.push(`live, Conditional Access ${consumers.live.length === 1 ? 'policy' : 'policies'} ${quoted(consumers.live)}`);
  const used = parts.length > 0 ? `Authentication context ${id} is used by: ${parts.join('; ')}.` : `Nothing in the backup or live uses authentication context ${id}.`;
  return `${used} SharePoint sites and sensitivity labels can also require it; KEEL does not back up which context they name, so check them in the SharePoint admin center and Microsoft Purview.`;
}

async function readAll(writer, version, path, retryOperation, maxPages = 50) {
  const value = [];
  let next = path;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await retryOperation(() => writer.read(version, next));
    if (result?.ok !== true) return null;
    value.push(...(result.body?.value ?? []));
    next = result.body?.['@odata.nextLink'];
    if (typeof next !== 'string' || next.length === 0) return value;
  }
  return null;
}

/**
 * cli/keel-restore.mjs: attaches to each planned authentication context what
 * uses it (`authenticationContextConsumers`): the backup's Conditional Access
 * policies (`snapshotPolicies`, every version in the snapshot) and the live
 * ones (read through `reader.collect`). The approval effects are judged on it.
 */
export async function attachAuthenticationContextConsumers(resources, { snapshotPolicies = [], reader = null } = {}) {
  if (!resources.some((resource) => resource.resourceType === 'authenticationContextClassReference')) return resources;
  let livePolicies = null;
  if (reader && typeof reader.collect === 'function') {
    try {
      const result = await reader.collect('v1.0', CA_POLICIES);
      livePolicies = result?.error || !Array.isArray(result?.items) ? null : result.items;
    } catch {
      livePolicies = null;
    }
  }
  return resources.map((resource) => {
    if (resource.resourceType !== 'authenticationContextClassReference') return resource;
    const id = resource.payload?.id ?? resource.live?.payload?.id ?? null;
    return { ...resource, authenticationContextConsumers: contextConsumers(id, { snapshotPolicies, livePolicies }) };
  });
}

// ------------------------------------------------------------ staged rollout

/**
 * cli/keel-restore.mjs: attaches to each planned rollout the groups it applies
 * to (`rolloutAppliesTo`): the backup's read (`desired`, from the snapshot's
 * 'rolloutAppliesTo' relationship sets) and the live one (`live`, from
 * collectRelationships on the target). Each is { outcome, groups: [{ id, name,
 * mailNickname }] }, or null when it was not read.
 */
export function attachRolloutAppliesTo(resources, { desired = new Map(), live = new Map() } = {}) {
  const asRead = (observation) => (observation ? Object.freeze({
    outcome: observation.outcome,
    groups: Object.freeze((observation.targets ?? []).map((target) => Object.freeze({
      id: target.targetId ?? target.edgeKey ?? null,
      name: String(target.attributes?.displayName ?? target.targetNaturalKey ?? target.targetId ?? 'unnamed group'),
      mailNickname: target.attributes?.mailNickname ?? null,
    }))),
  }) : null);
  return resources.map((resource) => {
    if (resource.resourceType !== 'featureRolloutPolicy') return resource;
    const key = `${resource.naturalKey}|rolloutAppliesTo`;
    return { ...resource, rolloutAppliesTo: Object.freeze({ desired: asRead(desired.get(key)), live: asRead(live.get(key)) }) };
  });
}

const APPROVE_STEP = 'Run the restore as a dry run, have someone other than you approve "Changes sign-in" in Approvals, then run it again. '
  + 'If restore approvals are turned off for Entra ID, running the reviewed dry run again writes it.';

function approvalStep(entry, fields, words) {
  return Object.freeze({
    kind: 'manual-setting', requirement: 'signInApproval', fields: Object.freeze(fields), portalPath: entry.portalPath,
    description: `${words} This changes how people sign in (${fields.join(', ')}), so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
  });
}

/** The effects of this write that the promotion did not approve. */
function unapproved(effects, resource, approvedContentEffects) {
  return effects.map((effect) => ({ naturalKey: resource.naturalKey, resourceType: resource.resourceType, ...effect }))
    .filter((effect) => !effectApproved(effect, approvedContentEffects));
}

// ------------------------------------------------------- write-time refusals

/**
 * Refuses a write before any Graph call, or returns null: { outcome, reason,
 * completion? }. A lockout-sensitive write without an allowing lockout gate is
 * skipped, never written.
 */
export function signInSettingWriteRefusal(resource, verb, { lockoutGate = null } = {}) {
  const entry = SIGN_IN_SETTING_RECORDS[resource?.resourceType];
  if (!entry) return null;
  if (!entry.operations.includes(verb)) return { outcome: 'failed', reason: `${entry.resourceType} ${verb} is not written by KEEL` };
  const capability = capabilityFor(entry.resourceType, verb);
  if (!isSupportedClaim(capability.claim)) {
    return { outcome: 'failed', reason: `${entry.resourceType} ${verb} is not a registered write capability (claim: ${capability.claim})` };
  }
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { outcome: 'failed', reason: `${entry.resourceType}: the backup holds nothing to restore` };
  if (verb === 'update' && !present(resource)) {
    return { outcome: 'failed', reason: `dependency: no live ${entry.resourceType} was observed, so the update cannot be checked against it` };
  }
  if (entry.resourceType === 'authenticationContextClassReference') {
    if (typeof payload.id !== 'string' || !CONTEXT_ID.test(payload.id)) {
      return { outcome: 'failed', reason: `authenticationContextClassReference: the backup's id ${JSON.stringify(payload.id ?? null)} is not one of c1..c99` };
    }
    const liveId = resource.live?.payload?.id;
    if (present(resource) && lower(liveId) !== lower(payload.id)) {
      return { outcome: 'failed', reason: `authenticationContextClassReference: the live context is ${liveId}, not the backup's ${payload.id}; a context is only ever written to its own id` };
    }
  }
  if (entry.resourceType === 'featureRolloutPolicy') {
    if (typeof payload.displayName !== 'string' || payload.displayName.length === 0) return { outcome: 'failed', reason: 'featureRolloutPolicy: the backup has no displayName' };
    if (typeof payload.feature !== 'string' || payload.feature.length === 0) return { outcome: 'failed', reason: 'featureRolloutPolicy: the backup names no feature' };
  }
  if (entry.lockout) {
    if (!lockoutGate || typeof lockoutGate.evaluate !== 'function') {
      return { outcome: 'skipped', reason: `tenant-lockout policy: ${entry.resourceType} is written only behind the break-glass lockout gate, and none was supplied` };
    }
    const verdict = lockoutGate.evaluate({ resourceType: entry.resourceType, desired: payload, naturalKey: resource.naturalKey });
    if (verdict?.allowed !== true) {
      return { outcome: 'skipped', reason: `tenant-lockout policy: ${entry.resourceType} withheld by the break-glass lockout gate — ${verdict?.reason ?? 'no verdict'}` };
    }
  }
  return null;
}

// --------------------------------------------------- certificate authorities

export const CERTIFICATE_AUTHORITY_PORTAL_PATH = 'Entra admin center > Protection > Security Center > Certificate authorities';

function certificateExpiry(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  try {
    return new Date(new X509Certificate(Buffer.from(base64, 'base64')).validTo).toISOString();
  } catch {
    return null;
  }
}

const authorityKey = (authority) => lower(authority?.issuerSki ?? authority?.issuer ?? authority?.certificate ?? '');
const AUTHORITY_FIELDS = ['certificate', 'isRootAuthority', 'certificateRevocationListUrl', 'deltaCertificateRevocationListUrl', 'issuer'];

/**
 * One line per backed-up certificate authority: issuer, root or intermediate,
 * expiry (read from the certificate), revocation list and whether it is
 * missing or different live. `live` null means the live list was not read.
 */
export function certificateAuthorityReview(payload, livePayload) {
  const backed = payload?.certificateAuthorities ?? [];
  const live = Array.isArray(livePayload?.certificateAuthorities) ? livePayload.certificateAuthorities : null;
  return backed.map((authority) => {
    const match = live?.find((entry) => authorityKey(entry) === authorityKey(authority)) ?? null;
    let status = 'not checked live';
    if (live) {
      const differs = match && AUTHORITY_FIELDS.filter((field) => !isDeepStrictEqual(authority?.[field] ?? null, match?.[field] ?? null));
      status = !match ? 'missing live' : differs.length > 0 ? `different live (${differs.join(', ')})` : 'the same live';
    }
    return Object.freeze({
      issuer: authority?.issuer ?? 'unnamed issuer',
      kind: authority?.isRootAuthority === true ? 'root' : 'intermediate',
      expires: certificateExpiry(authority?.certificate),
      crl: authority?.certificateRevocationListUrl ?? null,
      status,
    });
  });
}

/**
 * The step for a person for a certificate-based authentication restore: the
 * list is never written. Always skipped, with the review of each authority.
 */
export function certificateAuthorityRefusal(resource, verb) {
  if (resource?.resourceType !== 'certificateBasedAuthConfiguration') return null;
  const review = verb === 'delete' ? [] : certificateAuthorityReview(resource.payload, present(resource) ? resource.live.payload : null);
  const lines = review.map((entry) => `${entry.issuer} (${entry.kind}; expires ${entry.expires ?? 'unknown'}; revocation list ${entry.crl ?? 'none'}): ${entry.status}`);
  const needed = review.filter((entry) => entry.status !== 'the same live');
  const description = `KEEL never writes the trusted certificate authorities: a wrong one lets anyone holding a certificate from it sign in, or locks every certificate user out. `
    + (lines.length > 0 ? `Backed-up authorities: ${lines.join('; ')}. ` : 'The backup holds no certificate authority. ')
    + (needed.length > 0
      ? `Upload or correct ${needed.length === 1 ? 'it' : 'them'} by hand in the ${CERTIFICATE_AUTHORITY_PORTAL_PATH}, using the certificate in the backup, and test a certificate sign-in before closing the session.`
      : `Nothing differs; check them in the ${CERTIFICATE_AUTHORITY_PORTAL_PATH}.`);
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: ${description}`,
    completion: Object.freeze([Object.freeze({
      kind: 'manual-setting', requirement: 'certificateAuthorities', portalPath: CERTIFICATE_AUTHORITY_PORTAL_PATH,
      authorities: Object.freeze(review), description,
    })]),
  });
}

// ---------------------------------------------------------------- the writer

/**
 * One write of a governed type: the registered writer applyWave calls
 * (writers/entra.mjs) with the registry's ctx (writers/registry.mjs) plus
 * `lockoutGate`. Returns { applied } (with `changes`, `usedBy`, `completion`),
 * { skipped } or { failed }.
 */
export async function applySignInSettingWrite(writer, resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const entry = SIGN_IN_SETTING_RECORDS[resource.resourceType];
  if (!entry) return { failed: { naturalKey, error: `${resource.resourceType} is not a sign-in setting KEEL writes` } };
  const refusal = signInSettingWriteRefusal(resource, verb, { lockoutGate: ctx.lockoutGate ?? null });
  if (refusal) {
    return refusal.outcome === 'skipped'
      ? { skipped: { naturalKey, reason: refusal.reason, ...(refusal.completion ? { completion: refusal.completion } : {}) } }
      : { failed: { naturalKey, error: refusal.reason } };
  }
  return entry.resourceType === 'authenticationContextClassReference'
    ? applyContextWrite(writer, entry, resource, verb, ctx)
    : applyRolloutWrite(writer, entry, resource, verb, ctx);
}

const io = (ctx) => ({
  mode: ctx.mode ?? 'enforce',
  retryOperation: ctx.retryOperation ?? ((operation) => operation()),
  journal: ctx.journalBeforeMutation ?? (async () => ({ ok: true, entryId: null })),
  note: ctx.noteOutcome ?? (async () => {}),
  readBack: ctx.readAfterWrite ?? null,
  approved: ctx.approvedContentEffects ?? [],
});

async function reRead(writer, version, path, isStale, run) {
  if (run.readBack) return run.readBack(version, path, isStale);
  return run.retryOperation(() => writer.read(version, path));
}

async function applyContextWrite(writer, entry, resource, verb, ctx) {
  const run = io(ctx);
  const { naturalKey } = resource;
  const desired = resource.payload;
  const id = desired.id;
  const path = `${entry.collection}/${encodeURIComponent(id)}`;
  const live = present(resource) ? resource.live.payload : null;

  // What uses the id: attached by the plan, or (when it was not) read here,
  // with the backup's policies unknown.
  let consumers = resource.authenticationContextConsumers ?? null;
  if (!consumers) {
    const policies = await readAll(writer, 'v1.0', CA_POLICIES, run.retryOperation);
    consumers = contextConsumers(id, { snapshotPolicies: null, livePolicies: policies });
  }
  const usedBy = contextUsageText(id, consumers);
  const changed = entry.fields.filter((field) => desired[field] !== undefined && (!live || !sameField(field, desired[field], live[field])));

  // Making a used context available or unavailable waits for its approval;
  // the name and description are written without one.
  const completion = [];
  let fields = changed;
  if (changed.includes('isAvailable') && run.mode !== 'dry-run') {
    const effects = authenticationContextEffects({ ...resource, verb, authenticationContextConsumers: consumers });
    const open = unapproved(effects, resource, run.approved);
    if (open.length > 0) {
      // A create is held whole: the context is not made without its availability.
      fields = verb === 'create' && !live ? [] : changed.filter((field) => field !== 'isAvailable');
      completion.push(approvalStep(entry, ['isAvailable'],
        `Set authentication context ${id} to ${desired.isAvailable ? 'available' : 'not available'} (it is ${live?.isAvailable === true ? 'available' : live ? 'not available' : 'absent'} now) in the ${entry.portalPath}. ${usedBy}`));
    }
  }
  const changes = { fields };
  const done = (extra = {}) => ({
    applied: { naturalKey, targetId: id, changes, usedBy, ...(completion.length > 0 ? { completion } : {}), ...extra },
  });
  if (fields.length === 0) {
    if (completion.length > 0) return { skipped: { naturalKey, reason: `manual: ${completion[0].description}`, completion, usedBy } };
    return done();
  }
  if (run.mode === 'dry-run') return done();

  const body = Object.fromEntries(fields.map((field) => [field, desired[field]]));
  const journal = await run.journal({ operation: verb, targetId: id, priorState: live, intendedState: { ...(live ?? {}), ...body, id } });
  if (!journal.ok) return { failed: { naturalKey, error: `refusing to ${verb}: rollback journal write failed` } };
  const written = await run.retryOperation(() => writer.write(entry.version, path, { method: 'PATCH', body }));
  if (!written?.ok) {
    await run.note(journal, classifyWriteOutcome(written), { detail: detailOf(written) });
    return { failed: { naturalKey, error: JSON.stringify(written?.body ?? written?.error ?? null), ...(written?.status !== undefined ? { status: written.status } : {}) } };
  }
  const wrong = (body2) => fields.filter((field) => !sameField(field, desired[field], body2?.[field]));
  const after = await reRead(writer, entry.version, path, (r) => isNotFound(r) || (r?.ok === true && wrong(r.body).length > 0), run);
  if (after?.ok !== true) {
    await run.note(journal, 'uncertain', { targetId: id, detail: `${verb} could not be re-read` });
    return { failed: { naturalKey, error: `authentication context ${id} could not be read back: ${detailOf(after)}` } };
  }
  if (lower(after.body?.id) !== lower(id) || wrong(after.body).length > 0) {
    await run.note(journal, 'uncertain', { targetId: id, postState: after.body, detail: 'authentication context post-state did not verify' });
    return { failed: { naturalKey, error: `post-state: authentication context ${id} did not read back as written (${wrong(after.body).join(', ') || 'id'})` } };
  }
  await run.note(journal, 'succeeded', { targetId: id, postState: after.body });
  return done();
}

/**
 * The live group for one backed-up group, or why not. The backed-up id comes
 * first: in the same tenant it is the same group, so a newer group that only
 * shares the name is never picked over it. Otherwise (another tenant, a group
 * recreated since) the one group with the same natural key (mail nickname,
 * else name) is used.
 */
async function findGroup(writer, group, run) {
  const sameKey = (object) => (group.mailNickname ? lower(object?.mailNickname) === lower(group.mailNickname) : sameText(object?.displayName, group.name));
  if (typeof group.id === 'string' && group.id.length > 0) {
    const own = await run.retryOperation(() => writer.read('v1.0', `/groups/${encodeURIComponent(group.id)}?$select=id,displayName,mailNickname`));
    if (own?.ok === true && typeof own.body?.id === 'string' && sameKey(own.body)) return { id: own.body.id };
    if (own?.ok !== true && !isNotFound(own)) return { problem: `it could not be looked up (${detailOf(own)})` };
  }
  const filter = group.mailNickname
    ? `mailNickname eq '${odataText(group.mailNickname)}'`
    : `displayName eq '${odataText(group.name)}'`;
  const found = await run.retryOperation(() => writer.read('v1.0', `/groups?$filter=${encodeURIComponent(filter)}&$select=id,displayName,mailNickname`));
  if (found?.ok !== true) return { problem: `it could not be looked up (${detailOf(found)})` };
  const matches = found.body?.value ?? [];
  if (matches.length === 1 && typeof matches[0]?.id === 'string') return { id: matches[0].id };
  return { problem: matches.length === 0 ? 'no group with that name exists in this tenant' : `${matches.length} groups have that name` };
}

const appliesToPath = (id) => `${ROLLOUTS}/${encodeURIComponent(id)}/appliesTo`;
const appliesToIds = (body) => new Set((body?.appliesTo ?? body?.value ?? []).map((object) => lower(object?.id)));

async function applyRolloutWrite(writer, entry, resource, verb, ctx) {
  const run = io(ctx);
  const { naturalKey } = resource;
  const desired = resource.payload;
  const effects = featureRolloutEffects({ ...resource, verb });
  const main = effects.filter((effect) => effect.field !== 'isEnabled');
  const switching = effects.find((effect) => effect.field === 'isEnabled') ?? null;

  // The feature, scope and groups are written only once their effects are
  // approved. A dry run plans the write and lists the effects for review.
  if (run.mode !== 'dry-run') {
    const open = unapproved(main, resource, run.approved);
    if (open.length > 0) {
      const fields = [...new Set(open.map((effect) => effect.field))];
      const step = approvalStep(entry, fields, `The staged rollout "${desired.displayName}" is not ${verb === 'create' ? 'recreated' : 'updated'} yet.`);
      return { skipped: { naturalKey, reason: `manual: ${step.description}`, completion: [step] } };
    }
  }

  let targetId = present(resource) ? (resource.live.targetId ?? resource.live.payload?.id ?? resource.targetId ?? null) : null;
  let live = present(resource) ? resource.live.payload : null;
  let operation = verb;
  // A create first looks for the rollout a previous run (or a person) made:
  // the same name and feature.
  if (verb === 'create') {
    const listed = await readAll(writer, entry.version, entry.collection, run.retryOperation);
    if (listed === null) return { failed: { naturalKey, error: `could not list ${entry.collection} to look for an existing rollout` } };
    const twins = listed.filter((policy) => sameText(policy?.displayName, desired.displayName) && policy?.feature === desired.feature);
    if (twins.length > 1) return { failed: { naturalKey, error: `${twins.length} staged rollouts named "${desired.displayName}" exist for ${desired.feature}, so KEEL cannot tell which one to keep` } };
    if (twins.length === 1) {
      operation = 'update';
      targetId = twins[0].id;
      live = twins[0];
    }
  }
  if (operation === 'update' && !targetId) return { failed: { naturalKey, error: 'featureRolloutPolicy update has no target id' } };

  const fields = entry.fields.filter((field) => desired[field] !== undefined
    && (operation === 'create' || !sameField(field, desired[field], live?.[field])));

  // Groups: add-only, each matched live by its natural key; a missing one is a step.
  const completion = [];
  const toAdd = [];
  const names = rolloutGroupsToAdd({ ...resource, live: operation === 'create' ? null : resource.live }) ?? [];
  const groups = (resource.rolloutAppliesTo?.desired?.groups ?? []).filter((group) => names.some((name) => lower(name) === lower(group.name)));
  if (desired.isAppliedToOrganization !== true) {
    const missing = [];
    for (const group of groups) {
      const found = await findGroup(writer, group, run);
      if (found.id) toAdd.push({ ...group, targetId: found.id });
      else missing.push(`"${group.name}" (${found.problem})`);
    }
    if (missing.length > 0) {
      completion.push(Object.freeze({
        kind: 'manual-setting', requirement: 'rolloutGroups', portalPath: entry.portalPath,
        description: `Add ${missing.join(', ')} to the staged rollout "${desired.displayName}" by hand in the ${entry.portalPath}, once the group exists. KEEL adds only groups it finds in this tenant.`,
      }));
    }
    if (!resource.rolloutAppliesTo?.desired || !['complete', 'complete-empty'].includes(resource.rolloutAppliesTo.desired.outcome)) {
      completion.push(Object.freeze({
        kind: 'manual-setting', requirement: 'rolloutGroups', portalPath: entry.portalPath,
        description: `The backup did not read which groups the staged rollout "${desired.displayName}" applies to, so KEEL adds none. Check its groups by hand in the ${entry.portalPath}.`,
      }));
    } else if (operation === 'update' && verb === 'update' && rolloutGroupsToAdd(resource) === null) {
      completion.push(Object.freeze({
        kind: 'manual-setting', requirement: 'rolloutGroups', portalPath: entry.portalPath,
        description: `KEEL could not read which groups the staged rollout "${desired.displayName}" applies to now, so it adds none. Compare them with the backup by hand in the ${entry.portalPath}.`,
      }));
    }
  }

  // On or off is its own approved step; a recreated rollout lands off.
  const switchApproved = switching && run.mode !== 'dry-run' && unapproved([switching], resource, run.approved).length === 0;
  if (switching && !switchApproved) {
    completion.push(approvalStep(entry, ['isEnabled'],
      `Switch the staged rollout "${desired.displayName}" ${switching.after ? 'on' : 'off'} (KEEL ${operation === 'create' ? 'recreates it switched off' : `leaves it ${switching.before ? 'on' : 'off'}`}) in the ${entry.portalPath}, after checking who it applies to.`));
  }

  const changes = {
    fields: operation === 'create' ? [...fields, 'isEnabled'] : fields,
    ...(toAdd.length > 0 ? { groupsAdded: toAdd.map((group) => group.name) } : {}),
    ...(switchApproved ? { switched: switching.after ? 'on' : 'off' } : {}),
  };
  const done = (id) => ({ applied: { naturalKey, targetId: id, changes, ...(completion.length > 0 ? { completion } : {}) } });
  if (operation === 'update' && fields.length === 0 && toAdd.length === 0 && !switchApproved) return done(targetId);
  if (run.mode === 'dry-run') return done(targetId);

  const body = Object.fromEntries(fields.map((field) => [field, desired[field]]));
  if (operation === 'create') body.isEnabled = false;
  const journal = await run.journal({ operation, targetId, priorState: live, intendedState: { ...(live ?? {}), ...body } });
  if (!journal.ok) return { failed: { naturalKey, error: `refusing to ${operation}: rollback journal write failed` } };
  // Once one write landed, a later refusal leaves the tenant changed: 'uncertain', never 'failed'.
  let changedTenant = false;
  const fail = async (result, what) => {
    await run.note(journal, changedTenant ? 'uncertain' : classifyWriteOutcome(result), { ...(targetId ? { targetId } : {}), detail: `${what}: ${detailOf(result)}` });
    return { failed: { naturalKey, error: `${what} failed: ${JSON.stringify(result?.body ?? result?.error ?? null)}`, ...(result?.status !== undefined ? { status: result.status } : {}) } };
  };

  if (operation === 'create') {
    const created = await run.retryOperation(() => writer.write(entry.version, entry.collection, { method: 'POST', body }));
    if (!created?.ok) return fail(created, 'creating the staged rollout');
    changedTenant = true;
    targetId = created.body?.id ?? null;
    if (!targetId) {
      await run.note(journal, 'uncertain', { detail: 'create returned no id' });
      return { failed: { naturalKey, error: 'featureRolloutPolicy create returned no id' } };
    }
  } else if (Object.keys(body).length > 0) {
    const updated = await run.retryOperation(() => writer.write(entry.version, `${entry.collection}/${encodeURIComponent(targetId)}`, { method: 'PATCH', body }));
    if (!updated?.ok) return fail(updated, 'updating the staged rollout');
    changedTenant = true;
  }
  // A rollout found live (or adopted) may already hold a group: only the others are added.
  let adding = toAdd;
  if (operation === 'update' && toAdd.length > 0) {
    const current = await run.retryOperation(() => writer.read(entry.version, `${entry.collection}/${encodeURIComponent(targetId)}?$expand=appliesTo`));
    if (current?.ok !== true) return fail(current, 'reading the groups the staged rollout applies to');
    const held = appliesToIds(current.body);
    adding = toAdd.filter((group) => !held.has(lower(group.targetId)));
  }
  for (const group of adding) {
    const added = await run.retryOperation(() => writer.write(entry.version, `${appliesToPath(targetId)}/$ref`, {
      method: 'POST', body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${group.targetId}` },
    }));
    if (!added?.ok) return fail(added, `adding group "${group.name}"`);
    changedTenant = true;
  }
  if (switchApproved) {
    const switched = await run.retryOperation(() => writer.write(entry.version, `${entry.collection}/${encodeURIComponent(targetId)}`, { method: 'PATCH', body: { isEnabled: switching.after } }));
    if (!switched?.ok) return fail(switched, `switching the staged rollout ${switching.after ? 'on' : 'off'}`);
  }

  const path = `${entry.collection}/${encodeURIComponent(targetId)}?$expand=appliesTo`;
  const wantOn = switchApproved ? switching.after : (operation === 'create' ? false : null);
  const problems = (read) => [
    ...fields.filter((field) => !sameField(field, desired[field], read?.[field])),
    ...(wantOn !== null && (read?.isEnabled === true) !== wantOn ? ['isEnabled'] : []),
    ...(toAdd.some((group) => !appliesToIds(read).has(lower(group.targetId))) ? ['appliesTo'] : []),
  ];
  const after = await reRead(writer, entry.version, path, (r) => isNotFound(r) || (r?.ok === true && problems(r.body).length > 0), run);
  if (after?.ok !== true) {
    await run.note(journal, 'uncertain', { targetId, detail: `${operation} could not be re-read` });
    return { failed: { naturalKey, error: `the staged rollout could not be read back: ${detailOf(after)}` } };
  }
  const wrong = problems(after.body);
  if (wrong.length > 0) {
    await run.note(journal, 'uncertain', { targetId, postState: after.body, detail: 'staged rollout post-state did not verify' });
    return { failed: { naturalKey, error: `post-state: the staged rollout did not read back as written (${wrong.join(', ')})` } };
  }
  await run.note(journal, 'succeeded', { targetId, postState: after.body });
  return done(targetId);
}

/** The family ledger: every record with its claim. */
export function buildSignInSettingsLedger() {
  return Object.freeze(Object.values(SIGN_IN_SETTING_RECORDS).map((entry) => Object.freeze({
    resourceType: entry.resourceType,
    operations: entry.operations,
    route: entry.resourceType === 'authenticationContextClassReference' ? `PATCH ${entry.collection}/{id}` : `POST ${entry.collection}; PATCH ${entry.collection}/{id}; POST ${entry.collection}/{id}/appliesTo/$ref`,
    permission: entry.permission,
    fields: entry.fields,
    lockout: entry.lockout,
    effect: SIGN_IN_EFFECT,
  })));
}
