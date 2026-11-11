/**
 * Issue #1075: restore of four Entra directory objects that had no writer.
 *
 * 1. Verified ID profiles (verifiedIdProfile, Graph beta). Its name,
 *    description, state, priority, Face Check setting and purposes are written.
 *    The accepted issuer, claim bindings and credential type
 *    (verifiedIdProfileConfiguration), the verifier's DID and the accepted
 *    driver's licence issuers are trust fields, never written (TRUST_FIELDS); a
 *    difference is a step. Graph creates a profile only with its accepted
 *    issuer, so KEEL never POSTs one: a create updates the live profile with the
 *    backup's name, or is a step that names the issuer to set up. State,
 *    priority, Face Check and purposes are "changes sign-in" effects.
 * 2. Lifecycle policies (lifecyclePolicy, Graph beta). Created switched off
 *    (isEnabled false), with its name, description, action, grace period,
 *    notifications and scope kind; turning it on, its rules (not backed up) and
 *    excluded groups are steps. An update never turns one on; on a policy that
 *    is on, a change to its scope, action or grace period waits for its
 *    "acts on accounts" approval. Microsoft's default policy is never created.
 * 3. Device templates (deviceTemplate, Graph beta). Created with its device
 *    authority, maker, model and operating system; a template is immutable, so
 *    there is no update. Its mutual TLS configuration (how devices made from it
 *    prove themselves with a certificate) is a trust field: a template that has
 *    one is a step. Its owners are a step.
 * 4. Schema extensions (schemaExtension, Graph v1.0). Created with the
 *    backup's id, owner app, target types and properties, only when the owner
 *    app is in the target. The values stored on users and groups are not
 *    restored. An extension that is already there is left as it is.
 *
 * Delete is not registered for any of them.
 */
import { lifecyclePolicyEffects, verifiedIdProfileEffects } from '../safety/directorySettingEffects.mjs';
import { readAllPages } from './approvalHeld.mjs';
import {
  APPROVE_STEP, directoryEntry, entryRefusal, lower, runOf, skipped, step, unapproved, writeAndVerify,
} from './directorySettingOperations.mjs';
import { outcomeDetail, sameValue, trustFieldStep, withoutAnnotations } from './recordWriter.mjs';

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const ENTRA = 'Microsoft Entra admin center';
const isNotFound = (result) => result?.ok === false && result?.status === 404;
const kindOf = (odataType) => String(odataType ?? '').replace(/^#?microsoft\.graph\./, '');

export const DIRECTORY_OBJECT_RECORDS = Object.freeze({
  verifiedIdProfile: directoryEntry({
    resourceType: 'verifiedIdProfile', collection: '/identity/verifiedId/profiles', version: 'beta',
    permission: 'VerifiedId-Profile.ReadWrite.All', docs: `${DOCS}/verifiedidprofile-update?view=graph-rest-beta`,
    // A create never POSTs: it updates the live profile with the backup's name.
    operations: ['create', 'update'], fields: ['name', 'description', 'state', 'priority', 'faceCheckConfiguration', 'verifiedIdUsageConfigurations'],
    portalPath: `${ENTRA} > Verified ID > Verification profiles`,
  }),
  lifecyclePolicy: directoryEntry({
    resourceType: 'lifecyclePolicy', collection: '/identityGovernance/lifecycleWorkflows/lifecyclePolicies', version: 'beta',
    permission: 'LifecyclePolicies-AgentId.ReadWrite.All', docs: `${DOCS}/identitygovernance-lifecycleworkflowscontainer-post-lifecyclepolicies?view=graph-rest-beta`,
    operations: ['create', 'update'], fields: ['displayName', 'description', 'gracePeriodInDays', 'enforcementAction', 'notificationSchedule', 'scope'],
    portalPath: `${ENTRA} > Identity Governance > Lifecycle workflows > Lifecycle policies`,
  }),
  deviceTemplate: directoryEntry({
    resourceType: 'deviceTemplate', collection: '/templates/deviceTemplates', version: 'beta',
    permission: 'DeviceTemplate.ReadWrite.All', docs: `${DOCS}/template-post-devicetemplates?view=graph-rest-beta`,
    operations: ['create'], fields: ['deviceAuthority', 'manufacturer', 'model', 'operatingSystem'],
    portalPath: 'Microsoft Graph PowerShell (New-MgBetaTemplateDeviceTemplate)',
  }),
  schemaExtension: directoryEntry({
    resourceType: 'schemaExtension', collection: '/schemaExtensions', version: 'v1.0',
    permission: 'Application.ReadWrite.All', docs: `${DOCS}/schemaextension-post-schemaextensions?view=graph-rest-1.0`,
    operations: ['create'], fields: ['id', 'description', 'owner', 'targetTypes', 'properties'],
    portalPath: 'Microsoft Graph PowerShell (New-MgSchemaExtension)',
  }),
});

const APPLY = Object.freeze({ verifiedIdProfile: applyVerifiedIdWrite, lifecyclePolicy: applyLifecycleWrite, deviceTemplate: applyDeviceTemplateCreate, schemaExtension: applySchemaExtensionCreate });

/**
 * One write of a Verified ID profile, lifecycle policy, device template or
 * schema extension: the registered writer applyWave calls (writers/entra.mjs).
 * Returns { applied }, { skipped } or { failed }.
 */
export async function applyDirectoryObjectWrite(writer, resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const entry = DIRECTORY_OBJECT_RECORDS[resource.resourceType];
  if (!entry) return { failed: { naturalKey, error: `${resource.resourceType} is not a directory object KEEL writes` } };
  const run = runOf(ctx);
  const refused = entryRefusal(entry, resource, verb, run);
  if (refused?.failed) return { failed: { naturalKey, error: refused.failed } };
  return APPLY[entry.resourceType](writer, entry, resource, verb, run);
}

const liveTarget = (resource) => resource.live?.targetId ?? resource.live?.payload?.id ?? resource.targetId ?? null;
const objectPath = (entry, id) => `${entry.collection}/${encodeURIComponent(id)}`;
const changedFields = (entry, desired, live, same = (field, left, right) => sameValue(withoutAnnotations(left), withoutAnnotations(right))) => entry.fields
  .filter((field) => desired[field] !== undefined && !same(field, desired[field], live?.[field]));
const bodyOf = (desired, fields) => Object.fromEntries(fields.map((field) => [field, withoutAnnotations(desired[field])]));
const listAll = (writer, run, entry) => readAllPages({ writer, retryOperation: run.retryOperation }, entry.version, entry.collection);

// --------------------------------------------------------------- Verified ID

function missingProfileStep(entry, payload) {
  const config = payload.verifiedIdProfileConfiguration ?? {};
  const issuer = config.acceptedIssuer ? ` accepting credentials from ${config.acceptedIssuer}` : '';
  const type = config.type ? ` of type ${config.type}` : '';
  return step('recreateProfile',
    `The Verified ID profile "${payload.name ?? 'unnamed'}" is not in this tenant. KEEL never writes which credential issuer a profile trusts, so it never creates one. `
    + `Create it by hand in the ${entry.portalPath}${issuer}${type}, with the same claims, then run the restore again: it puts back its state, priority, Face Check and purposes.`,
    entry.portalPath);
}

async function applyVerifiedIdWrite(writer, entry, resource, verb, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  if (run.mode !== 'dry-run') {
    const open = unapproved(verifiedIdProfileEffects, resource, verb, run.approved);
    if (open.length > 0) {
      const fields = [...new Set(open.map((effect) => effect.field))];
      return skipped(naturalKey, [step('signInApproval',
        `The Verified ID profile "${desired.name}" is not ${verb === 'create' ? 'put back' : 'updated'} yet. This changes how people prove who they are (${fields.join(', ')}), so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
        entry.portalPath, { fields: Object.freeze(fields) })]);
    }
  }
  let targetId = verb === 'update' ? liveTarget(resource) : null;
  let live = verb === 'update' ? resource.live.payload : null;
  if (verb === 'create') {
    const listed = await listAll(writer, run, entry);
    if (listed.error) return { failed: { naturalKey, error: `could not list the Verified ID profiles to find "${desired.name}" (${listed.error})` } };
    const named = listed.value.filter((row) => lower(row?.name) === lower(desired.name));
    if (named.length > 1) return { failed: { naturalKey, error: `${named.length} Verified ID profiles are named "${desired.name}", so KEEL cannot tell which one to use` } };
    if (named.length === 0) return skipped(naturalKey, [missingProfileStep(entry, desired)]);
    [live] = named;
    targetId = live.id;
  }
  if (!targetId) return { failed: { naturalKey, error: 'verifiedIdProfile update has no target id' } };
  const fields = changedFields(entry, desired, live);
  const trust = trustFieldStep(entry.resourceType, desired, live, 'update');
  const done = () => ({ applied: { naturalKey, targetId, changes: { fields }, ...(trust ? { completion: [trust] } : {}) } });
  if (fields.length === 0 || run.mode === 'dry-run') return done();
  const path = objectPath(entry, targetId);
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation: 'update', method: 'PATCH', path, readPath: path, body: bodyOf(desired, fields), live, targetId,
    what: `the Verified ID profile "${desired.name}"`, problems: (read) => changedFields({ fields }, desired, read),
  });
  return result.error ? { failed: result.error } : done();
}

// ------------------------------------------------------------ lifecycle policies

/** A scope KEEL writes: only its kind. One that names groups (or anything else) is set by a person. */
const scopeKindOnly = (scope) => scope === null || scope === undefined
  || Object.entries(scope).every(([key, value]) => key === '@odata.type' || key.includes('@odata.') || value === null || (Array.isArray(value) && value.length === 0));
const sameKind = (left, right) => lower(kindOf(left)) === lower(kindOf(right));
const policySame = (field, left, right) => (field === 'scope' ? sameKind(left?.['@odata.type'], right?.['@odata.type']) && (left == null) === (right == null)
  : sameValue(withoutAnnotations(left), withoutAnnotations(right)));

async function applyLifecycleWrite(writer, entry, resource, verb, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  const kind = desired['@odata.type'];
  if (typeof kind !== 'string') return { failed: { naturalKey, error: 'lifecyclePolicy: the backup does not say which kind of policy it is (@odata.type), which Graph needs' } };
  if (verb === 'create' && desired.policySource === 'systemDefault') {
    return skipped(naturalKey, [step('microsoftDefault', `"${desired.displayName}" is Microsoft's default lifecycle policy, which Microsoft makes; KEEL never creates it. Check its settings in the ${entry.portalPath} against the backup.`, entry.portalPath)]);
  }
  if (run.mode !== 'dry-run') {
    const open = unapproved(lifecyclePolicyEffects, resource, verb, run.approved);
    if (open.length > 0) {
      const fields = [...new Set(open.map((effect) => effect.field))];
      return skipped(naturalKey, [step('accountsApproval',
        `The lifecycle policy "${desired.displayName}" is on, and this changes which accounts it disables or deletes (${fields.join(', ')}), so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
        entry.portalPath, { fields: Object.freeze(fields) })]);
    }
  }
  let operation = verb;
  let targetId = verb === 'update' ? liveTarget(resource) : null;
  let live = verb === 'update' ? resource.live.payload : null;
  // A create first looks for the policy an earlier run (or a person) made: the same kind and name.
  if (verb === 'create') {
    const listed = await listAll(writer, run, entry);
    if (listed.error) return { failed: { naturalKey, error: `could not list the lifecycle policies to look for one made before (${listed.error})` } };
    const twins = listed.value.filter((row) => sameKind(row?.['@odata.type'], kind) && lower(row?.displayName) === lower(desired.displayName));
    if (twins.length > 1) return { failed: { naturalKey, error: `${twins.length} lifecycle policies are named "${desired.displayName}", so KEEL cannot tell which one to keep` } };
    if (twins.length === 1) {
      // Its effects were judged as a create (off): a twin that is on is checked by a person.
      if (twins[0].isEnabled === true) {
        return skipped(naturalKey, [step('policyOn', `A lifecycle policy named "${desired.displayName}" is already on in this tenant. KEEL does not change a policy that is on without its approval: compare it with the backup in the ${entry.portalPath}.`, entry.portalPath)]);
      }
      operation = 'update';
      [live] = twins;
      targetId = live.id;
    }
  }
  if (operation === 'update' && !targetId) return { failed: { naturalKey, error: 'lifecyclePolicy update has no target id' } };

  const completion = [];
  const scopeHeld = !scopeKindOnly(desired.scope) || (operation === 'update' && !scopeKindOnly(live?.scope));
  if (scopeHeld && (operation === 'create' || !sameValue(withoutAnnotations(desired.scope), withoutAnnotations(live?.scope)))) {
    completion.push(step('policyScope', `The scope of "${desired.displayName}" names groups (or other objects) by id, which KEEL does not match into this tenant: set who it excludes by hand from the backup before turning it on.`, entry.portalPath, { fields: Object.freeze(['scope']) }));
  }
  const writable = entry.fields.filter((field) => field !== 'scope' || !scopeHeld);
  let fields = operation === 'create' ? writable.filter((field) => desired[field] !== undefined)
    : changedFields({ fields: writable }, desired, live, policySame);
  const body = bodyOf(desired, fields);
  if (body.scope) body.scope = { '@odata.type': desired.scope['@odata.type'] };
  if (operation === 'create') {
    body['@odata.type'] = kind;
    body.isEnabled = false;
    completion.push(step('policyRules', `"${desired.displayName}" was created switched off and without rules (the backup does not hold them). Add its rules, check who it covers, then turn it on by hand.`, entry.portalPath));
  } else if (desired.isEnabled === false && live?.isEnabled === true) {
    // Turning a policy off is the safe direction; turning one on stays a step.
    body.isEnabled = false;
    fields = [...fields, 'isEnabled'];
  } else if (desired.isEnabled === true && live?.isEnabled !== true) {
    completion.push(step('turnOn', `"${desired.displayName}" is on in the backup and off here. KEEL never turns a lifecycle policy on: check who it covers, then turn it on by hand.`, entry.portalPath, { fields: Object.freeze(['isEnabled']) }));
  }
  const done = (id) => ({ applied: { naturalKey, targetId: id, changes: { fields }, ...(completion.length ? { completion } : {}) } });
  if ((operation === 'update' && fields.length === 0) || run.mode === 'dry-run') return done(targetId);

  const sentSame = (read) => Object.keys(body).filter((field) => field !== '@odata.type' && !policySame(field, body[field], read?.[field]));
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation, method: operation === 'create' ? 'POST' : 'PATCH',
    path: operation === 'create' ? entry.collection : objectPath(entry, targetId),
    readPath: operation === 'create' ? (answer) => (answer?.id ? objectPath(entry, answer.id) : null) : objectPath(entry, targetId),
    body: operation === 'update' ? { '@odata.type': kind, ...body } : body, live, targetId,
    what: `the lifecycle policy "${desired.displayName}"`, problems: sentSame,
  });
  return result.error ? { failed: result.error } : done(result.id);
}

// ------------------------------------------------------------- device templates

const sameTemplate = (row, payload) => ['deviceAuthority', 'manufacturer', 'model', 'operatingSystem'].every((field) => lower(row?.[field]) === lower(payload[field]));

async function applyDeviceTemplateCreate(writer, entry, resource, _verb, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  const label = `${desired.manufacturer ?? 'unknown maker'} ${desired.model ?? ''}`.trim();
  // Devices made from a template with a mutual TLS configuration prove themselves with its certificates: never written.
  if (desired.mutualTlsOauthConfigurationId || desired.mutualTlsOauthConfigurationTenantId) {
    return skipped(naturalKey, [step('trustFields',
      `The device template for ${label} uses a mutual TLS configuration (${desired.mutualTlsOauthConfigurationId ?? 'no id'} in tenant ${desired.mutualTlsOauthConfigurationTenantId ?? 'unknown'}), which decides which certificates its devices sign in with. `
      + `A restore never writes certificate trust, so it was not created: create it by hand (${entry.portalPath}) with the values your device maker gave you.`,
      entry.portalPath, { fields: Object.freeze(['mutualTlsOauthConfigurationId', 'mutualTlsOauthConfigurationTenantId']) })]);
  }
  const owners = step('templateOwners', `Add the owners of the device template for ${label} again by hand (${entry.portalPath}): the backup does not hold them, and only owners and admins can make devices from it.`, entry.portalPath);
  const listed = await listAll(writer, run, entry);
  if (listed.error) return { failed: { naturalKey, error: `could not list the device templates to look for one made before (${listed.error})` } };
  const twins = listed.value.filter((row) => sameTemplate(row, desired));
  if (twins.length > 0) return { applied: { naturalKey, targetId: twins[0].id, changes: { fields: [] }, completion: [owners] } };
  const fields = entry.fields.filter((field) => desired[field] !== undefined);
  const done = (id) => ({ applied: { naturalKey, targetId: id, changes: { fields }, completion: [owners] } });
  if (run.mode === 'dry-run') return done(null);
  const body = bodyOf(desired, fields);
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation: 'create', method: 'POST', path: entry.collection,
    readPath: (answer) => (answer?.id ? objectPath(entry, answer.id) : null), body, live: null,
    what: `the device template for ${label}`, problems: (read) => fields.filter((field) => lower(read?.[field]) !== lower(body[field])),
  });
  return result.error ? { failed: result.error } : done(result.id);
}

// ------------------------------------------------------------- schema extensions

const propertyList = (properties) => (properties ?? []).map((property) => `${property?.name}:${lower(property?.type)}`).sort();
const sameExtensionField = (field, left, right) => (field === 'properties' ? sameValue(propertyList(left), propertyList(right))
  : field === 'targetTypes' ? sameValue([...(left ?? [])].map(lower).sort(), [...(right ?? [])].map(lower).sort())
    : sameValue(left ?? null, right ?? null));

async function applySchemaExtensionCreate(writer, entry, resource, _verb, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  const { id, owner } = desired;
  if (typeof id !== 'string' || !id || typeof owner !== 'string' || !owner) {
    return { failed: { naturalKey, error: 'schemaExtension: the backup does not hold its id and owner app, which a create needs' } };
  }
  const values = step('extensionValues', `The values apps stored in the schema extension ${id} on users and groups are not backed up, so they are not restored: the owner app writes them again.`, entry.portalPath);
  const found = await run.retryOperation(() => writer.read(entry.version, objectPath(entry, id)));
  if (found?.ok === true) return { applied: { naturalKey, targetId: id, changes: { fields: [] }, completion: [values] } };
  if (!isNotFound(found)) return { failed: { naturalKey, error: `could not read the schema extension ${id} to look for one made before (${outcomeDetail(found)})` } };
  // Only the owner app may use the extension, so it is created only for an owner that is here.
  const app = await run.retryOperation(() => writer.read('v1.0', `/applications(appId='${encodeURIComponent(owner.replace(/'/g, "''"))}')`));
  if (isNotFound(app)) {
    return skipped(naturalKey, [step('ownerAppFirst', `The schema extension ${id} belongs to the app ${owner}, which is not in this tenant. Restore or register that app first, then run the restore again.`, entry.portalPath)]);
  }
  if (app?.ok !== true) return { failed: { naturalKey, error: `could not read the owner app ${owner} of the schema extension ${id} (${outcomeDetail(app)})` } };

  const fields = entry.fields.filter((field) => desired[field] !== undefined);
  const completion = [values];
  if (desired.status && desired.status !== 'InDevelopment') {
    completion.push(step('extensionStatus', `The schema extension ${id} was ${desired.status} in the backup; a new one starts In development. Mark it ${desired.status} by hand once its app is checked: after that it can no longer be deleted.`, entry.portalPath, { fields: Object.freeze(['status']) }));
  }
  const done = (targetId) => ({ applied: { naturalKey, targetId, changes: { fields }, completion } });
  if (run.mode === 'dry-run') return done(id);
  const body = bodyOf(desired, fields);
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation: 'create', method: 'POST', path: entry.collection,
    readPath: (answer) => (answer?.id ? objectPath(entry, answer.id) : null), body, live: null,
    what: `the schema extension ${id}`, problems: (read) => fields.filter((field) => field !== 'id' && !sameExtensionField(field, body[field], read?.[field])),
  });
  if (result.error) return { failed: result.error };
  // Graph keeps the id only under a verified domain name; otherwise it adds its own prefix.
  if (result.id !== id) {
    completion.push(step('extensionId', `Graph gave the recreated schema extension the id ${result.id}, not ${id}: change the owner app to use the new id.`, entry.portalPath));
  }
  return done(result.id);
}
