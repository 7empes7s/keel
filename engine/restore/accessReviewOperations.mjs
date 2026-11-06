/**
 * Issue #1007: access review definitions (accessReviewScheduleDefinition), the
 * series behind recurring access reviews.
 *
 *  - create only: a missing series is created from the backup with its scope,
 *    reviewers, fallback reviewers, stages, who is told, and its settings and
 *    recurrence. Graph's update replaces the whole series and cannot change what
 *    it reviews, so update is not registered (an existing series is changed by
 *    hand), and a series is never deleted.
 *  - every user, group and app a query names ("/groups/{id}/transitiveMembers",
 *    "/users/{id}") is matched in the target by natural key and its id put back
 *    in the query (engine/cir/queryReferences.mjs). One that cannot be matched,
 *    or a query naming anything else by id (a role, an access package), holds
 *    the whole series as a manual step that names it: a review with fewer
 *    reviewers, or of other people, would be a different review. Relative
 *    queries (./manager, ./owners) and all-users queries need no match.
 *  - the recurrence starts on the restore day when the backup's start date has
 *    passed (never in the past), and the step says so; a series whose end date
 *    has passed is not recreated.
 *  - a series is matched by display name and scope: an existing one is never
 *    duplicated (createdOnce), and one with other reviewers or settings is
 *    left for a person.
 *  - past instances, decisions and history are never recreated: every create
 *    lists that as a manual step.
 *  - what Graph derives from a group's members query is left out of a create:
 *    it reads such a series back with the group as instanceEnumerationScope and
 *    "/microsoft.graph.user" on the query, and refuses both in a create ("Tenant
 *    is not authorized for Custom Scoping Conditions Feature", issue #1033).
 *
 * Every write sits behind the restore approval (approvalHeld.mjs; the effects
 * show each principal by name, safety/contentEffects.mjs). Routes follow the
 * Graph v1.0 reference (accessreviewset-post-definitions) and are
 * fixture-tested, not live-qualified.
 */
import { remappingFor } from '../coverage/qualification.mjs';
import { QUERY_GUIDS, QUERY_PRINCIPAL, queryStrings } from '../cir/queryReferences.mjs';
import { VERBATIM_RESOLUTIONS, resolveSymbol } from '../graph/resolver.mjs';
import { createdOnce, withApprovalGate } from './approvalHeld.mjs';
import { defineRecord, trustFieldStep } from './recordWriter.mjs';

const ACCESS_REVIEW_DEFINITIONS = '/identityGovernance/accessReviews/definitions';
const PORTAL = 'the Entra admin center, under Identity Governance, Access reviews';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const TYPE = 'accessReviewScheduleDefinition';

// What a create sends (accessreviewset-post-definitions); the rest is Graph's.
const WRITABLE = Object.freeze(['displayName', 'descriptionForAdmins', 'descriptionForReviewers', 'scope', 'instanceEnumerationScope',
  'reviewers', 'fallbackReviewers', 'stageSettings', 'additionalNotificationRecipients', 'settings']);
// Who is reviewed and who decides: compared before a create to find one made before.
const ACCESS_FIELDS = Object.freeze(['instanceEnumerationScope', 'reviewers', 'fallbackReviewers', 'stageSettings', 'settings']);
const PRINCIPAL_WORDS = Object.freeze({ users: 'user', groups: 'group', serviceprincipals: 'app' });

const lower = (value) => String(value ?? '').toLowerCase();
const DAY = /^\d{4}-\d{2}-\d{2}/;
const isoDay = (date) => date.toISOString().slice(0, 10);

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

/**
 * Whether `live` holds everything `sent` says: Graph reads a series back with
 * defaults it adds (queryRoot, an empty pattern's month and index), and a
 * start date as a day. Lists keep their order; nulls and empty lists are unset.
 */
function holdsSent(live, sent) {
  // Nothing sent: Graph keeps its own default.
  if (sent === null || sent === undefined) return true;
  if (Array.isArray(sent) && sent.length === 0) return live === null || live === undefined || (Array.isArray(live) && live.length === 0);
  if (Array.isArray(sent)) return Array.isArray(live) && live.length === sent.length && sent.every((item, index) => holdsSent(live[index], item));
  if (typeof sent === 'object') {
    return Boolean(live) && typeof live === 'object' && !Array.isArray(live)
      && Object.entries(sent).every(([key, value]) => (key.includes('@odata.') && key !== '@odata.type') || holdsSent(live[key], value));
  }
  if (typeof sent === 'string' && typeof live === 'string') {
    if (DAY.test(sent) && DAY.test(live) && /^\d{4}-\d{2}-\d{2}(T|$)/.test(sent)) return sent.slice(0, 10) === live.slice(0, 10);
    return lower(sent) === lower(live);
  }
  return sent === live;
}

// A group's members query as Graph reads it back: the users-only cast is its own.
const DERIVED_USERS = /^(\/groups\/[^/]+\/transitiveMembers)\/microsoft\.graph\.user$/i;
const SCOPE_GROUP = /^\/groups\/([^/?]+)\//i;
const INSTANCE_GROUP = /^\/(?:v1\.0\/)?groups\/([^/?]+)$/i;

/** A scope without the users-only cast Graph adds to a group's members query. */
function withoutDerivedUsers(scope) {
  const derived = typeof scope?.query === 'string' && DERIVED_USERS.exec(scope.query);
  return derived ? { ...scope, query: derived[1] } : scope;
}

/**
 * A series without what Graph derives from a group's members query (#1033): the
 * users-only cast, and an instanceEnumerationScope naming the same group.
 * Graph puts both back, and refuses them in a create.
 */
function withoutDerivedScope(payload) {
  const scope = withoutDerivedUsers(payload.scope);
  const group = SCOPE_GROUP.exec(String(scope?.query ?? ''))?.[1];
  const instances = INSTANCE_GROUP.exec(String(payload.instanceEnumerationScope?.query ?? ''))?.[1];
  const derivedInstances = Boolean(group) && lower(group) === lower(instances);
  if (scope === payload.scope && !derivedInstances) return payload;
  const { instanceEnumerationScope: _derived, ...rest } = payload;
  return { ...(derivedInstances ? rest : payload), scope };
}

/** Who a query decides, in plain words, from where it sits. */
function roleOf(path) {
  const top = String(path).split(/[.[]/)[0];
  if (top === 'scope') return /resourceScopes/.test(path) ? 'what is reviewed' : 'who is reviewed';
  if (top === 'instanceEnumerationScope') return 'which groups are reviewed';
  if (top === 'reviewers') return 'reviewer';
  if (top === 'fallbackReviewers') return 'fallback reviewer';
  if (top === 'stageSettings') return `reviewer (stage ${Number(/^stageSettings\[(\d+)\]/.exec(path)?.[1] ?? 0) + 1})`;
  if (top === 'additionalNotificationRecipients') return 'who is told about the review';
  return 'part of the review';
}

const symbolName = (symbol) => (typeof symbol === 'string' && symbol.includes(':') ? symbol.slice(symbol.indexOf(':') + 1) : null);

function heldStep(naturalKey, description, requirement, fields) {
  return {
    naturalKey,
    reason: `manual: ${description}`,
    completion: [Object.freeze({ kind: 'manual-setting', requirement, fields: Object.freeze(fields), description })],
  };
}

/** The steps every recreated series leaves for a person: its history, and a moved start. */
function reviewSteps(payload, movedFrom, today) {
  const steps = [Object.freeze({
    kind: 'manual-setting', requirement: 'reviewHistory', fields: Object.freeze(['instances']),
    description: 'Past reviews of this series, with their decisions and history, are never recreated: the recreated series starts with no reviews, '
      + 'and nobody\'s earlier decision is applied again. Keep the backup as the record of who was reviewed and what was decided.',
  })];
  if (movedFrom) {
    steps.push(Object.freeze({
      kind: 'manual-setting', requirement: 'startDate', fields: Object.freeze(['settings']),
      description: `The backup's series started on ${movedFrom}, which has passed, so the recreated series starts on the restore day, ${today}. `
        + `Its first review opens then, not on the original schedule: change the start date by hand in ${PORTAL} if it should be later.`,
    }));
  }
  // A nested sign-in setting (a recommendation's sign-in scope) is never sent.
  const trust = trustFieldStep(TYPE, payload, null, 'create');
  if (trust) steps.push(trust);
  return steps;
}

/**
 * Points a backed-up series at the target: every user, group and app its
 * queries name, found by natural key, and a start date that has not passed.
 * Returns { resource } (the backup kept as `backupPayload`, its references as
 * `queryReferences`), { failed } or { skipped }.
 */
function targetAccessReview(resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return { failed: { naturalKey, error: 'the backup holds no access review to write' } };
  if (!payload.scope || typeof payload.scope !== 'object') {
    return { failed: { naturalKey, error: `the backup does not say what this access review covers (its scope), so it cannot be recreated; set it up by hand in ${PORTAL}` } };
  }
  const references = resource.references ?? [];
  const sendable = withoutDerivedScope(payload);
  let rewritten = sendable;
  const missing = [];
  for (const { path, query } of queryStrings(Object.fromEntries(WRITABLE.map((field) => [field, sendable[field]])))) {
    const guids = query.match(QUERY_GUIDS) ?? [];
    if (guids.length === 0) continue;
    const match = QUERY_PRINCIPAL.exec(query);
    if (!match || guids.length > 1) {
      missing.push({ path, role: roleOf(path), name: `"${query}", which names something KEEL cannot match in another tenant by id` });
      continue;
    }
    const ref = references.find((candidate) => candidate?.field === path);
    const word = PRINCIPAL_WORDS[lower(match[1])];
    const named = symbolName(ref?.symbol);
    const result = ctx.referenceContext && typeof ref?.symbol === 'string' ? resolveSymbol(ref.symbol, ctx.referenceContext) : { resolved: false };
    if (!result.resolved || (!VERBATIM_RESOLUTIONS.has(result.via) && typeof result.targetId !== 'string')) {
      missing.push({ path, role: roleOf(path), name: named ? `the ${word} ${named}` : `a ${word} the backup does not name` });
      continue;
    }
    if (!VERBATIM_RESOLUTIONS.has(result.via)) rewritten = setAt(rewritten, path, query.replace(match[2], result.targetId));
  }
  // Nothing is dropped: one principal that cannot be matched holds the whole series.
  if (missing.length > 0) {
    const description = `This access review names ${missing.map(({ name, role }) => `${name} (${role})`).join(', ')}, `
      + `which ${missing.length === 1 ? 'is' : 'are'} not in the target. A review of other people, or with fewer reviewers, would be a different review, so it was not recreated. `
      + `Restore or create ${missing.length === 1 ? 'it' : 'them'} first and run the restore again, or set up the review by hand in ${PORTAL}.`;
    return { skipped: heldStep(naturalKey, description, 'reviewPrincipals', [...new Set(missing.map(({ path }) => path.split(/[.[]/)[0]))]) };
  }
  if (rewritten !== sendable && !remappingFor(TYPE, verb).qualified) {
    return { failed: { naturalKey, error: `unqualified-remapping: ${TYPE} ${verb} would point at different ids, and reference remapping is not proven for this operation` } };
  }

  // The recurrence never starts in the past: the restore day, said in a step.
  const now = typeof ctx.now === 'function' ? ctx.now() : (ctx.now instanceof Date ? ctx.now : new Date());
  const today = isoDay(now);
  const range = payload.settings?.recurrence?.range;
  let movedFrom = null;
  if (range && typeof range.startDate === 'string' && DAY.test(range.startDate) && range.startDate.slice(0, 10) < today) {
    if (lower(range.type) === 'enddate' && typeof range.endDate === 'string' && DAY.test(range.endDate) && range.endDate.slice(0, 10) < today) {
      const description = `The backup's series ended on ${range.endDate.slice(0, 10)}, so there is nothing left to recreate. `
        + `If reviews should run again, set up a new series by hand in ${PORTAL}.`;
      return { skipped: heldStep(naturalKey, description, 'startDate', ['settings']) };
    }
    movedFrom = range.startDate.slice(0, 10);
    rewritten = setAt(rewritten, 'settings.recurrence.range.startDate', today);
  }
  return {
    resource: {
      ...resource,
      payload: rewritten,
      backupPayload: resource.backupPayload ?? payload,
      // The queries now hold the target's ids, so the record checks none of the
      // backup's references; the approval names principals by them (contentEffects).
      references: [],
      queryReferences: references,
      reviewSteps: reviewSteps(payload, movedFrom, today),
    },
  };
}

/** Settings without the start date, which a restore moves to the restore day. */
function withoutStart(settings) {
  const range = settings?.recurrence?.range;
  if (!range || typeof range !== 'object') return settings;
  const { startDate: _start, ...rest } = range;
  return { ...settings, recurrence: { ...settings.recurrence, range: rest } };
}

export const ACCESS_REVIEW_RECORD = defineRecord({
  resourceType: TYPE, version: 'v1.0', collection: ACCESS_REVIEW_DEFINITIONS,
  operations: ['create'], writable: WRITABLE,
  sameField: (field, desired, live) => (field === 'scope'
    ? holdsSent(withoutDerivedUsers(live), withoutDerivedUsers(desired))
    : holdsSent(live, desired)),
  refusal: withApprovalGate(),
  // Graph gives a series a new id on every create: a second restore from the same
  // backup finds the first one's by name and scope, and never makes a second.
  preflight: createdOnce({
    version: 'v1.0', path: ACCESS_REVIEW_DEFINITIONS, label: 'access review',
    matches: (row, payload) => lower(row?.displayName) === lower(payload.displayName)
      && holdsSent(withoutDerivedUsers(row?.scope), withoutDerivedUsers(payload.scope)),
    same: (row, payload) => ACCESS_FIELDS.every((field) => (field === 'settings'
      ? holdsSent(withoutStart(row?.settings), withoutStart(payload.settings))
      : holdsSent(row?.[field], payload[field]))),
  }),
  planCompletion: ({ resource }) => resource.reviewSteps ?? [],
  afterWrite: async (_io, { resource }) => ({ completion: resource.reviewSteps ?? [] }),
  permission: 'AccessReview.ReadWrite.All', docs: `${DOCS}/accessreviewset-post-definitions?view=graph-rest-1.0`,
});

/** The write of this module: an access review series, pointed at the target first. */
export function accessReviewDispatch(resource, verb, ctx = {}) {
  if (resource.resourceType !== TYPE) return null;
  if (!ACCESS_REVIEW_RECORD.operations.includes(verb)) return { record: ACCESS_REVIEW_RECORD, resource };
  const targeted = targetAccessReview(resource, verb, ctx);
  if (targeted.failed) return { done: { failed: targeted.failed } };
  if (targeted.skipped) return { done: { skipped: targeted.skipped } };
  return { record: ACCESS_REVIEW_RECORD, resource: targeted.resource };
}
