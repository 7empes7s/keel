/**
 * Issue #1016: the provisioning job fixture for the operations harness
 * (operations.mjs): the job as the backup holds it, how it drifts, and the
 * fake Graph routes for an app's jobs and a job's schema.
 */

// A SCIM provisioning job as the backup holds it: the job's template and
// schedule, and its schema in the shape Graph returns
// (synchronization-synchronizationschema-get): one rule mapping users with a
// scoping filter on department.
export const SYNC_JOB_PAYLOAD = Object.freeze({
  id: 'scim.fixture0000000000000000000000000.fixture-tenant', templateId: 'scim',
  schedule: { expiration: null, interval: 'PT40M', state: 'Active' }, servicePrincipalId: 'fixture-sp',
  schema: {
    directories: [
      { id: 'fixture-directory-aad', name: 'Azure Active Directory', objects: [{ name: 'User', attributes: [
        { anchor: false, caseExact: false, defaultValue: null, metadata: [], multivalued: false, mutability: 'ReadWrite', name: 'userPrincipalName', required: false, type: 'String' },
        { anchor: false, caseExact: false, defaultValue: null, metadata: [], multivalued: false, mutability: 'ReadWrite', name: 'department', required: false, type: 'String' },
      ] }] },
      { id: 'fixture-directory-scim', name: 'customappsso', objects: [{ name: 'User', attributes: [
        { anchor: true, caseExact: false, defaultValue: null, metadata: [], multivalued: false, mutability: 'ReadWrite', name: 'userName', required: true, type: 'String' },
      ] }] },
    ],
    synchronizationRules: [{
      editable: true, id: 'scim', metadata: [], name: 'USER_OUTBOUND_USER', priority: 1,
      sourceDirectoryName: 'Azure Active Directory', targetDirectoryName: 'customappsso',
      objectMappings: [{
        enabled: true, flowTypes: 'Add, Update, Delete', metadata: [], name: 'Provision Azure Active Directory Users',
        sourceObjectName: 'User', targetObjectName: 'User',
        attributeMappings: [{
          defaultValue: '', exportMissingReferences: false, flowBehavior: 'FlowWhenChanged', flowType: 'Always', matchingPriority: 1,
          source: { expression: '[userPrincipalName]', name: 'userPrincipalName', parameters: [], type: 'Attribute' }, targetAttributeName: 'userName',
        }],
        scope: { categoryFilterGroups: [], inputFilterGroups: [], groups: [{ clauses: [
          { operatorName: 'EQUALS', sourceOperandName: 'department', targetOperand: { values: ['Sales'] } },
        ] }] },
      }],
    }],
  },
});

/** Someone widened the job's scoping filter to every department. */
export const syncJobDrift = (payload) => ({
  schema: { ...payload.schema, synchronizationRules: payload.schema.synchronizationRules.map((rule) => ({
    ...rule, objectMappings: rule.objectMappings.map((mapping) => ({ ...mapping, scope: null })),
  })) },
});

// An app's provisioning jobs, and one job (with its schema route).
const SYNC_JOBS = /^\/servicePrincipals\/[^/]+\/synchronization\/jobs$/;
const SYNC_JOB = /^(\/servicePrincipals\/[^/]+\/synchronization\/jobs\/[^/]+)(\/schema)?$/;
const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } });

/**
 * A write to a job, or null for any other path: a job is created from its
 * template, stopped, with an empty schema, and its schema is replaced whole
 * at .../schema. The fake keeps the schema on the job object.
 */
export function syncJobWrite(objects, path, method, body, nextId) {
  if (method === 'POST' && SYNC_JOBS.test(path)) {
    if (typeof body?.templateId !== 'string') return { ok: false, status: 400, body: { error: { code: 'BadRequest', message: 'templateId is required' } } };
    const job = { id: `${body.templateId}.fixture${nextId()}`, templateId: body.templateId, schedule: { expiration: null, interval: 'PT40M', state: 'Disabled' } };
    objects.set(`${path}/${job.id}`, { ...job, schema: { directories: [], synchronizationRules: [] } });
    return { ok: true, status: 201, body: job };
  }
  const schemaOf = SYNC_JOB.exec(path);
  if (!schemaOf?.[2] || method !== 'PUT') return null;
  if (!objects.has(schemaOf[1])) return notFound();
  objects.set(schemaOf[1], { ...objects.get(schemaOf[1]), schema: body });
  return { ok: true, status: 204, body: null };
}

/** A read of an app's jobs (each without its schema) or of one job's schema, or null for any other path. */
export function syncJobRead(objects, path) {
  if (SYNC_JOBS.test(path)) {
    const value = [...objects.entries()].filter(([key]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'))
      .map(([, { schema: _schema, ...job }]) => job);
    return { ok: true, status: 200, body: { value } };
  }
  const match = SYNC_JOB.exec(path);
  if (!match) return null;
  const job = objects.get(match[1]);
  if (!job) return notFound();
  const { schema, ...own } = job;
  return { ok: true, status: 200, body: match[2] ? { ...schema, version: 'Date:2026-11-06T00:00:00Z' } : own };
}
