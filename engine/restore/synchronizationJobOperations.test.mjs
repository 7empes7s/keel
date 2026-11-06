/**
 * Issue #1016: app provisioning (synchronizationJobOperations.mjs), from the
 * catalog read through the store to the restore, against an in-memory Graph in
 * the shapes the v1.0 references document (synchronization-synchronization-list-jobs,
 * synchronization-synchronizationschema-get and -update, synchronization-synchronization-post-jobs).
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { get } from '../collect/registry.mjs';
import { buildLiveIndex } from '../reconcile/liveState.mjs';
import { capabilityFor } from '../coverage/capabilities.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { createSnapshot, getResourceVersions, insertResourceVersion } from '../store/db.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { FIXTURE_PAYLOADS } from '../../tools/qualification/operations.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { schemaChanges } from './synchronizationJobOperations.mjs';

const G = 'https://graph.microsoft.com/v1.0';
const SP = '33333333-3333-4333-8333-333333333316';
const APP_ID = '44444444-4444-4444-8444-444444441016';
const JOB_ID = 'scim.33333333333343338333333333333316.00000000-0000-4000-8000-0000000000c1';
const JOBS = `/servicePrincipals/${SP}/synchronization/jobs`;
const KEY = `synchronizationJob:${JOB_ID}`;
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const BACKUP_SCHEMA = FIXTURE_PAYLOADS.synchronizationJob.schema;

/** A job as Graph lists it: its run status and settings come with it. */
const graphJob = (extra = {}) => ({
  id: JOB_ID, templateId: 'scim',
  schedule: { expiration: null, interval: 'PT40M', state: 'Active' },
  status: {
    code: 'Active', countSuccessiveCompleteFailures: 0, escrowsPruned: false, quarantine: null, progress: [],
    lastExecution: { activityIdentifier: 'fixture', countEntitled: 4, state: 'Succeeded', timeBegan: '2026-11-01T10:00:00Z', timeEnded: '2026-11-01T10:01:00Z' },
    steadyStateFirstAchievedTime: '2026-11-01T10:01:00Z', steadyStateLastAchievedTime: '2026-11-05T10:01:00Z',
    synchronizedEntryCountByType: [{ key: 'User to User', value: 4 }], troubleshootingUrl: '',
  },
  synchronizationJobSettings: [{ name: 'QuarantineTooManyDeletesThreshold', value: '500' }],
  ...extra,
});
/** A schema as Graph returns it: annotated, with its id and version. */
const graphSchema = (schema = BACKUP_SCHEMA) => ({
  '@odata.context': `${G}/$metadata#servicePrincipals('${SP}')/synchronization/jobs('${JOB_ID}')/schema/$entity`,
  id: JOB_ID, version: 'Date:2026-11-01T10:00:00Z;Version:1', ...structuredClone(schema),
});
const widened = () => ({ ...BACKUP_SCHEMA, synchronizationRules: BACKUP_SCHEMA.synchronizationRules.map((rule) => ({
  ...rule, objectMappings: rule.objectMappings.map((mapping) => ({ ...mapping, scope: null })),
})) });

// ------------------------------------------------------------------- backup

const respond = (body, status = 200) => ({ ok: status === 200, status, headers: { get: () => null }, json: async () => body });
async function withRoutes(routes, fn) {
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.method, 'GET', 'reads only');
    urls.push(url);
    assert.ok(routes[url], `unexpected request ${url}`);
    return routes[url]();
  };
  try { return { result: await fn(), urls }; } finally { globalThis.fetch = original; }
}
const ROUTES = {
  [`${G}/servicePrincipals?$select=id,applicationTemplateId&$top=999`]: () => respond({ value: [{ id: SP, applicationTemplateId: '8adf8e6e-67b2-4cf2-a259-e3dc5476c621' }] }),
  // Defence in depth: the synchronization object holds `secrets`; were Graph to
  // put credentials on a job, they would be left out like every other field.
  [`${G}${JOBS}`]: () => respond({ value: [graphJob({ secrets: [{ key: 'SecretToken', value: 'fixture-not-a-secret' }] })] }),
  [`${G}${JOBS}/${encodeURIComponent(JOB_ID)}/schema`]: () => respond(graphSchema()),
};
const reader = () => new GraphReader(async () => 'fixture-token');
const keysDeep = (value, out = []) => {
  if (Array.isArray(value)) value.forEach((item) => keysDeep(item, out));
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { out.push(key); keysDeep(inner, out); }
  return out;
};

test('the backup holds each job\'s template, schedule and schema, and never its status, settings or any secret', async () => {
  const { result, urls } = await withRoutes(ROUTES, () => get('synchronizationJob').adapter.collect(reader()));
  assert.deepEqual(urls, [`${G}/servicePrincipals?$select=id,applicationTemplateId&$top=999`, `${G}${JOBS}`, `${G}${JOBS}/${encodeURIComponent(JOB_ID)}/schema`]);
  const [job] = result;
  assert.deepEqual(Object.keys(job).sort(), ['id', 'schedule', 'schema', 'servicePrincipalId', 'templateId']);
  assert.deepEqual(job.schema, BACKUP_SCHEMA, 'the schema without its annotation, id or version');
  assert.deepEqual(keysDeep(job).filter((key) => /secret|credential|password|token|status/i.test(key)), []);
  assert.equal(JSON.stringify(job).includes('fixture-not-a-secret'), false);
});

test('the restore\'s live read makes the same schema read, so the plan compares schema with schema', async () => {
  const { result: index } = await withRoutes(ROUTES, () => buildLiveIndex(reader(), {
    resourceTypes: ['synchronizationJob'], naturalKeyFor: (type, object) => `${type}:${object.id}`,
  }));
  assert.deepEqual(index.get(KEY).payload.schema, BACKUP_SCHEMA);
});

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => { await client.end(); await database.cleanup(); });

test('the stored job keeps its schema and names its app by app id', async () => {
  const sp = { id: SP, appId: APP_ID, displayName: 'KEEL-RT-1016-scim' };
  const job = { id: JOB_ID, templateId: 'scim', schedule: graphJob().schedule, servicePrincipalId: SP, schema: BACKUP_SCHEMA };
  const stored = canonicalizeAll([['servicePrincipal', [sp]], ['synchronizationJob', [job]]]).find((entry) => entry.resourceType === 'synchronizationJob');
  assert.deepEqual(stored.references.map(({ field, symbol }) => ({ field, symbol })), [{ field: 'servicePrincipalId', symbol: `servicePrincipal:${APP_ID}` }]);
  const snapshotId = await createSnapshot(client, { tenantRef: 'sha256:sync-job-test' });
  await insertResourceVersion(client, { snapshotId, resource: { ...stored, fidelity: stored.provenance.fidelity } });
  const [row] = await getResourceVersions(client, { snapshotId });
  assert.deepEqual(row.payload.schema, BACKUP_SCHEMA);
  assert.equal(row.payload.servicePrincipalId, SP);
});

// ------------------------------------------------------------------ restore

/** One app's provisioning jobs in memory, answering as the v1.0 references show. */
function syncGraph({ jobs = [] } = {}) {
  const state = new Map(jobs.map(({ schema, ...job }) => [job.id, { job: structuredClone(job), schema: structuredClone(schema) }]));
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } });
  const route = (path) => /^\/servicePrincipals\/([^/]+)\/synchronization\/jobs(?:\/([^/]+)(\/schema)?)?$/.exec(path);
  return {
    state,
    calls,
    async read(_version, path) {
      calls.push({ method: 'GET', path });
      const match = route(path);
      if (!match || decodeURIComponent(match[1]) !== SP) return notFound();
      if (!match[2]) return ok(200, { value: [...state.values()].map(({ job }) => job) });
      const held = state.get(decodeURIComponent(match[2]));
      if (!held) return notFound();
      return ok(200, match[3] ? graphSchema(held.schema) : held.job);
    },
    async write(_version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      const match = route(path);
      if (!match || decodeURIComponent(match[1]) !== SP) return notFound();
      if (method === 'POST' && !match[2]) {
        next += 1;
        const job = { id: `${body.templateId}.fixture${next}`, templateId: body.templateId, schedule: { expiration: null, interval: 'PT40M', state: 'Disabled' }, status: { code: 'NotConfigured' } };
        state.set(job.id, { job, schema: { directories: [], synchronizationRules: [] } });
        return ok(201, job);
      }
      const held = match[2] && state.get(decodeURIComponent(match[2]));
      if (method === 'PUT' && match[3] && held) {
        held.schema = structuredClone(body);
        return ok(204, null);
      }
      return { ok: false, status: 405, body: null };
    },
  };
}

const backupPayload = (extra = {}) => ({ id: JOB_ID, templateId: 'scim', schedule: { expiration: null, interval: 'PT40M', state: 'Active' }, servicePrincipalId: SP, schema: BACKUP_SCHEMA, ...extra });
const resource = (extra = {}) => ({ naturalKey: KEY, resourceType: 'synchronizationJob', blastRadius: 'access-affecting', payload: backupPayload(), references: [], ...extra });
const liveJob = (schema, schedule = graphJob().schedule) => ({ id: JOB_ID, templateId: 'scim', schedule, schema });
const updateOf = (schema = widened(), schedule) => resource({ targetId: JOB_ID, live: { state: 'present', targetId: JOB_ID, payload: { ...liveJob(schema, schedule), servicePrincipalId: SP } } });
const approved = (res, verb) => classifyContentEffects([{ ...res, verb }]).effects;
const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const NEVER = /\/(start|restart|pause|provisionOnDemand|validateCredentials)$|\/secrets$/i;
const neverRunsOrSendsSecrets = (graph) => {
  for (const { method, path, body } of writes(graph)) {
    assert.equal(NEVER.test(path), false, `a job is never started, paused or given credentials: ${path}`);
    assert.notEqual(method, 'DELETE', `a job is never deleted: ${path}`);
    assert.equal(/secret|credential|password|token/i.test(JSON.stringify(body ?? {})), false, `${path} carries no credential`);
  }
};
const stepOf = (outcome, requirement) => (outcome.applied ?? outcome.skipped)?.completion?.find((entry) => entry.requirement === requirement);

test('a provisioning job is approval-held: its schema is a "changes access" effect, judged on create too', () => {
  assert.ok(APPROVAL_HELD_KINDS.includes('synchronizationJob'));
  assert.deepEqual(IDENTITY_RECORDS.synchronizationJob.operations, ['create', 'update']);
  const [effect] = approved(updateOf(), 'update');
  assert.equal(effect.effect, 'access-changing');
  assert.equal(effect.field, 'schema');
  assert.equal(approved(resource(), 'create').length, 1);
  assert.deepEqual(approved(updateOf(BACKUP_SCHEMA), 'update'), [], 'the same schema changes nothing');
});

test('the dry run reads and writes nothing, names the changed scoping filter and warns of the full re-evaluation', async () => {
  const graph = syncGraph({ jobs: [liveJob(widened())] });
  const result = await applyIdentityObjectWrite(graph, updateOf(), 'update', { ...FAST, mode: 'dry-run' });
  assert.deepEqual(writes(graph), []);
  assert.deepEqual(result.applied.changes.fields, ['schema']);
  assert.deepEqual(result.applied.changes.schemaChanges, ['USER_OUTBOUND_USER: User to User: scoping filter']);
  assert.match(stepOf(result, 'provisioningReevaluation').description, /initial cycle: it checks every user and group in scope again, and can create, update or disable/);
});

test('without the approval the schema is not written; a partial or other approval does not count', async () => {
  for (const approvedContentEffects of [undefined, [], approved(resource(), 'create')]) {
    const graph = syncGraph({ jobs: [liveJob(widened())] });
    const result = await applyIdentityObjectWrite(graph, updateOf(), 'update', { ...FAST, approvedContentEffects });
    assert.deepEqual(writes(graph), []);
    assert.match(result.skipped.reason, /^manual: This changes admin access \(schema\)/);
  }
});

test('with the approval the backed-up schema is put back on the live job, exactly, and nothing starts it', async () => {
  const graph = syncGraph({ jobs: [liveJob(widened())] });
  const res = updateOf();
  const result = await applyIdentityObjectWrite(graph, res, 'update', { ...FAST, approvedContentEffects: approved(res, 'update') });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph).map(({ method, path }) => `${method} ${path}`), [`PUT ${JOBS}/${encodeURIComponent(JOB_ID)}/schema`]);
  assert.deepEqual(writes(graph)[0].body, BACKUP_SCHEMA, 'directories and rules only: no annotation, id or version');
  assert.deepEqual(graph.state.get(JOB_ID).schema, BACKUP_SCHEMA);
  assert.ok(stepOf(result, 'provisioningReevaluation'));
  neverRunsOrSendsSecrets(graph);
});

test('a live job that already holds the backed-up schema gets no write', async () => {
  const graph = syncGraph({ jobs: [liveJob(BACKUP_SCHEMA)] });
  const result = await applyIdentityObjectWrite(graph, updateOf(BACKUP_SCHEMA), 'update', FAST);
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph), []);
  assert.equal(stepOf(result, 'provisioningReevaluation'), undefined);
});

test('a job that was running and is stopped now (or the other way round) is a step: a job is never started or stopped', async () => {
  const graph = syncGraph({ jobs: [liveJob(BACKUP_SCHEMA, { expiration: null, interval: 'PT40M', state: 'Paused' })] });
  const result = await applyIdentityObjectWrite(graph, updateOf(BACKUP_SCHEMA, { expiration: null, interval: 'PT40M', state: 'Paused' }), 'update', FAST);
  assert.deepEqual(writes(graph), []);
  assert.match(stepOf(result, 'provisioningSchedule').description, /was running when the backup was taken and is not running now\. KEEL never starts a job/);
});

test('a missing job is created from its template, its schema put on it, and left stopped; credentials and starting it are steps', async () => {
  const graph = syncGraph();
  const res = resource();
  const result = await applyIdentityObjectWrite(graph, res, 'create', { ...FAST, approvedContentEffects: approved(res, 'create') });
  assert.equal(result.failed, undefined, result.failed?.error);
  const created = result.applied.targetId;
  assert.deepEqual(writes(graph).map(({ method, path }) => `${method} ${path}`), [`POST ${JOBS}`, `PUT ${JOBS}/${encodeURIComponent(created)}/schema`]);
  assert.deepEqual(writes(graph)[0].body, { templateId: 'scim' }, 'the create sends the template only');
  assert.deepEqual(graph.state.get(created).schema, BACKUP_SCHEMA);
  assert.equal(graph.state.get(created).job.schedule.state, 'Disabled', 'the created job is never started');
  assert.match(stepOf(result, 'provisioningCredentials').description, /never returns a provisioning job's admin credentials/);
  assert.match(stepOf(result, 'provisioningStart').description, /created the job stopped and never starts one/);
  neverRunsOrSendsSecrets(graph);
});

test('a create waits for the approval too, and a dry run of it writes nothing', async () => {
  const graph = syncGraph();
  const held = await applyIdentityObjectWrite(graph, resource(), 'create', FAST);
  assert.match(held.skipped.reason, /^manual: This changes admin access \(schema\)/);
  const planned = await applyIdentityObjectWrite(graph, resource(), 'create', { ...FAST, mode: 'dry-run' });
  assert.deepEqual(planned.applied.changes.fields, ['templateId', 'schema']);
  assert.ok(stepOf(planned, 'provisioningStart'));
  assert.deepEqual(writes(graph), []);
});

test('a job of the same template already on the app is never duplicated', async () => {
  const same = syncGraph({ jobs: [{ ...liveJob(BACKUP_SCHEMA), id: 'scim.other' }] });
  const res = resource();
  const done = await applyIdentityObjectWrite(same, res, 'create', { ...FAST, approvedContentEffects: approved(res, 'create') });
  assert.match(done.skipped.reason, /already has a provisioning job from this template with the backed-up schema/);
  assert.deepEqual(writes(same), []);
  const other = syncGraph({ jobs: [{ ...liveJob(widened()), id: 'scim.other' }] });
  const left = await applyIdentityObjectWrite(other, res, 'create', { ...FAST, approvedContentEffects: approved(res, 'create') });
  assert.match(left.skipped.reason, /^manual: The app already has a provisioning job from this template, with other mappings/);
  assert.deepEqual(writes(other), []);
});

test('a backup taken before the schema was read is a manual step, never a write of an empty schema', async () => {
  const graph = syncGraph({ jobs: [liveJob(widened())] });
  const { schema: _schema, ...old } = backupPayload();
  const result = await applyIdentityObjectWrite(graph, resource({ payload: old, targetId: JOB_ID, live: updateOf().live }), 'update', { ...FAST, approvedContentEffects: [] });
  assert.match(result.skipped.reason, /does not hold the provisioning job's schema/);
  assert.deepEqual(writes(graph), []);
});

test('through applyWave: the approved schema write goes out, and delete stays unsupported', async () => {
  const graph = syncGraph({ jobs: [liveJob(widened())] });
  const res = { ...updateOf(), verb: 'update' };
  const governor = { async acquire() {}, observeRetryAfter() {} };
  const outcome = await applyWave(graph, governor, [res], {
    targetTenant: 'fixture-tenant', mode: 'enforce', simulationPassed: true, approvedContentEffects: approved(res, 'update'),
    readAfterWriteOptions: FAST.readAfterWriteOptions,
  });
  assert.equal(outcome.failed.length, 0, JSON.stringify(outcome.failed));
  assert.equal(outcome.applied.length, 1);
  assert.deepEqual(graph.state.get(JOB_ID).schema, BACKUP_SCHEMA);
  assert.equal(capabilityFor('synchronizationJob', 'delete').claim, 'unsupported');
});

test('schema differences are named per object mapping', () => {
  const changedMapping = structuredClone(BACKUP_SCHEMA);
  changedMapping.synchronizationRules[0].objectMappings[0].attributeMappings[0].source.expression = '[mail]';
  assert.deepEqual(schemaChanges(changedMapping, BACKUP_SCHEMA), ['USER_OUTBOUND_USER: User to User: attribute mappings']);
  assert.deepEqual(schemaChanges(null, BACKUP_SCHEMA), ['USER_OUTBOUND_USER: User to User: added', 'directories and their attributes']);
  assert.deepEqual(schemaChanges(BACKUP_SCHEMA, BACKUP_SCHEMA), []);
});
