/**
 * Issue #993: entitlement management, part 2. Connected organizations and
 * access package assignment policies (who may request a package, who approves
 * and who reviews).
 *
 *  - connectedOrganization: create and update of its name, description, state
 *    and identity sources. An identity source points at another tenant or
 *    domain that KEEL cannot check from this one, so the dry run lists it in
 *    plain English and every write sits behind the restore approval
 *    (approvalHeld.mjs; the effect is shown by identitySourceText). Graph
 *    refuses a tenant that does not exist: that answer is reported, never
 *    retried. A federated domain source carries its sign-in issuer, a trust
 *    field a restore never writes, so it is a manual step. Sponsors (internal
 *    and external) are added for users and groups that exist in the target,
 *    matched by natural key; a missing one is a manual step that names it. A
 *    sponsor is never removed. Delete is not registered.
 *  - accessPackageAssignmentPolicy: create and update (Graph replaces the whole
 *    policy, PUT). The access package is the one this run restored or the live
 *    one with the same natural key. Every user, group and connected
 *    organization the policy names (who may request, approvers, reviewers) is
 *    matched in the target by natural key; relative subjects (the requestor's
 *    manager, sponsors) need no match. A subject that cannot be matched holds
 *    the whole policy as a manual step naming who is missing: a policy with
 *    fewer approvers is weaker, so it is never written short. Every change to
 *    who may request, approve or review is held behind the restore approval;
 *    the step names the loosening when there is one. Custom extensions (Logic
 *    Apps) and their sign-in are never written: they are a manual step, and an
 *    update of a live policy that has them is a manual step too (the replace
 *    would take them off).
 *
 * Assignments stay manual: they are granted through a request, never copied.
 * Routes follow the Graph v1.0 references and are fixture-tested, not
 * live-qualified.
 */
import { remappingFor } from '../coverage/qualification.mjs';
import { VERBATIM_RESOLUTIONS, resolveSymbol } from '../graph/resolver.mjs';
import { identitySourceText } from '../safety/contentEffects.mjs';
import { createdOnce, readAllPages, withApprovalGate } from './approvalHeld.mjs';
import { defineRecord, outcomeDetail, sameValue, stripGraph } from './recordWriter.mjs';

const EM = '/identityGovernance/entitlementManagement';
export const CONNECTED_ORGANIZATIONS = `${EM}/connectedOrganizations`;
export const ASSIGNMENT_POLICIES = `${EM}/assignmentPolicies`;
const PERMISSION = 'EntitlementManagement.ReadWrite.All';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const v1 = (page) => `${DOCS}/${page}?view=graph-rest-1.0`;
const PORTAL = 'the Entra admin center, under Identity Governance, Entitlement management';
const GRAPH_OBJECT = 'https://graph.microsoft.com/v1.0/directoryObjects/';

const lower = (value) => String(value ?? '').toLowerCase();
const list = (value) => (Array.isArray(value) ? value : []);

function setAt(root, path, value) {
  const segments = String(path).split(/\.|\[|\]/).filter(Boolean).map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
  const walk = (node, index) => {
    const copy = Array.isArray(node) ? node.slice() : { ...(node ?? {}) };
    const key = segments[index];
    copy[key] = index === segments.length - 1 ? value : walk(node?.[key], index + 1);
    return copy;
  };
  return segments.length ? walk(root, 0) : root;
}
const getAt = (root, path) => String(path).split(/\.|\[|\]/).filter(Boolean)
  .reduce((value, segment) => value?.[/^\d+$/.test(segment) ? Number(segment) : segment], root);

/** The name a reference's symbol gives (`user:ann@contoso.com` gives ann@contoso.com). */
const symbolName = (symbol) => (typeof symbol === 'string' && symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : null);
const referenceAt = (resource, field) => (resource.references ?? []).find((ref) => String(ref?.field ?? '') === field) ?? null;

/**
 * The target's id for the id held at `field`: { targetId } when the reference
 * resolves (the same id when it resolves verbatim), else { missing }.
 */
function targetFor(resource, field, ctx) {
  const ref = referenceAt(resource, field);
  if (typeof ref?.symbol !== 'string') return { missing: true, ref };
  const result = resolveSymbol(ref.symbol, ctx.referenceContext);
  if (!result.resolved) return { missing: true, ref };
  return { targetId: VERBATIM_RESOLUTIONS.has(result.via) ? getAt(resource.payload, field) : result.targetId, ref };
}

const noContext = (naturalKey, what) => ({ failed: { naturalKey, error: `no reference context: ${what} cannot be matched in the target, so nothing is written` } });

// ------------------------------------------------------ connected organization

const sourceKind = (source) => stripGraph(source?.['@odata.type']);
/** A federated domain source carries its sign-in issuer (a trust field): never written. */
const isFederation = (source) => sourceKind(source) === 'externalDomainFederation';
const sourceKey = (source) => `${lower(sourceKind(source))}|${lower(source?.tenantId ?? source?.domainName)}|${lower(source?.cloudInstance)}`;
const sameSources = (desired, live) => {
  const keys = (value) => list(value).filter((source) => !isFederation(source)).map(sourceKey).sort();
  return sameValue(keys(desired), keys(live));
};

const SPONSOR_FIELDS = Object.freeze(['internalSponsors', 'externalSponsors']);
const SPONSOR_WORDS = Object.freeze({ internalSponsors: 'internal sponsor', externalSponsors: 'external sponsor' });
const sponsorName = (resource, field, index) => {
  const sponsor = resource.payload?.[field]?.[index];
  return symbolName(referenceAt(resource, `${field}[${index}].id`)?.symbol) ?? sponsor?.userPrincipalName ?? sponsor?.displayName ?? 'a sponsor the backup does not name';
};

/** The body Graph takes: no sponsors (their own lists) and no federated domain source. */
function connectedOrganizationBody(body) {
  const out = { ...body };
  for (const field of SPONSOR_FIELDS) delete out[field];
  if (Array.isArray(out.identitySources)) out.identitySources = out.identitySources.filter((source) => !isFederation(source));
  return out;
}

function federationStep(resource) {
  const live = new Set(list(resource.live?.payload?.identitySources).filter(isFederation).map(sourceKey));
  const federated = list(resource.payload?.identitySources).filter((source) => isFederation(source) && !live.has(sourceKey(source)));
  if (federated.length === 0) return null;
  const description = `A restore never writes sign-in or trust settings, so ${federated.map(identitySourceText).join(' and ')} `
    + `${federated.length === 1 ? 'was' : 'were'} not added to the connected organization. Add ${federated.length === 1 ? 'it' : 'them'} by hand in ${PORTAL}, under Connected organizations, Directory + domain, after checking the identity provider with that organization.`;
  return Object.freeze({ kind: 'manual-setting', requirement: 'trustFields', fields: Object.freeze(['identitySources']), description });
}

function missingSponsorStep(missing) {
  if (missing.length === 0) return null;
  const description = `${missing.map(({ field, name }) => `the ${SPONSOR_WORDS[field]} ${name}`).join(', ')} `
    + `${missing.length === 1 ? 'does' : 'do'} not exist in the target, so ${missing.length === 1 ? 'it was' : 'they were'} not added. `
    + `Add the right people as sponsors by hand in ${PORTAL}, under Connected organizations, Sponsors.`;
  return Object.freeze({ kind: 'manual-setting', requirement: 'sponsors', fields: Object.freeze([...new Set(missing.map(({ field }) => field))]), description });
}

/**
 * Points a connected organization's sponsors at the target's users and groups,
 * matched by natural key. Returns { resource } (`sponsorTargets` holds the
 * target ids per list, `missingSponsors` who is not there) or { failed } / { skipped }.
 */
export function targetConnectedOrganization(resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { failed: { naturalKey, error: 'the backup holds no connected organization to write' } };
  if (verb === 'create' && list(payload.identitySources).length > 0 && list(payload.identitySources).every(isFederation)) {
    const step = federationStep(resource);
    return { skipped: { naturalKey, reason: `manual: ${step.description} Nothing was written: Graph needs another identity source to create it.`, completion: [step] } };
  }
  const holdsSponsors = SPONSOR_FIELDS.some((field) => list(payload[field]).length > 0);
  if (holdsSponsors && !ctx.referenceContext) return noContext(naturalKey, 'its sponsors');
  let rewritten = payload;
  const sponsorTargets = {};
  const missingSponsors = [];
  for (const field of SPONSOR_FIELDS) {
    sponsorTargets[field] = [];
    list(payload[field]).forEach((sponsor, index) => {
      const found = targetFor(resource, `${field}[${index}].id`, ctx);
      if (found.missing || typeof found.targetId !== 'string') {
        missingSponsors.push({ field, name: sponsorName(resource, field, index) });
        return;
      }
      rewritten = setAt(rewritten, `${field}[${index}].id`, found.targetId);
      sponsorTargets[field].push(found.targetId);
    });
  }
  const moved = SPONSOR_FIELDS.some((field) => list(payload[field]).some((sponsor, index) => lower(sponsor?.id) !== lower(rewritten[field]?.[index]?.id)));
  if (moved && !remappingFor(resource.resourceType, verb).qualified) {
    return { failed: { naturalKey, error: `unqualified-remapping: connectedOrganization ${verb} would add sponsors with different ids, and reference remapping is not proven for this operation` } };
  }
  // Sponsor references stay (the approval names sponsors by them; they are never in
  // the body). An identity source's tenant is another directory's id, never remapped.
  const references = (resource.references ?? []).filter((ref) => SPONSOR_FIELDS.includes(String(ref?.field ?? '').split(/[.[]/)[0]));
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, references, sponsorTargets, missingSponsors } };
}

const orgPath = (id) => `${CONNECTED_ORGANIZATIONS}/${encodeURIComponent(id)}`;

/** The steps a write leaves for a person: a federated domain, missing sponsors. */
const connectedOrganizationSteps = (resource) => [federationStep(resource), missingSponsorStep(resource.missingSponsors ?? [])].filter(Boolean);

/** The sponsors a write would add: { field: [ids] } of those not on the live organization, or { error }. */
async function sponsorsToAdd(io, resource, targetId) {
  const add = {};
  for (const field of SPONSOR_FIELDS) {
    const wanted = resource.sponsorTargets?.[field] ?? [];
    if (wanted.length === 0) continue;
    let have = [];
    if (targetId) {
      const listed = await readAllPages(io, 'v1.0', `${orgPath(targetId)}/${field}`);
      if (listed.error) return { error: `the connected organization's ${SPONSOR_WORDS[field]}s could not be read (${listed.error})` };
      have = listed.value.map((row) => lower(row?.id));
    }
    const missing = wanted.filter((id) => !have.includes(lower(id)));
    if (missing.length) add[field] = missing;
  }
  return { add };
}

async function connectedOrganizationPlan(io, { resource, targetId, payload }) {
  const sources = list(payload.identitySources).filter((source) => !isFederation(source)).map(identitySourceText);
  const planned = await sponsorsToAdd(io, resource, targetId);
  const sponsorsAdded = planned.error ? null : Object.values(planned.add).reduce((sum, ids) => sum + ids.length, 0);
  return { ...(sources.length ? { identitySources: sources } : {}), ...(sponsorsAdded ? { sponsorsAdded } : {}) };
}

/** After the organization is written: each missing sponsor added ($ref), then read back. */
async function connectedOrganizationAfterWrite(io, { resource, targetId }) {
  const completion = connectedOrganizationSteps(resource);
  const planned = await sponsorsToAdd(io, resource, targetId);
  if (planned.error) return { error: planned.error };
  let added = 0;
  for (const [field, ids] of Object.entries(planned.add)) {
    for (const id of ids) {
      const result = await io.retryOperation(() => io.writer.write('v1.0', `${orgPath(targetId)}/${field}/$ref`, { method: 'POST', body: { '@odata.id': `${GRAPH_OBJECT}${id}` } }));
      if (!result?.ok) return { error: `a ${SPONSOR_WORDS[field]} could not be added (${outcomeDetail(result)})` };
      added += 1;
    }
  }
  if (added > 0) {
    const check = await sponsorsToAdd(io, resource, targetId);
    if (check.error) return { error: check.error };
    if (Object.keys(check.add).length > 0) return { error: 'post-state: a sponsor that was added did not read back' };
  }
  return { changes: added ? { sponsorsAdded: added } : {}, ...(completion.length ? { completion } : {}) };
}

export const CONNECTED_ORGANIZATION_RECORD = defineRecord({
  resourceType: 'connectedOrganization', version: 'v1.0', collection: CONNECTED_ORGANIZATIONS,
  operations: ['create', 'update'],
  // Sponsors are listed so the approval gate sees them; they are added on their own route (afterWrite).
  writable: ['displayName', 'description', 'state', 'identitySources', 'internalSponsors', 'externalSponsors'],
  transform: connectedOrganizationBody,
  sameField: (field, desired, live) => (field === 'identitySources' ? sameSources(desired, live) : null),
  refusal: withApprovalGate(),
  // Graph gives an organization a new id on every create: a second restore from
  // the same backup finds the first one's by name and identity sources.
  preflight: createdOnce({
    version: 'v1.0', path: CONNECTED_ORGANIZATIONS, label: 'connected organization',
    matches: (row, payload) => lower(row?.displayName) === lower(payload.displayName),
    same: (row, payload) => sameSources(payload.identitySources, row?.identitySources) && lower(row?.state) === lower(payload.state),
  }),
  planChanges: connectedOrganizationPlan,
  planCompletion: ({ resource }) => connectedOrganizationSteps(resource),
  afterWrite: connectedOrganizationAfterWrite,
  permission: PERMISSION, docs: v1('entitlementmanagement-post-connectedorganizations'),
});

// ------------------------------------------------------- assignment policy

/** Subject kinds that name an object by id, and the field that holds it. */
const SUBJECT_IDS = Object.freeze({
  singleUser: { field: 'userId', word: 'user' },
  groupMembers: { field: 'groupId', word: 'group' },
  connectedOrganizationMembers: { field: 'connectedOrganizationId', word: 'connected organization' },
});
/** Relative subjects: worked out per request (a manager, a sponsor), nothing to match. */
const RELATIVE_SUBJECTS = new Set(['requestorManager', 'internalSponsors', 'externalSponsors', 'targetUserSponsors', 'attributeRuleMembers']);

/** Every subject list a policy holds, as [path, role in plain words]. */
function subjectLists(payload) {
  const lists = [
    ['specificAllowedTargets', 'who may request'],
    ['requestorSettings.onBehalfRequestors', 'who may request on behalf of others'],
    ['reviewSettings.primaryReviewers', 'reviewer'],
    ['reviewSettings.fallbackReviewers', 'fallback reviewer'],
  ];
  list(payload?.requestApprovalSettings?.stages).forEach((_stage, index) => {
    const stage = `requestApprovalSettings.stages[${index}]`;
    const n = index + 1;
    lists.push([`${stage}.primaryApprovers`, `approver (stage ${n})`], [`${stage}.fallbackPrimaryApprovers`, `fallback approver (stage ${n})`],
      [`${stage}.escalationApprovers`, `escalation approver (stage ${n})`], [`${stage}.fallbackEscalationApprovers`, `fallback escalation approver (stage ${n})`]);
  });
  return lists;
}

/** The subject in plain words: its reference's name, else its description, never an id. */
function subjectName(resource, path, subject, kind) {
  const spec = SUBJECT_IDS[kind];
  const named = symbolName(referenceAt(resource, `${path}.${spec.field}`)?.symbol);
  if (named) return `the ${spec.word} ${named}`;
  return subject?.description ? `the ${spec.word} "${subject.description}"` : `a ${spec.word} the backup does not name`;
}

function heldForSubjects(resource, missing) {
  const description = `This policy names ${missing.map(({ name, role }) => `${name} (${role})`).join(', ')}, `
    + `which ${missing.length === 1 ? 'is' : 'are'} not in the target. A policy with fewer approvers, reviewers or requestors would be weaker or different, so it was not restored. `
    + `Restore or create ${missing.length === 1 ? 'it' : 'them'} first and run the restore again, or set up the policy by hand in ${PORTAL}, under Access packages, Policies.`;
  return {
    naturalKey: resource.naturalKey,
    reason: `manual: ${description}`,
    completion: [Object.freeze({ kind: 'manual-setting', requirement: 'policySubjects', fields: Object.freeze([...new Set(missing.map(({ path }) => path.split(/[.[]/)[0]))]), description })],
  };
}

/**
 * Points a backed-up policy at the target: its access package, and every user,
 * group and connected organization it names, each found by natural key.
 * Returns { resource } (the backup kept as `backupPayload`), { failed } or { skipped }.
 */
export function targetAssignmentPolicy(resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { failed: { naturalKey, error: 'the backup holds no policy to write' } };
  if (typeof payload.accessPackage?.id !== 'string' || payload.accessPackage.id.length === 0) {
    return { failed: { naturalKey, error: 'the backup does not say which access package this policy belongs to, so it cannot be written; take a new backup, or set it up by hand in ' + PORTAL } };
  }
  if (!ctx.referenceContext) return noContext(naturalKey, 'its access package and the people it names');
  const pkg = targetFor(resource, 'accessPackage.id', ctx);
  if (pkg.missing) {
    const name = payload.accessPackage.displayName ? ` "${payload.accessPackage.displayName}"` : '';
    return { failed: { naturalKey, error: `dependency: its access package${name} is not in the target and is not restored in this run, so the policy cannot be written; restore the package first. Nothing was written` } };
  }
  let rewritten = setAt(payload, 'accessPackage', { id: pkg.targetId });
  // Only the references this resolves are kept: the rest are not in the body.
  const kept = pkg.ref ? [pkg.ref] : [];
  const missing = [];
  const unknown = [];
  for (const [path, role] of subjectLists(payload)) {
    list(getAt(payload, path)).forEach((subject, index) => {
      const kind = stripGraph(subject?.['@odata.type']);
      const at = `${path}[${index}]`;
      if (RELATIVE_SUBJECTS.has(kind)) return;
      const spec = SUBJECT_IDS[kind];
      if (!spec) {
        unknown.push({ path: at, role, name: `a subject of a kind KEEL does not know (${kind ?? 'unnamed'})` });
        return;
      }
      const found = targetFor(resource, `${at}.${spec.field}`, ctx);
      if (found.missing || typeof found.targetId !== 'string') {
        missing.push({ path: at, role, name: subjectName(resource, at, subject, kind) });
        return;
      }
      rewritten = setAt(rewritten, `${at}.${spec.field}`, found.targetId);
      kept.push(found.ref);
    });
  }
  // Nothing is dropped: one subject that cannot be matched holds the whole policy.
  if (missing.length || unknown.length) return { skipped: heldForSubjects(resource, [...missing, ...unknown]) };
  const moved = JSON.stringify(rewritten) !== JSON.stringify(setAt(payload, 'accessPackage', { id: payload.accessPackage.id }));
  if (moved && !remappingFor(resource.resourceType, verb).qualified) {
    return { failed: { naturalKey, error: `unqualified-remapping: accessPackageAssignmentPolicy ${verb} would point at different ids, and reference remapping is not proven for this operation` } };
  }
  return { resource: { ...resource, payload: rewritten, backupPayload: resource.backupPayload ?? payload, references: kept } };
}

// Requestor scopes Graph knows, from narrowest to widest. One KEEL cannot rank
// counts as a loosening (lesson 2026-10-22: an unknown value is listed, never guessed).
const SCOPE_ORDER = ['notSpecified', 'specificDirectoryServicePrincipals', 'specificDirectoryUsers', 'specificConnectedOrganizationUsers',
  'allConfiguredConnectedOrganizationUsers', 'allMemberUsers', 'allDirectoryServicePrincipals', 'allDirectoryUsers', 'allExternalUsers'];
const subjectKeys = (subjects) => list(subjects).map((subject) => JSON.stringify([lower(stripGraph(subject?.['@odata.type'])), lower(subject?.userId ?? subject?.groupId ?? subject?.connectedOrganizationId ?? subject?.managerLevel ?? subject?.membershipRule)]));

// An ISO 8601 duration in days (P1Y2M3DT4H), or null when it cannot be read.
function durationDays(value) {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value ?? ''));
  if (!match || value === 'P' || value === 'PT') return null;
  const [y, mo, w, d, h, mi, s] = match.slice(1).map((part) => Number(part ?? 0));
  return y * 365 + mo * 30 + w * 7 + d + h / 24 + mi / 1440 + s / 86400;
}
/**
 * Whether access granted through the policy lasts longer: no expiry where there
 * is one, or a longer duration. A change KEEL cannot compare (another kind, an
 * end date) counts as longer (lesson 2026-10-22: unknown is listed, never guessed).
 */
function expiresLater(before, after) {
  if (sameValue(before, after)) return false;
  const kind = (value) => lower(value?.type);
  if (kind(after) === 'noexpiration') return kind(before) !== 'noexpiration';
  if (kind(before) === 'noexpiration') return false;
  if (kind(before) === 'afterduration' && kind(after) === 'afterduration') {
    const was = durationDays(before.duration);
    const now = durationDays(after.duration);
    return was === null || now === null || now > was;
  }
  return true;
}

/**
 * What a write of `after` over `before` loosens, in plain words (empty when
 * nothing): who may request, an approval step, reviews. A create loosens from
 * nothing: it lets someone request a package through this policy.
 */
export function policyLoosenings(before, after) {
  if (!before) return ['it lets people request the access package through a policy that is not there now'];
  const out = [];
  const scopeRank = (value) => SCOPE_ORDER.indexOf(value);
  if (after?.allowedTargetScope !== before?.allowedTargetScope) {
    const was = scopeRank(before?.allowedTargetScope);
    const now = scopeRank(after?.allowedTargetScope);
    if (was < 0 || now < 0 || now > was) out.push(`it changes who may request from ${before?.allowedTargetScope ?? 'nobody'} to ${after?.allowedTargetScope ?? 'nobody'}`);
  }
  const added = (field) => {
    const have = new Set(subjectKeys(getAt(before, field)));
    return subjectKeys(getAt(after, field)).some((key) => !have.has(key));
  };
  if (added('specificAllowedTargets')) out.push('it adds people who may request');
  if (added('requestorSettings.onBehalfRequestors')) out.push('it adds people who may request on behalf of others');
  const turnsOn = (field) => getAt(after, field) === true && getAt(before, field) !== true;
  const turnsOff = (field) => getAt(after, field) !== true && getAt(before, field) === true;
  for (const field of ['requestorSettings.enableTargetsToSelfAddAccess', 'requestorSettings.enableOnBehalfRequestorsToAddAccess', 'automaticRequestSettings.requestAccessForAllowedTargets']) {
    if (turnsOn(field)) out.push(`it turns on ${field.split('.').pop()}`);
  }
  for (const field of ['requestApprovalSettings.isApprovalRequiredForAdd', 'requestApprovalSettings.isApprovalRequiredForUpdate']) {
    if (turnsOff(field)) out.push(`it removes the approval step (${field.split('.').pop()})`);
  }
  const stages = (value) => list(value?.requestApprovalSettings?.stages).length;
  if (stages(after) < stages(before)) out.push(`it has ${stages(after)} approval stage(s) where there are ${stages(before)} now`);
  for (let index = 0; index < stages(before); index += 1) {
    for (const kind of ['primaryApprovers', 'fallbackPrimaryApprovers', 'escalationApprovers', 'fallbackEscalationApprovers']) {
      const field = `requestApprovalSettings.stages[${index}].${kind}`;
      const kept = new Set(subjectKeys(getAt(after, field)));
      if (subjectKeys(getAt(before, field)).some((key) => !kept.has(key))) out.push(`it takes approvers off stage ${index + 1}`);
    }
  }
  if (turnsOff('reviewSettings.isEnabled')) out.push('it turns access reviews off');
  if (expiresLater(before?.expiration, after?.expiration)) out.push('it lets access last longer before it expires');
  return [...new Set(out)];
}

/**
 * The approval gate, with the loosening named: a policy is written only once
 * the restore's dry run is approved (or approvals are off for the service).
 */
function policyRefusal(resource, verb, ctx) {
  const held = withApprovalGate()(resource, verb, ctx);
  if (!held || held.outcome !== 'skipped') return held;
  // Judged on the policy as it would be written (the target's ids), against live.
  const loosened = policyLoosenings(verb === 'create' ? null : (resource.live?.payload ?? null), resource.payload);
  if (loosened.length === 0) return held;
  const words = `This weakens who can get access: ${loosened.join('; ')}. `;
  return Object.freeze({
    ...held,
    reason: held.reason.replace(/^manual: /, `manual: ${words}`),
    completion: Object.freeze(held.completion.map((step) => Object.freeze({ ...step, weakensProtection: true, description: `${words}${step.description}` }))),
  });
}

const holdsCustomExtensions = (policy) => list(policy?.customExtensionStageSettings).length > 0;
function customExtensionStep(policy) {
  if (!holdsCustomExtensions(policy)) return null;
  const names = [...new Set(list(policy.customExtensionStageSettings).map((stage) => stage?.customExtension?.displayName).filter(Boolean))];
  const description = `A restore never writes custom extensions (the Logic Apps a policy calls) or their sign-in, so ${names.length ? names.map((name) => `"${name}"`).join(', ') : 'the custom extensions in the backup'} `
    + `${names.length === 1 ? 'was' : 'were'} not added to the policy. Check the Logic App still exists, then add it to the policy by hand in ${PORTAL}, under Access packages, Policies, Custom extensions.`;
  return Object.freeze({ kind: 'manual-setting', requirement: 'customExtensions', fields: Object.freeze(['customExtensionStageSettings']), description });
}

/**
 * Before an update: Graph replaces the whole policy, so one that has custom
 * extensions live would lose them. Read with them expanded; one that has them
 * (or cannot be read) is left for a person.
 */
async function policyUpdateGuard(io, { targetId }) {
  const read = await io.retryOperation(() => io.writer.read('v1.0', `${ASSIGNMENT_POLICIES}/${encodeURIComponent(targetId)}?$expand=customExtensionStageSettings`));
  const description = read?.ok === true
    ? `The live policy calls custom extensions (Logic Apps). Graph replaces a policy whole, and a restore never writes custom extensions, so writing it would take them off. Nothing was written: update the policy by hand in ${PORTAL}, under Access packages, Policies.`
    : `The live policy could not be read to check for custom extensions (${outcomeDetail(read)}). Graph replaces a policy whole, so nothing was written; update it by hand in ${PORTAL}, under Access packages, Policies.`;
  if (read?.ok === true && !holdsCustomExtensions(read.body)) return null;
  return { reason: `manual: ${description}`, completion: [Object.freeze({ kind: 'manual-setting', requirement: 'customExtensions', fields: Object.freeze(['customExtensionStageSettings']), description })] };
}

const samePackage = (desired, live) => lower(desired?.id) === lower(live?.id);
const POLICY_ACCESS = ['allowedTargetScope', 'specificAllowedTargets', 'requestorSettings', 'requestApprovalSettings', 'reviewSettings', 'automaticRequestSettings', 'expiration'];

export const ASSIGNMENT_POLICY_RECORD = defineRecord({
  resourceType: 'accessPackageAssignmentPolicy', version: 'v1.0', collection: ASSIGNMENT_POLICIES,
  operations: ['create', 'update'], updateMethod: 'PUT',
  writable: ['displayName', 'description', 'accessPackage', ...POLICY_ACCESS, 'questions', 'notificationSettings'],
  // Custom extensions call Logic Apps with their own sign-in: never written.
  excluded: ['customExtensionStageSettings', 'catalog', 'assignments'],
  readQuery: '$expand=accessPackage',
  transform: (body, { verb }) => {
    const out = { ...body };
    // Graph takes the access package as a reference: its id, nothing else.
    if (out.accessPackage && typeof out.accessPackage === 'object') out.accessPackage = { id: out.accessPackage.id };
    // A new policy's questions get ids from Graph; an update keeps the live ones.
    if (verb === 'create' && Array.isArray(out.questions)) out.questions = out.questions.map(({ id: _id, ...question }) => question);
    return out;
  },
  sameField: (field, desired, live) => (field === 'accessPackage' ? samePackage(desired, live) : null),
  refusal: policyRefusal,
  updateGuard: policyUpdateGuard,
  // Graph gives a policy a new id on every create: a second restore finds the
  // first one's by name on the same package.
  preflight: createdOnce({
    version: 'v1.0', path: `${ASSIGNMENT_POLICIES}?$expand=accessPackage`, label: 'access package policy',
    matches: (row, payload) => lower(row?.displayName) === lower(payload.displayName) && samePackage(payload.accessPackage, row?.accessPackage),
    same: (row, payload) => POLICY_ACCESS.every((field) => sameValue(payload[field], row?.[field])),
  }),
  planCompletion: ({ resource }) => [customExtensionStep(resource.backupPayload ?? resource.payload)].filter(Boolean),
  afterWrite: async (_io, { resource }) => {
    const step = customExtensionStep(resource.backupPayload ?? resource.payload);
    return step ? { completion: [step] } : null;
  },
  permission: PERMISSION, docs: v1('entitlementmanagement-post-assignmentpolicies'),
});

/** The writes of this module: connected organizations and assignment policies. */
export function entitlementPolicyDispatch(resource, verb, ctx = {}) {
  const route = {
    connectedOrganization: [CONNECTED_ORGANIZATION_RECORD, targetConnectedOrganization],
    accessPackageAssignmentPolicy: [ASSIGNMENT_POLICY_RECORD, targetAssignmentPolicy],
  }[resource.resourceType];
  if (!route) return null;
  const [record, target] = route;
  if (!record.operations.includes(verb)) return { record, resource };
  const targeted = target(resource, verb, ctx);
  if (targeted.failed) return { done: { failed: targeted.failed } };
  if (targeted.skipped) return { done: { skipped: targeted.skipped } };
  return { record, resource: targeted.resource };
}
