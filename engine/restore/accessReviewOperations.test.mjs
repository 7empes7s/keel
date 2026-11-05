/**
 * Issue #1007: access review series (accessReviewOperations.mjs), against an
 * in-memory access reviews Graph that answers in the shape Graph v1.0 documents
 * (accessreviewset-post-definitions: queryRoot added to reviewers, an empty
 * pattern's month and index, a start date read back as a day). The applyWave
 * test drives the production path: this file is the remapping proof
 * qualification.mjs records for the create.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { remappingFor } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const DEFINITIONS = '/identityGovernance/accessReviews/definitions';
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' };
// The restore day, set explicitly; dates the rule compares to it are set from it.
const RESTORE_DAY = new Date('2026-11-05T09:30:00Z');
const NOW = { now: () => RESTORE_DAY };
const daysFrom = (date, days) => new Date(date.getTime() + days * 86400000).toISOString().slice(0, 10);

const SOURCE_GROUP = 'aaaaaaaa-0000-4000-8000-000000000101';
const TARGET_GROUP = 'bbbbbbbb-0000-4000-8000-000000000101';
const SOURCE_REVIEWER = 'aaaaaaaa-0000-4000-8000-000000000102';
const TARGET_REVIEWER = 'bbbbbbbb-0000-4000-8000-000000000102';
const SOURCE_FALLBACK = 'aaaaaaaa-0000-4000-8000-000000000103';
const SOURCE_REVIEW = 'aaaaaaaa-0000-4000-8000-000000000104';
const GROUP_KEY = 'group:KEEL-RT-1007-group';
const REVIEWER_KEY = 'user:carla@contoso.com';
const FALLBACK_KEY = 'user:dan@contoso.com';
const KEY = 'accessReviewScheduleDefinition:KEEL-RT-1007-review';

/** A series as Graph lists it (accessReviewScheduleDefinition, v1.0). */
const backupPayload = (extra = {}) => ({
  id: SOURCE_REVIEW, displayName: 'KEEL-RT-1007-review', status: 'InProgress',
  createdDateTime: '2026-01-02T10:00:00Z', lastModifiedDateTime: '2026-01-02T10:00:00Z',
  createdBy: { id: 'aaaaaaaa-0000-4000-8000-000000000199', displayName: 'Admin', userPrincipalName: 'admin@contoso.com' },
  descriptionForAdmins: 'Quarterly check of the KEEL-RT group', descriptionForReviewers: 'Keep only people who still need access',
  scope: { '@odata.type': '#microsoft.graph.accessReviewQueryScope', query: `/groups/${SOURCE_GROUP}/transitiveMembers`, queryType: 'MicrosoftGraph' },
  instanceEnumerationScope: null,
  reviewers: [{ query: `/users/${SOURCE_REVIEWER}`, queryType: 'MicrosoftGraph', queryRoot: 'decisions' }],
  fallbackReviewers: [],
  additionalNotificationRecipients: [],
  settings: {
    mailNotificationsEnabled: true, reminderNotificationsEnabled: true, justificationRequiredOnApproval: true,
    defaultDecisionEnabled: false, defaultDecision: 'None', instanceDurationInDays: 3, autoApplyDecisionsEnabled: false,
    recommendationsEnabled: true, applyActions: [],
    recurrence: {
      pattern: { type: 'weekly', interval: 1, month: 0, dayOfMonth: 0, daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first' },
      range: { type: 'noEnd', numberOfOccurrences: 0, recurrenceTimeZone: null, startDate: '2026-01-05', endDate: null },
    },
  },
  ...extra,
});
const REFS = [
  { field: 'scope.query', symbol: GROUP_KEY, required: true },
  { field: 'reviewers[0].query', symbol: REVIEWER_KEY, required: true },
];
const reviewResource = (extra = {}) => ({
  naturalKey: KEY, resourceType: 'accessReviewScheduleDefinition', blastRadius: 'access-affecting',
  payload: backupPayload(), references: REFS, ...extra,
});
const TARGETS = [[GROUP_KEY, TARGET_GROUP], [REVIEWER_KEY, TARGET_REVIEWER]];

/** Access reviews in memory: the definitions collection, answering as Graph does. */
function reviewsGraph({ definitions = [] } = {}) {
  const state = new Map(definitions.map((definition) => [definition.id, structuredClone(definition)]));
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  // What Graph adds to a series it stores: reviewers' queryRoot, a pattern's unused parts, a day.
  const stored = (body, id) => {
    const out = structuredClone({ ...body, id, status: 'NotStarted', createdDateTime: '2026-11-05T09:30:01Z' });
    out.reviewers = (out.reviewers ?? []).map((reviewer) => ({ queryRoot: 'decisions', ...reviewer }));
    const recurrence = out.settings?.recurrence;
    if (recurrence?.pattern) recurrence.pattern = { month: 0, dayOfMonth: 0, daysOfWeek: [], firstDayOfWeek: 'sunday', index: 'first', ...recurrence.pattern };
    if (recurrence?.range?.startDate) recurrence.range.startDate = recurrence.range.startDate.slice(0, 10);
    return out;
  };
  return {
    state,
    calls,
    async read(_version, path) {
      calls.push({ method: 'GET', path });
      const [base] = path.split('?');
      if (base === DEFINITIONS) return ok(200, { value: [...state.values()] });
      const one = /^\/identityGovernance\/accessReviews\/definitions\/([^/]+)$/.exec(base);
      if (one && state.has(decodeURIComponent(one[1]))) return ok(200, state.get(decodeURIComponent(one[1])));
      return { ok: false, status: 404, body: { error: { code: 'NotFound' } } };
    },
    async write(_version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'POST' && path === DEFINITIONS) {
        next += 1;
        const created = stored(body, `cccccccc-0000-4000-8000-00000000000${next}`);
        state.set(created.id, created);
        return ok(201, created);
      }
      return { ok: false, status: 405, body: null };
    },
  };
}

const context = (targets = TARGETS) => ({ targetIndex: new Map(targets), mappingTable: new Map(), runProvenance: new Map() });
const withRefs = (extra = {}) => ({ ...FAST, ...NOW, referenceContext: context(), ...extra });
const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const approved = (resource) => classifyContentEffects([{ ...resource, verb: 'create' }]).effects;
const noTrustField = (graph) => {
  for (const { body } of writes(graph)) {
    for (const key of JSON.stringify(body ?? {}).match(/"([^"]+)":/g) ?? []) {
      assert.equal(TRUST_FIELD_PATTERN.test(key.slice(1, -2)), false, `no trust or sign-in field in a body: ${key}`);
    }
  }
};
const stepOf = (outcome, requirement) => (outcome.applied ?? outcome.skipped)?.completion?.find((step) => step.requirement === requirement);

test('access review series are approval-held, and the effects name the reviewed group and the reviewer, never an id', () => {
  assert.ok(APPROVAL_HELD_KINDS.includes('accessReviewScheduleDefinition'));
  assert.deepEqual(IDENTITY_RECORDS.accessReviewScheduleDefinition.operations, ['create']);
  const effects = approved(reviewResource());
  assert.ok(effects.every((effect) => effect.effect === 'access-changing'));
  const scope = JSON.stringify(effects.find((effect) => effect.field === 'scope').after);
  assert.match(scope, /\/groups\/\{group:KEEL-RT-1007-group\}\/transitiveMembers/);
  assert.equal(scope.includes(SOURCE_GROUP), false);
  assert.match(JSON.stringify(effects.find((effect) => effect.field === 'reviewers').after), /\/users\/\{user:carla@contoso.com\}/);
  assert.ok(effects.some((effect) => effect.field === 'settings'), 'settings can remove access by themselves');
});

test('a missing series is created with its group and reviewer matched in the target, and its start date moved to the restore day', async () => {
  const graph = reviewsGraph();
  const resource = reviewResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  const [post] = writes(graph);
  assert.equal(post.path, DEFINITIONS);
  assert.equal(post.body.scope.query, `/groups/${TARGET_GROUP}/transitiveMembers`);
  assert.deepEqual(post.body.reviewers, [{ query: `/users/${TARGET_REVIEWER}`, queryType: 'MicrosoftGraph', queryRoot: 'decisions' }]);
  assert.equal(JSON.stringify(post.body).includes('aaaaaaaa-'), false, 'never an id from the backup\'s tenant');
  assert.equal(post.body.settings.recurrence.range.startDate, '2026-11-05');
  for (const field of ['id', 'status', 'createdBy', 'createdDateTime', 'lastModifiedDateTime']) assert.equal(field in post.body, false, field);
  assert.match(stepOf(result, 'startDate').description, /started on 2026-01-05, which has passed, so the recreated series starts on the restore day, 2026-11-05/);
  noTrustField(graph);
});

test('the start date is never in the past, and a future one is kept as the backup holds it', async () => {
  const later = daysFrom(RESTORE_DAY, 30);
  const base = backupPayload();
  const resource = reviewResource({ payload: { ...base, settings: { ...base.settings, recurrence: { ...base.settings.recurrence, range: { type: 'noEnd', startDate: later } } } } });
  const graph = reviewsGraph();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(writes(graph)[0].body.settings.recurrence.range.startDate, later);
  assert.equal(stepOf(result, 'startDate'), undefined);
  for (const write of writes(graph)) assert.ok(write.body.settings.recurrence.range.startDate >= '2026-11-05');
});

test('past reviews, decisions and history are never recreated: every create says so, and nothing is written for them', async () => {
  const graph = reviewsGraph();
  const resource = reviewResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.match(stepOf(result, 'reviewHistory').description, /Past reviews of this series, with their decisions and history, are never recreated/);
  assert.deepEqual(writes(graph).map((call) => `${call.method} ${call.path}`), [`POST ${DEFINITIONS}`], 'only the series: no instance or decision route');
});

test('the dry run lists the history and start date steps and writes nothing', async () => {
  const graph = reviewsGraph();
  const result = await applyIdentityObjectWrite(graph, reviewResource(), 'create', withRefs({ mode: 'dry-run' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.ok(stepOf(result, 'reviewHistory'));
  assert.ok(stepOf(result, 'startDate'));
  assert.equal(writes(graph).length, 0);
});

test('without the approval the series is held, and nothing is read or written', async () => {
  const graph = reviewsGraph();
  const result = await applyIdentityObjectWrite(graph, reviewResource(), 'create', withRefs({ mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.equal(graph.calls.length, 0);
});

test('a reviewer missing from the target holds the whole series with a plain reason, and nothing is read or written', async () => {
  const graph = reviewsGraph();
  const base = backupPayload();
  const resource = reviewResource({
    payload: { ...base, fallbackReviewers: [{ query: `/users/${SOURCE_FALLBACK}`, queryType: 'MicrosoftGraph' }] },
    references: [...REFS, { field: 'fallbackReviewers[0].query', symbol: FALLBACK_KEY, required: true }],
  });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: This access review names the user dan@contoso.com \(fallback reviewer\), which is not in the target/);
  assert.deepEqual(stepOf(result, 'reviewPrincipals').fields, ['fallbackReviewers']);
  assert.equal(graph.calls.length, 0);
});

test('a query naming something other than a user, group or app by id holds the series', async () => {
  const graph = reviewsGraph();
  const base = backupPayload();
  const roleQuery = '/roleManagement/directory/roleDefinitions/aaaaaaaa-0000-4000-8000-000000000150';
  const resource = reviewResource({
    payload: { ...base, scope: { '@odata.type': '#microsoft.graph.principalResourceMembershipsScope', principalScopes: [{ query: '/users', queryType: 'MicrosoftGraph' }], resourceScopes: [{ query: roleQuery, queryType: 'MicrosoftGraph' }] } },
    references: [REFS[1]],
  });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /which names something KEEL cannot match in another tenant by id \(what is reviewed\)/);
  assert.equal(graph.calls.length, 0);
});

test('an existing series with the same name and scope is never duplicated', async () => {
  const first = reviewsGraph();
  const resource = reviewResource();
  const ctx = withRefs({ approvedContentEffects: approved(resource) });
  assert.equal((await applyIdentityObjectWrite(first, resource, 'create', ctx)).failed, undefined);
  // The same restore run again, against the tenant the first run left.
  const graph = reviewsGraph({ definitions: [...first.state.values()] });
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /the access review is already there with the backup's access/);
  assert.equal(writes(graph).length, 0);
  assert.equal(graph.state.size, 1);
});

test('an existing series with the same name and scope but other reviewers is left for a person, never a second series', async () => {
  const first = reviewsGraph();
  const resource = reviewResource();
  const ctx = withRefs({ approvedContentEffects: approved(resource) });
  await applyIdentityObjectWrite(first, resource, 'create', ctx);
  const [live] = first.state.values();
  const graph = reviewsGraph({ definitions: [{ ...live, reviewers: [{ query: './manager', queryType: 'MicrosoftGraph', queryRoot: 'decisions' }] }] });
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.failed?.error ?? '', /already exists with other access; KEEL does not make a second one/);
  assert.equal(writes(graph).length, 0);
});

test('a series whose end date has passed is not recreated', async () => {
  const graph = reviewsGraph();
  const base = backupPayload();
  const ended = daysFrom(RESTORE_DAY, -10);
  const resource = reviewResource({ payload: { ...base, settings: { ...base.settings, recurrence: { ...base.settings.recurrence, range: { type: 'endDate', startDate: '2026-01-05', endDate: ended } } } } });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', new RegExp(`series ended on ${ended}`));
  assert.equal(graph.calls.length, 0);
});

test('a nested sign-in setting is never sent: it is a step for a person', async () => {
  const graph = reviewsGraph();
  const base = backupPayload();
  const resource = reviewResource({
    payload: { ...base, settings: { ...base.settings, recommendationInsightSettings: [{ '@odata.type': '#microsoft.graph.userLastSignInRecommendationInsightSetting', recommendationLookBackDuration: 'P30D', signInScope: 'application' }] } },
  });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs({ approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph)[0].body.settings.recommendationInsightSettings, [{ '@odata.type': '#microsoft.graph.userLastSignInRecommendationInsightSetting', recommendationLookBackDuration: 'P30D' }]);
  assert.match(stepOf(result, 'trustFields').description, /never writes trust, certificate or sign-in settings/);
  noTrustField(graph);
});

test('the backup names the users and groups inside access review queries as references', () => {
  const [, , review] = canonicalizeAll([
    ['group', [{ id: SOURCE_GROUP, displayName: 'KEEL-RT-1007-group' }]],
    ['user', [{ id: SOURCE_REVIEWER, userPrincipalName: 'carla@contoso.com', displayName: 'Carla' }]],
    ['accessReviewScheduleDefinition', [backupPayload()]],
  ]);
  assert.equal(review.resourceType, 'accessReviewScheduleDefinition');
  const refs = Object.fromEntries(review.references.map((ref) => [ref.field, ref.symbol]));
  assert.equal(refs['scope.query'], GROUP_KEY);
  assert.equal(refs['reviewers[0].query'], REVIEWER_KEY);
});

// ------------------------------------------------- production applyWave path

const governor = { async acquire() {}, observeRetryAfter() {} };

test('remapping proof: an access review create is qualified by this file', () => {
  assert.equal(remappingFor('accessReviewScheduleDefinition', 'create').qualified, true);
  assert.equal(remappingFor('accessReviewScheduleDefinition', 'create').proofRef, 'engine/restore/accessReviewOperations.test.mjs');
});

test('applyWave: an approved series lands pointed at the target; an unapproved one writes nothing; update is refused', async () => {
  const resource = { ...reviewResource(), verb: 'create' };
  const graph = reviewsGraph();
  const outcome = await applyWave(graph, governor, [resource], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(TARGETS), now: () => RESTORE_DAY,
    approvedContentEffects: classifyContentEffects([resource]).effects, readAfterWriteOptions: { attempts: 1, delayMs: 0 },
  });
  assert.deepEqual(outcome.failed, [], JSON.stringify(outcome.failed));
  assert.deepEqual(outcome.skipped, [], JSON.stringify(outcome.skipped));
  const [written] = graph.state.values();
  assert.equal(written.scope.query, `/groups/${TARGET_GROUP}/transitiveMembers`);
  noTrustField(graph);

  const held = reviewsGraph();
  const unapproved = await applyWave(held, governor, [resource], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(TARGETS), now: () => RESTORE_DAY, approvedContentEffects: [],
  });
  assert.equal(unapproved.applied.length, 0);
  assert.equal(writes(held).length, 0);

  const live = reviewsGraph({ definitions: [{ ...backupPayload(), id: 'cccccccc-0000-4000-8000-000000000009' }] });
  const update = await applyWave(live, governor, [{ ...reviewResource(), verb: 'update', live: { state: 'present', targetId: 'cccccccc-0000-4000-8000-000000000009', payload: backupPayload() } }], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(TARGETS), now: () => RESTORE_DAY, approvedContentEffects: [],
  });
  assert.equal(update.applied.length, 0);
  assert.match(JSON.stringify(update.failed), /unsupported operation/);
  assert.equal(writes(live).length, 0);
});
