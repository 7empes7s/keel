/**
 * Issue #1016: app provisioning (synchronizationJob), the job and its schema:
 * the attribute mappings, scoping filters and directories a provisioning or
 * cross-tenant sync job works with. Microsoft's own way to roll provisioning
 * back is to export the schema and put it back (PUT .../jobs/{id}/schema).
 *
 *  - update: the backed-up schema is put back on the live job (PUT). The next
 *    cycle after a schema change is an initial cycle: it re-evaluates every
 *    user and group in scope, and can create, update or disable accounts in the
 *    other directory. So the write is a "changes access" effect behind the
 *    restore approval, and every write and dry run says so.
 *  - create: a job missing from its app is created from the backed-up template
 *    and its schema put on it, and it is left stopped. Its credentials (Graph
 *    never returns them) and starting it are steps for a person. A job of the
 *    same template already on the app is never duplicated.
 *  - the app is matched in the target by its app id (the servicePrincipalId
 *    reference); a job is never started, restarted or paused (a schedule that
 *    differs from the backup is a step), and delete is not registered.
 *
 * Routes follow the Graph v1.0 references (synchronization-synchronization-post-jobs,
 * synchronization-synchronizationschema-update) and are fixture-tested, not
 * live-qualified.
 */
import { readAllPages, withApprovalGate } from './approvalHeld.mjs';
import { defineRecord, outcomeDetail, sameValue, withoutAnnotations } from './recordWriter.mjs';

const TYPE = 'synchronizationJob';
const PORTAL = 'the Entra admin center, under Enterprise apps, the app, Provisioning';
const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
// What a schema PUT takes (synchronization-synchronizationschema-update).
const SCHEMA_PARTS = Object.freeze(['directories', 'synchronizationRules']);

const lower = (value) => String(value ?? '').toLowerCase();
const list = (value) => (Array.isArray(value) ? value : []);
const step = (requirement, fields, description) => Object.freeze({ kind: 'manual-setting', requirement, fields: Object.freeze(fields), description });
const jobsPath = (servicePrincipalId) => `/servicePrincipals/${encodeURIComponent(servicePrincipalId)}/synchronization/jobs`;
const jobPath = (servicePrincipalId, jobId) => `${jobsPath(servicePrincipalId)}/${encodeURIComponent(jobId)}`;

/** The schema as a PUT sends it: its directories and rules, without annotations. */
export function schemaBody(schema) {
  if (!schema || typeof schema !== 'object') return null;
  return withoutAnnotations(Object.fromEntries(SCHEMA_PARTS.filter((part) => schema[part] !== undefined).map((part) => [part, schema[part]])));
}

const sameSchema = (left, right) => sameValue(schemaBody(left), schemaBody(right));

/**
 * What differs between two schemas, in words: one line per object mapping
 * (rule, then source to target object) whose attribute mappings or scoping
 * filter differ, or that only one side has. Directories are named once.
 */
export function schemaChanges(live, backup) {
  const mappings = (schema) => new Map(list(schema?.synchronizationRules).flatMap((rule) => list(rule?.objectMappings)
    .map((mapping) => [`${rule?.name ?? 'unnamed rule'}: ${mapping?.sourceObjectName ?? '?'} to ${mapping?.targetObjectName ?? '?'}`, mapping])));
  const had = mappings(live);
  const want = mappings(backup);
  const changes = [];
  for (const [name, mapping] of want) {
    const held = had.get(name);
    if (!held) { changes.push(`${name}: added`); continue; }
    const parts = [];
    if (!sameValue(withoutAnnotations(held.attributeMappings), withoutAnnotations(mapping.attributeMappings))) parts.push('attribute mappings');
    if (!sameValue(withoutAnnotations(held.scope), withoutAnnotations(mapping.scope))) parts.push('scoping filter');
    if (held.enabled !== mapping.enabled || held.flowTypes !== mapping.flowTypes) parts.push('whether it runs and what it does');
    if (parts.length > 0) changes.push(`${name}: ${parts.join(', ')}`);
  }
  for (const name of had.keys()) if (!want.has(name)) changes.push(`${name}: removed`);
  if (!sameValue(withoutAnnotations(live?.directories), withoutAnnotations(backup?.directories))) changes.push('directories and their attributes');
  return changes;
}

const REEVALUATION = step('provisioningReevaluation', ['schema'], 'After its schema changes, the job\'s next cycle is an initial cycle: '
  + 'it checks every user and group in scope again, and can create, update or disable their accounts in the other directory. '
  + `Before it runs, check the mappings and scoping filters in ${PORTAL}, and try a few people with Provision on demand.`);
const CREDENTIALS = step('provisioningCredentials', ['secrets'], 'Microsoft never returns a provisioning job\'s admin credentials, so the '
  + `recreated job has none. Enter them again in ${PORTAL}, under Admin credentials (such as the tenant URL and secret token), and select Test connection.`);
const startStep = (backedUpState) => step('provisioningStart', ['schedule'], 'KEEL created the job stopped and never starts one. '
  + (lower(backedUpState) === 'active'
    ? `It was running when the backup was taken: once the connection test passes and the mappings are checked, select Start provisioning in ${PORTAL}.`
    : `It was not running when the backup was taken: start it only if it should run, once the connection test passes, with Start provisioning in ${PORTAL}.`));

/** The step for a live job that runs when the backup's did not, or the other way round, or null. */
function scheduleStep(payload, live) {
  const want = lower(payload?.schedule?.state);
  const have = lower(live?.schedule?.state);
  if (!want || !have || want === have || (want !== 'active' && have !== 'active')) return null;
  return step('provisioningSchedule', ['schedule'], want === 'active'
    ? `The job was running when the backup was taken and is not running now. KEEL never starts a job: check the mappings, then select Start provisioning in ${PORTAL}.`
    : `The job was not running when the backup was taken and is running now. KEEL never stops a job: if it should not run, select Stop provisioning in ${PORTAL}.`);
}

/** The steps a write leaves (or a dry run says it would leave). */
function jobSteps({ payload, verb, before }) {
  if (verb === 'create') return [REEVALUATION, CREDENTIALS, startStep(payload?.schedule?.state)];
  return [...(sameSchema(payload?.schema, before?.schema) ? [] : [REEVALUATION]), scheduleStep(payload, before)].filter(Boolean);
}

/** The job and its schema, as the backup holds them: { ok, status, body }. */
async function jobRead(io, { payload, targetId }) {
  if (!targetId) return { ok: false, status: 404, body: null };
  const job = await io.retryOperation(() => io.writer.read('v1.0', jobPath(payload.servicePrincipalId, targetId)));
  if (job?.ok !== true) return job;
  const schema = await io.retryOperation(() => io.writer.read('v1.0', `${jobPath(payload.servicePrincipalId, targetId)}/schema`));
  if (schema?.ok !== true) return schema;
  return { ok: true, status: 200, body: { id: job.body?.id, templateId: job.body?.templateId, schedule: job.body?.schedule, schema: schemaBody(schema.body) } };
}

/**
 * The write: an update puts the schema on the live job; a create makes the job
 * from its template, then puts the schema on it. Nothing starts the job.
 */
async function jobWrite(io, { payload, verb, sent, targetId }) {
  const putSchema = (jobId) => io.retryOperation(() => io.writer.write('v1.0', `${jobPath(payload.servicePrincipalId, jobId)}/schema`, { method: 'PUT', body: sent.schema }));
  if (verb !== 'create') return putSchema(targetId);
  const created = await io.retryOperation(() => io.writer.write('v1.0', jobsPath(payload.servicePrincipalId), { method: 'POST', body: { templateId: sent.templateId } }));
  if (!created?.ok) return created ?? { ok: false, error: 'no response to the job create' };
  const jobId = created.body?.id;
  if (typeof jobId !== 'string' || jobId.length === 0) return { ok: false, error: 'the job create returned no id' };
  const put = await putSchema(jobId);
  if (!put?.ok) return { ok: false, status: put?.status ?? null, error: `the job was created and left stopped, but its schema could not be written (${outcomeDetail(put)}); put it back by hand in ${PORTAL}, under Mappings` };
  return { ok: true, status: 201, body: { id: jobId } };
}

/**
 * Before a create: the app is in the target, and has no job of this template
 * already. One with the backed-up schema is done; one with another schema is
 * left for a person (an app runs one job per template).
 */
async function jobPreflight(io, { payload, verb }) {
  if (verb !== 'create') return null;
  const listed = await readAllPages(io, 'v1.0', jobsPath(payload.servicePrincipalId));
  if (listed.error) return `the enterprise app's provisioning jobs could not be read (${listed.error}); if the app is not in the target, restore it first`;
  const same = listed.value.find((job) => lower(job?.templateId) === lower(payload.templateId));
  if (!same) return null;
  const schema = await io.retryOperation(() => io.writer.read('v1.0', `${jobPath(payload.servicePrincipalId, same.id)}/schema`));
  if (schema?.ok === true && sameSchema(payload.schema, schema.body)) {
    return { skipped: 'the app already has a provisioning job from this template with the backed-up schema, so nothing is written' };
  }
  const description = 'The app already has a provisioning job from this template, with other mappings. KEEL does not make a second job: '
    + `compare its mappings and scoping filters with the backup in ${PORTAL}, and change them by hand if needed.`;
  return { skipped: `manual: ${description}`, completion: [step('provisioningJobExists', ['schema'], description)] };
}

/** In a dry run: which mappings and scoping filters the write changes. */
function jobPlan(_io, { payload, verb, before }) {
  const changes = schemaChanges(verb === 'create' ? null : before?.schema, payload.schema);
  return changes.length > 0 ? { schemaChanges: changes } : null;
}

/** A backup with no schema (taken before KEEL read it), or a create with no template, cannot be written. */
function jobRefusal(resource, verb) {
  const payload = resource.payload;
  if (payload && typeof payload === 'object' && (!payload.schema || (verb === 'create' && typeof payload.templateId !== 'string'))) {
    const description = 'This backup does not hold the provisioning job\'s schema or its template (it was taken before KEEL read them). '
      + `Nothing was written: restore from a newer backup, or set the mappings up by hand in ${PORTAL}.`;
    return Object.freeze({ outcome: 'skipped', reason: `manual: ${description}`, completion: Object.freeze([step('provisioningSchema', ['schema'], description)]) });
  }
  return null;
}

export const SYNCHRONIZATION_JOB_RECORD = defineRecord({
  resourceType: TYPE, version: 'v1.0',
  collectionFor: (payload) => (payload?.servicePrincipalId ? jobsPath(payload.servicePrincipalId) : null),
  operations: ['create', 'update'], writable: ['schema'], createOnly: ['templateId'],
  transform: (body) => (body.schema ? { ...body, schema: schemaBody(body.schema) } : body),
  sameField: (field, desired, live) => (field === 'schema' ? sameSchema(desired, live) : null),
  // The app is named by its id in the target (found by app id), never by the backup's.
  remapsReferences: true,
  refusal: withApprovalGate(jobRefusal),
  preflight: jobPreflight, planChanges: jobPlan, planCompletion: jobSteps,
  afterWrite: async (_io, { payload, verb, before }) => ({ completion: jobSteps({ payload, verb, before }) }),
  writeVia: jobWrite, readVia: jobRead, writeRoute: '/servicePrincipals/{id}/synchronization/jobs; PUT .../jobs/{id}/schema',
  permission: 'Synchronization.ReadWrite.All', docs: `${DOCS}/synchronization-synchronizationschema-update?view=graph-rest-1.0`,
});
