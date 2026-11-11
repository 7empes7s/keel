/**
 * Issue #1075: restore of three Entra directory settings that Graph names by
 * a fixed name rather than an id.
 *
 * 1. Sign-in identifiers (signInIdentifier, Graph beta): which identifiers
 *    people can sign in with (Email, UPN, Username, CustomUsername1/2). Only
 *    whether each one is on (isEnabled) is written, by an update of the
 *    identifier with the backup's name. Turning one on or off changes how
 *    everyone in the tenant signs in, so every change is a "changes sign-in"
 *    effect, written only once the restore's dry run is approved.
 * 2. Default cross-tenant Microsoft 365 capabilities (crossTenantM365Capability,
 *    Graph beta): calendar sharing, mail tips, room booking and the other
 *    capabilities other tenants get by default. Only inboundAccess is written.
 *    Its resourceScopes name groups by id, which are not matched in the target:
 *    a scope that differs from live is a step for a person, and inboundAccess is
 *    then left alone. Opening or closing a capability is an "externally
 *    sharing" effect, written only once approved.
 * 3. Profile card fields (profileCardProperty, Graph v1.0): which hidden
 *    directory field is shown on profile cards, and its labels. A missing field
 *    is created, an existing one updated (its annotations and isVisible).
 *
 * All three are one setting per tenant (on the test tenant they are written
 * only with the tenant-wide option). Delete is not registered. The shared
 * write helpers below are used by directoryObjectOperations.mjs too.
 */
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { effectApproved } from '../safety/contentEffects.mjs';
import { crossTenantCapabilityEffects, sameScopes, signInIdentifierEffects } from '../safety/directorySettingEffects.mjs';
import { outcomeDetail, sameValue, tenantWideRecordProblem, withoutAnnotations } from './recordWriter.mjs';
import { classifyWriteOutcome } from './rollbackJournal.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const ENTRA = 'Microsoft Entra admin center';

/** A frozen writer entry; it never lists a trust, certificate or sign-in field (CLAUDE.md restore-writer rule). */
export const directoryEntry = (fields) => {
  const trust = fields.fields.filter((field) => isTrustField(fields.resourceType, field));
  if (trust.length) throw new Error(`${fields.resourceType} declares trust, certificate or sign-in fields a restore never writes: ${trust.join(', ')}`);
  return Object.freeze({ ...fields, fields: Object.freeze([...fields.fields]), operations: Object.freeze([...fields.operations]) });
};

export const DIRECTORY_SETTING_RECORDS = Object.freeze({
  signInIdentifier: directoryEntry({
    resourceType: 'signInIdentifier', collection: '/identity/signInIdentifiers', version: 'beta', tenantWide: true,
    permission: 'SignInIdentifier.ReadWrite.All', docs: `${DOCS}/signinidentifierbase-update?view=graph-rest-beta`,
    operations: ['update'], fields: ['isEnabled'],
    portalPath: `${ENTRA} > External Identities > All identity providers > Sign-in identifiers`,
  }),
  crossTenantM365Capability: directoryEntry({
    resourceType: 'crossTenantM365Capability', collection: '/policies/crossTenantAccessPolicy/default/m365Capabilities', version: 'beta', tenantWide: true,
    permission: 'Policy.ReadWrite.CrossTenantCapability', docs: `${DOCS}/crosstenantaccesspolicyconfigurationdefault-update-m365capabilities?view=graph-rest-beta`,
    operations: ['update'], fields: ['inboundAccess'],
    portalPath: `${ENTRA} > External Identities > Cross-tenant access settings > Default settings`,
  }),
  profileCardProperty: directoryEntry({
    resourceType: 'profileCardProperty', collection: '/admin/people/profileCardProperties', version: 'v1.0', tenantWide: true,
    permission: 'PeopleSettings.ReadWrite.All', docs: `${DOCS}/peopleadminsettings-post-profilecardproperties?view=graph-rest-1.0`,
    operations: ['create', 'update'], fields: ['annotations', 'isVisible'],
    portalPath: 'Microsoft Graph PowerShell (New-MgAdminPeopleProfileCardProperty, Update-MgAdminPeopleProfileCardProperty)',
  }),
});

const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';
export const lower = (value) => String(value ?? '').toLowerCase();
const isNotFound = (result) => result?.ok === false && result?.status === 404;

export const APPROVE_STEP = 'Run the restore as a dry run, have someone other than you approve it in Approvals, then run it again. '
  + 'If restore approvals are turned off for Entra ID, running the reviewed dry run again writes it.';

export const step = (requirement, description, portalPath, extra = {}) => Object.freeze({ kind: 'manual-setting', requirement, portalPath, description, ...extra });
export const skipped = (naturalKey, completion) => ({ skipped: { naturalKey, reason: `manual: ${completion[0].description}`, completion } });

/** The effects of this write the promotion did not approve. */
export function unapproved(effectsOf, resource, verb, approvedContentEffects) {
  return effectsOf({ ...resource, verb })
    .map((effect) => ({ naturalKey: resource.naturalKey, resourceType: resource.resourceType, ...effect }))
    .filter((effect) => !effectApproved(effect, approvedContentEffects));
}

/** The registry ctx a write uses (writers/registry.mjs). */
export const runOf = (ctx) => ({
  ctx,
  mode: ctx.mode ?? 'enforce',
  retryOperation: ctx.retryOperation ?? ((operation) => operation()),
  journal: ctx.journalBeforeMutation ?? (async () => ({ ok: true, entryId: null })),
  note: ctx.noteOutcome ?? (async () => {}),
  readBack: ctx.readAfterWrite ?? null,
  approved: ctx.approvedContentEffects ?? [],
});

/** Refuses a write before any Graph call, or returns null. */
export function entryRefusal(entry, resource, verb, run) {
  if (!entry.operations.includes(verb)) return { failed: `${entry.resourceType} ${verb} is not written by KEEL` };
  const capability = capabilityFor(entry.resourceType, verb);
  if (!isSupportedClaim(capability.claim)) return { failed: `${entry.resourceType} ${verb} is not a registered write capability (claim: ${capability.claim})` };
  if (!resource.payload || typeof resource.payload !== 'object') return { failed: `${entry.resourceType}: the backup holds nothing to restore` };
  if (verb === 'update' && !present(resource)) return { failed: `dependency: no live ${entry.resourceType} was observed, so the update cannot be checked against it` };
  // A tenant-wide setting passes the test tenant's fixture guard, in the dry run too (recordWriter.mjs).
  const tenantWide = entry.tenantWide ? tenantWideRecordProblem(entry, run.ctx, resource) : null;
  return tenantWide ? { skipped: tenantWide } : null;
}

/**
 * The journal, write, read back and check every write here shares. `readPath`
 * is the object's path, or a function of Graph's answer to a create; `pick`
 * finds the object in what that read returns (a list, for a kind Graph reads
 * only as a list).
 */
export async function writeAndVerify(writer, run, { naturalKey, version, operation, method, path, readPath, pick = (body) => body, body, live, targetId = null, problems, what }) {
  const journal = await run.journal({ operation, targetId, priorState: live, intendedState: { ...(live ?? {}), ...body } });
  if (!journal.ok) return { error: { naturalKey, error: `refusing to ${operation}: rollback journal write failed` } };
  const written = await run.retryOperation(() => writer.write(version, path, { method, body }));
  if (!written?.ok) {
    await run.note(journal, classifyWriteOutcome(written), { ...(targetId ? { targetId } : {}), detail: outcomeDetail(written) });
    return { error: { naturalKey, error: `${what} failed: ${JSON.stringify(written?.body ?? written?.error ?? null)}`, ...(written?.status !== undefined ? { status: written.status } : {}) } };
  }
  const objectPath = typeof readPath === 'function' ? readPath(written.body) : readPath;
  if (!objectPath) {
    await run.note(journal, 'uncertain', { detail: `${operation} returned no id` });
    return { error: { naturalKey, error: `${what} returned no id` } };
  }
  const after = run.readBack
    ? await run.readBack(version, objectPath, (read) => isNotFound(read) || (read?.ok === true && problems(pick(read.body)).length > 0))
    : await run.retryOperation(() => writer.read(version, objectPath));
  const object = after?.ok === true ? pick(after.body) : null;
  if (!object) {
    await run.note(journal, 'uncertain', { targetId, detail: `${operation} could not be re-read` });
    return { error: { naturalKey, error: `${what}: it could not be read back (${outcomeDetail(after)})` } };
  }
  const wrong = problems(object);
  if (wrong.length > 0) {
    await run.note(journal, 'uncertain', { targetId, postState: object, detail: `${what}: post-state did not verify` });
    return { error: { naturalKey, error: `post-state: ${what} did not read back as written (${wrong.join(', ')})` } };
  }
  const id = object.id ?? targetId;
  await run.note(journal, 'succeeded', { targetId: id, postState: object });
  return { id };
}

/**
 * One write of a sign-in identifier, default cross-tenant capability or profile
 * card field: the registered writer applyWave calls (writers/entra.mjs).
 * Returns { applied }, { skipped } or { failed }.
 */
export async function applyDirectorySettingWrite(writer, resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const entry = DIRECTORY_SETTING_RECORDS[resource.resourceType];
  if (!entry) return { failed: { naturalKey, error: `${resource.resourceType} is not a directory setting KEEL writes` } };
  const run = runOf(ctx);
  const refused = entryRefusal(entry, resource, verb, run);
  if (refused?.failed) return { failed: { naturalKey, error: refused.failed } };
  if (refused?.skipped) return { skipped: { naturalKey, reason: refused.skipped } };
  if (entry.resourceType === 'profileCardProperty') return applyProfileCardWrite(writer, entry, resource, verb, run);
  return applyNamedSettingWrite(writer, entry, resource, run);
}

// ------------------------------------------- sign-in identifiers and capabilities

const IDENTIFIER_LABELS = Object.freeze({ email: 'email address', upn: 'user principal name', username: 'user name' });
const identifierLabel = (name) => IDENTIFIER_LABELS[lower(name)] ?? `custom user name (${name})`;

/** The key Graph names the object by (its name), or null. */
const settingName = (resource) => resource.live?.payload?.name ?? resource.payload.name ?? null;

async function applyNamedSettingWrite(writer, entry, resource, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  const live = resource.live.payload ?? {};
  const name = settingName(resource);
  if (typeof name !== 'string' || !name) return { failed: { naturalKey, error: `${entry.resourceType}: the backup does not hold its name, which Graph addresses it by` } };
  const identifier = entry.resourceType === 'signInIdentifier';
  const effectsOf = identifier ? signInIdentifierEffects : crossTenantCapabilityEffects;

  // Group scopes name groups by id, which are never matched in the target: a person sets them.
  if (!identifier && desired.inboundAccess !== undefined && !sameScopes(desired.inboundAccess, live.inboundAccess)) {
    return skipped(naturalKey, [step('capabilityScopes',
      `The default ${name} setting for other tenants is limited to some groups, and those differ from the backup. `
      + 'KEEL does not match groups by id into this tenant, so it left this setting as it is. '
      + `Set whether it is allowed, and for which groups, by hand from the backup (allowed: ${desired.inboundAccess?.isAllowed}).`,
      entry.portalPath, { fields: Object.freeze(['inboundAccess']) })]);
  }
  // Every change waits for its approval, before any read or write.
  if (run.mode !== 'dry-run') {
    const open = unapproved(effectsOf, resource, 'update', run.approved);
    if (open.length > 0) {
      const what = identifier ? `Sign-in with ${identifierLabel(name)}` : `The default ${name} setting for other tenants`;
      return skipped(naturalKey, [step(identifier ? 'signInApproval' : 'sharingApproval',
        `${what} is not ${identifier ? 'turned on or off' : 'changed'} yet. It applies to everyone in the tenant, so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
        entry.portalPath, { fields: Object.freeze(entry.fields) })]);
    }
  }

  const fields = entry.fields.filter((field) => desired[field] !== undefined && !sameValue(withoutAnnotations(desired[field]), withoutAnnotations(live[field])));
  const done = () => ({ applied: { naturalKey, targetId: name, changes: { fields } } });
  if (fields.length === 0 || run.mode === 'dry-run') return done();

  // The identifier's kind and name go with it, as Graph's update example sends them.
  const body = identifier
    ? { '@odata.type': desired['@odata.type'] ?? live['@odata.type'] ?? '#microsoft.graph.signInIdentifierBase', name, isEnabled: desired.isEnabled }
    : { inboundAccess: withoutAnnotations(desired.inboundAccess) };
  const path = `${entry.collection}/${encodeURIComponent(name)}`;
  // Graph documents a read of one identifier, but lists the default capabilities only as a whole.
  const listed = (read) => (read?.value ?? []).find((row) => lower(row?.name) === lower(name)) ?? null;
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation: 'update', method: 'PATCH', path, body, live, targetId: name,
    ...(identifier ? { readPath: path } : { readPath: entry.collection, pick: listed }),
    what: identifier ? `the ${name} sign-in identifier` : `the default ${name} setting`,
    problems: (read) => fields.filter((field) => !sameValue(withoutAnnotations(desired[field]), withoutAnnotations(read?.[field]))),
  });
  return result.error ? { failed: result.error } : done();
}

// ------------------------------------------------------------ profile card fields

/** A label's text per language, sorted, so Graph's order does not count as a change. */
const labels = (annotations) => (annotations ?? []).map((annotation) => ({
  displayName: annotation?.displayName ?? null,
  localizations: [...(annotation?.localizations ?? [])].map((entry) => `${lower(entry?.languageTag)}=${entry?.displayName ?? ''}`).sort(),
}));
const sameCardField = (field, desired, live) => (field === 'annotations' ? sameValue(labels(desired), labels(live)) : sameValue(desired ?? null, live ?? null));

async function applyProfileCardWrite(writer, entry, resource, verb, run) {
  const { naturalKey } = resource;
  const desired = resource.payload;
  const property = desired.directoryPropertyName;
  if (typeof property !== 'string' || !property) return { failed: { naturalKey, error: 'profileCardProperty: the backup does not name its directory field' } };
  const path = `${entry.collection}/${encodeURIComponent(property)}`;

  let live = verb === 'update' ? resource.live.payload : null;
  let operation = verb;
  // A create first reads the field: one already there (made by hand or an earlier run) is updated instead.
  if (verb === 'create') {
    const found = await run.retryOperation(() => writer.read(entry.version, path));
    if (found?.ok === true) {
      operation = 'update';
      live = found.body;
    } else if (!isNotFound(found)) {
      return { failed: { naturalKey, error: `could not read the profile card field ${property} to look for one made before (${outcomeDetail(found)})` } };
    }
  }
  const fields = entry.fields.filter((field) => desired[field] !== undefined && (operation === 'create' || !sameCardField(field, desired[field], live?.[field])));
  const done = (id) => ({ applied: { naturalKey, targetId: id, changes: { fields } } });
  if ((operation === 'update' && fields.length === 0) || run.mode === 'dry-run') return done(property);

  const body = Object.fromEntries(fields.map((field) => [field, withoutAnnotations(desired[field])]));
  if (operation === 'create') body.directoryPropertyName = property;
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation, method: operation === 'create' ? 'POST' : 'PATCH',
    path: operation === 'create' ? entry.collection : path, readPath: path, body, live, targetId: property,
    what: `the profile card field ${property}`,
    problems: (read) => fields.filter((field) => !sameCardField(field, desired[field], read?.[field])),
  });
  return result.error ? { failed: result.error } : done(property);
}
