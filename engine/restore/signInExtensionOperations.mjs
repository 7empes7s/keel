/**
 * Issue #1072: restore of custom authentication extensions and the
 * authentication event listeners that call them.
 *
 * 1. Custom authentication extensions (customAuthenticationExtension). An
 *    extension is an API that Entra calls during sign-in (token issuance,
 *    attribute collection, one-time code sending). What makes it work is where
 *    it calls (endpointConfiguration), how Entra signs in to it
 *    (authenticationConfiguration, the app ID URI it trusts) and how long
 *    sign-in waits on it (clientConfiguration), and what sign-in does when it fails
 *    (behaviorOnError): those are never written (CLAUDE.md
 *    restore-writer rule, TRUST_FIELDS), and a difference in them is a step for a
 *    person (trustFieldStep). Graph creates an extension only with its endpoint
 *    and its sign-in, so KEEL never creates one: a backed-up extension that is
 *    missing live is matched by display name and kind, and the one match gets an
 *    update of the safe fields: displayName, description and, for token issuance,
 *    claimsForTokenConfiguration (which claims of the API's answer go into the
 *    token). With no match, the restore is a step that names the endpoint to set
 *    up. A change to the token claims is a 'changes-sign-in' effect held behind
 *    the restore approval (safety/signInSettingEffects.mjs); the name and
 *    description are written without one.
 *
 * 2. Authentication event listeners (authenticationEventListener). A listener
 *    says which apps' sign-ins call which extension, and in which order. Create
 *    and update write its kind, priority, display name, conditions (the apps,
 *    by app id) and handler, which names only the live extension with the
 *    backup's extension name: { @odata.type, customExtension: { id } }. The
 *    handler's own client settings (configuration) and the extension's endpoint,
 *    which the list read expands into the backup, are never sent. A listener
 *    whose extension is missing live is held with a step: recreate the extension
 *    first. A listener that calls no extension (an External ID user flow's own
 *    listener) is a step too. Every change is a 'changes-sign-in' effect, judged
 *    on create too, and is written only once approved; the gate runs before any
 *    read.
 *
 * Delete is not registered for either. Routes and fields follow the Graph v1.0
 * reference (customauthenticationextension-update, identitycontainer-post-
 * authenticationeventlisteners, authenticationeventlistener-update); they are
 * fixture-tested and confirmed by each type's live capture.
 */
import { capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { effectApproved } from '../safety/contentEffects.mjs';
import {
  authenticationEventListenerEffects, customAuthenticationExtensionEffects, listenerApps, listenerExtensionName, tokenClaimIds,
} from '../safety/signInSettingEffects.mjs';
import { outcomeDetail, sameValue, trustFieldStep, withoutAnnotations } from './recordWriter.mjs';
import { classifyWriteOutcome } from './rollbackJournal.mjs';
import { readAllPages } from './approvalHeld.mjs';
import { isTrustField } from './workloads/writeDeclarations.mjs';

const DOCS = 'https://learn.microsoft.com/en-us/graph/api';
const EXTENSIONS = '/identity/customAuthenticationExtensions';
const LISTENERS = '/identity/authenticationEventListeners';

const record = (fields) => {
  // CLAUDE.md restore-writer rule: a record never lists a trust, certificate or sign-in field.
  const trust = fields.fields.filter((field) => isTrustField(fields.resourceType, field));
  if (trust.length) throw new Error(`${fields.resourceType} declares trust, certificate or sign-in fields a restore never writes: ${trust.join(', ')}`);
  return Object.freeze(fields);
};

export const SIGN_IN_EXTENSION_RECORDS = Object.freeze({
  customAuthenticationExtension: record({
    resourceType: 'customAuthenticationExtension',
    collection: EXTENSIONS,
    version: 'v1.0',
    permission: 'CustomAuthenticationExtension.ReadWrite.All',
    docs: `${DOCS}/customauthenticationextension-update?view=graph-rest-1.0`,
    operations: Object.freeze(['create', 'update']),
    // A create never POSTs: it updates the live extension with the backup's name.
    fields: Object.freeze(['displayName', 'description', 'claimsForTokenConfiguration']),
    portalPath: 'Entra admin center > Identity > External Identities > Custom authentication extensions',
  }),
  authenticationEventListener: record({
    resourceType: 'authenticationEventListener',
    collection: LISTENERS,
    version: 'v1.0',
    permission: 'EventListener.ReadWrite.All',
    docs: `${DOCS}/identitycontainer-post-authenticationeventlisteners?view=graph-rest-1.0`,
    operations: Object.freeze(['create', 'update']),
    fields: Object.freeze(['displayName', 'priority', 'conditions', 'handler']),
    portalPath: 'Entra admin center > Enterprise applications > the app > Single sign-on > Attributes & Claims',
  }),
});

const present = (resource) => resource?.live?.state === 'present' || resource?.live?.state === 'soft-deleted';
const lower = (value) => String(value ?? '').toLowerCase();
const isNotFound = (result) => result?.ok === false && result?.status === 404;
const kindOf = (odataType) => String(odataType ?? '').replace(/^#?microsoft\.graph\./, '');
const sameKind = (left, right) => lower(kindOf(left)) === lower(kindOf(right));

const APPROVE_STEP = 'Run the restore as a dry run, have someone other than you approve "Changes sign-in" in Approvals, then run it again. '
  + 'If restore approvals are turned off for Entra ID, running the reviewed dry run again writes it.';

const step = (requirement, description, portalPath, extra = {}) => Object.freeze({ kind: 'manual-setting', requirement, portalPath, description, ...extra });
const skipped = (naturalKey, completion) => ({ skipped: { naturalKey, reason: `manual: ${completion[0].description}`, completion } });

/** The 'changes-sign-in' effects of this write the promotion did not approve. */
function unapproved(effectsOf, resource, verb, approvedContentEffects) {
  return effectsOf({ ...resource, verb })
    .map((effect) => ({ naturalKey: resource.naturalKey, resourceType: resource.resourceType, ...effect }))
    .filter((effect) => !effectApproved(effect, approvedContentEffects));
}

const io = (ctx) => ({
  mode: ctx.mode ?? 'enforce',
  retryOperation: ctx.retryOperation ?? ((operation) => operation()),
  journal: ctx.journalBeforeMutation ?? (async () => ({ ok: true, entryId: null })),
  note: ctx.noteOutcome ?? (async () => {}),
  readBack: ctx.readAfterWrite ?? null,
  approved: ctx.approvedContentEffects ?? [],
});

/** Refuses a write before any Graph call, or returns null. */
function refusal(entry, resource, verb) {
  if (!entry.operations.includes(verb)) return `${entry.resourceType} ${verb} is not written by KEEL`;
  const capability = capabilityFor(entry.resourceType, verb);
  if (!isSupportedClaim(capability.claim)) return `${entry.resourceType} ${verb} is not a registered write capability (claim: ${capability.claim})`;
  const payload = resource.payload;
  if (!payload || typeof payload !== 'object') return `${entry.resourceType}: the backup holds nothing to restore`;
  if (typeof payload['@odata.type'] !== 'string') return `${entry.resourceType}: the backup does not say which kind it is (@odata.type), which every write must name`;
  if (verb === 'update' && !present(resource)) return `dependency: no live ${entry.resourceType} was observed, so the update cannot be checked against it`;
  return null;
}

/**
 * One write of an extension or listener: the registered writer applyWave calls
 * (writers/entra.mjs) with the registry's ctx (writers/registry.mjs). Returns
 * { applied } (with `changes` and `completion`), { skipped } or { failed }.
 */
export async function applySignInExtensionWrite(writer, resource, verb, ctx = {}) {
  const { naturalKey } = resource;
  const entry = SIGN_IN_EXTENSION_RECORDS[resource.resourceType];
  if (!entry) return { failed: { naturalKey, error: `${resource.resourceType} is not a sign-in extension KEEL writes` } };
  const refused = refusal(entry, resource, verb);
  if (refused) return { failed: { naturalKey, error: refused } };
  return entry.resourceType === 'customAuthenticationExtension'
    ? applyExtensionWrite(writer, entry, resource, verb, ctx)
    : applyListenerWrite(writer, entry, resource, verb, ctx);
}

/** Every live extension: { value } or { error }. */
const listExtensions = (writer, run) => readAllPages({ writer, retryOperation: run.retryOperation }, 'v1.0', EXTENSIONS);

/** The one live extension of this name (and kind, when given): { found }, { missing } or { error }. */
async function findExtension(writer, run, name, kind = null) {
  const listed = await listExtensions(writer, run);
  if (listed.error) return { error: `could not list the custom authentication extensions to find "${name}" (${listed.error})` };
  const named = listed.value.filter((row) => lower(row?.displayName) === lower(name) && (!kind || sameKind(row?.['@odata.type'], kind)));
  if (named.length > 1) return { error: `${named.length} custom authentication extensions are named "${name}", so KEEL cannot tell which one to use` };
  return named.length === 1 ? { found: named[0] } : { missing: true };
}

/** The journal, write, read back and check every write here shares. */
async function writeAndVerify(writer, run, { naturalKey, version, operation, path, collection, body, live, targetId, problems, what }) {
  const journal = await run.journal({ operation, targetId, priorState: live, intendedState: { ...(live ?? {}), ...body } });
  if (!journal.ok) return { error: { naturalKey, error: `refusing to ${operation}: rollback journal write failed` } };
  const written = await run.retryOperation(() => writer.write(version, operation === 'create' ? collection : path, { method: operation === 'create' ? 'POST' : 'PATCH', body }));
  if (!written?.ok) {
    await run.note(journal, classifyWriteOutcome(written), { ...(targetId ? { targetId } : {}), detail: outcomeDetail(written) });
    return { error: { naturalKey, error: `${what} failed: ${JSON.stringify(written?.body ?? written?.error ?? null)}`, ...(written?.status !== undefined ? { status: written.status } : {}) } };
  }
  const id = operation === 'create' ? written.body?.id : targetId;
  if (!id) {
    await run.note(journal, 'uncertain', { detail: 'create returned no id' });
    return { error: { naturalKey, error: `${what} returned no id` } };
  }
  const objectPath = `${collection}/${encodeURIComponent(id)}`;
  const after = run.readBack
    ? await run.readBack(version, objectPath, (read) => isNotFound(read) || (read?.ok === true && problems(read.body).length > 0))
    : await run.retryOperation(() => writer.read(version, objectPath));
  if (after?.ok !== true) {
    await run.note(journal, 'uncertain', { targetId: id, detail: `${operation} could not be re-read` });
    return { error: { naturalKey, error: `${what}: it could not be read back (${outcomeDetail(after)})` } };
  }
  const wrong = problems(after.body);
  if (wrong.length > 0) {
    await run.note(journal, 'uncertain', { targetId: id, postState: after.body, detail: `${what}: post-state did not verify` });
    return { error: { naturalKey, error: `post-state: ${what} did not read back as written (${wrong.join(', ')})` } };
  }
  await run.note(journal, 'succeeded', { targetId: id, postState: after.body });
  return { id };
}

// ------------------------------------------------- custom authentication extensions

const extensionSame = (field, desired, live) => (field === 'claimsForTokenConfiguration'
  ? sameValue(tokenClaimIds({ claimsForTokenConfiguration: desired }), tokenClaimIds({ claimsForTokenConfiguration: live }))
  : sameValue(desired ?? null, live ?? null));

/** The step for an extension missing live: it names the endpoint and app ID URI to set up. */
function recreateExtensionStep(entry, payload) {
  const target = payload?.endpointConfiguration?.targetUrl;
  const resourceId = payload?.authenticationConfiguration?.resourceId;
  const where = target ? ` that calls ${target}` : '';
  const signIn = resourceId ? `, signing in to it with app ID URI ${resourceId}` : '';
  return step('recreateExtension',
    `The custom authentication extension "${payload?.displayName ?? 'unnamed'}" (${kindOf(payload?.['@odata.type'])}) is not in this tenant. `
    + 'KEEL never writes an extension\'s endpoint or how Entra signs in to it, so it never creates one. '
    + `Create it by hand in the ${entry.portalPath}${where}${signIn}, check that the endpoint answers, then run the restore again: `
    + 'it puts back the description and token claims, and the listeners that call it.',
    entry.portalPath);
}

async function applyExtensionWrite(writer, entry, resource, verb, ctx) {
  const run = io(ctx);
  const { naturalKey } = resource;
  const desired = resource.payload;
  const kind = desired['@odata.type'];

  // A change to the token claims waits for its approval, before any read.
  if (run.mode !== 'dry-run') {
    const open = unapproved(customAuthenticationExtensionEffects, resource, verb, run.approved);
    if (open.length > 0) {
      return skipped(naturalKey, [step('signInApproval',
        `The custom authentication extension "${desired.displayName}" is not ${verb === 'create' ? 'put back' : 'updated'} yet. This changes which claims it adds to tokens, so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
        entry.portalPath, { fields: Object.freeze(['claimsForTokenConfiguration']) })]);
    }
  }

  let targetId = verb === 'update' ? (resource.live.targetId ?? resource.live.payload?.id ?? resource.targetId ?? null) : null;
  let live = verb === 'update' ? resource.live.payload : null;
  if (verb === 'create') {
    const match = await findExtension(writer, run, desired.displayName, kind);
    if (match.error) return { failed: { naturalKey, error: match.error } };
    if (match.missing) return skipped(naturalKey, [recreateExtensionStep(entry, desired)]);
    targetId = match.found.id;
    live = match.found;
  }
  if (!targetId) return { failed: { naturalKey, error: 'customAuthenticationExtension update has no target id' } };
  if (!sameKind(live?.['@odata.type'] ?? kind, kind)) {
    return { failed: { naturalKey, error: `the live extension is a ${kindOf(live['@odata.type'])}, not the backup's ${kindOf(kind)}; a restore never changes an extension's kind` } };
  }

  const fields = entry.fields.filter((field) => desired[field] !== undefined && !extensionSame(field, desired[field], live?.[field]));
  const trust = trustFieldStep(entry.resourceType, desired, live, 'update');
  const completion = trust ? [trust] : [];
  const done = () => ({ applied: { naturalKey, targetId, changes: { fields }, ...(completion.length > 0 ? { completion } : {}) } });
  if (fields.length === 0 || run.mode === 'dry-run') return done();

  const body = { '@odata.type': kind, ...Object.fromEntries(fields.map((field) => [field, withoutAnnotations(desired[field])])) };
  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation: 'update', collection: entry.collection, path: `${entry.collection}/${encodeURIComponent(targetId)}`,
    body, live, targetId, what: `custom authentication extension "${desired.displayName}"`,
    problems: (read) => fields.filter((field) => !extensionSame(field, desired[field], read?.[field])),
  });
  return result.error ? { failed: result.error } : done();
}

// ------------------------------------------------------ authentication event listeners

const sameApps = (desired, live) => sameValue(listenerApps(desired), listenerApps(live));
const handlerExtensionId = (payload) => payload?.handler?.customExtension?.id ?? null;

/** Field equality for a listener; the handler is judged by its kind and the live extension it names. */
const listenerSame = (field, body, live) => {
  if (field === 'conditions') return sameApps(body, live);
  if (field === 'handler') return sameKind(body.handler?.['@odata.type'], live?.handler?.['@odata.type']) && lower(handlerExtensionId(body)) === lower(handlerExtensionId(live));
  return sameValue(body[field] ?? null, live?.[field] ?? null);
};

async function applyListenerWrite(writer, entry, resource, verb, ctx) {
  const run = io(ctx);
  const { naturalKey } = resource;
  const desired = resource.payload;
  const kind = desired['@odata.type'];

  // Only a listener that calls a custom authentication extension is written.
  if (!desired.handler?.customExtension) {
    return skipped(naturalKey, [step('userFlowListener',
      `This listener (${kindOf(kind)}) does not call a custom authentication extension; it belongs to an External ID user flow, and KEEL restores only listeners that call an extension. Set it up again with the user flow, from the backup.`,
      entry.portalPath)]);
  }

  // Every change waits for its approval, before any read.
  if (run.mode !== 'dry-run') {
    const open = unapproved(authenticationEventListenerEffects, resource, verb, run.approved);
    if (open.length > 0) {
      const fields = [...new Set(open.map((effect) => effect.field))];
      return skipped(naturalKey, [step('signInApproval',
        `The listener that calls "${listenerExtensionName(desired) ?? 'its extension'}" is not ${verb === 'create' ? 'recreated' : 'updated'} yet. This changes how people sign in to its apps (${fields.join(', ')}), so it is written only once the restore's dry run is approved. ${APPROVE_STEP}`,
        entry.portalPath, { fields: Object.freeze(fields) })]);
    }
  }

  // The live extension with the backup's extension name.
  const name = listenerExtensionName(desired);
  const extensionFirst = (why) => skipped(naturalKey, [step('extensionFirst',
    `Recreate the custom authentication extension ${name ? `"${name}"` : 'this listener calls'} first: ${why}. Then run the restore again, and it recreates the listener for the same apps.`,
    SIGN_IN_EXTENSION_RECORDS.customAuthenticationExtension.portalPath)]);
  if (!name) return extensionFirst('the backup does not name the extension, so KEEL cannot find it in this tenant');
  const extension = await findExtension(writer, run, name);
  if (extension.error) return { failed: { naturalKey, error: extension.error } };
  if (extension.missing) return extensionFirst('it is not in this tenant, and a listener without it would fail every sign-in to its apps');

  const body = { '@odata.type': kind };
  if (desired.displayName !== undefined) body.displayName = desired.displayName;
  if (desired.priority !== undefined) body.priority = desired.priority;
  if (desired.conditions !== undefined) body.conditions = withoutAnnotations(desired.conditions);
  // Only the handler's kind and the live extension's id: never its client settings or the extension's endpoint.
  body.handler = { '@odata.type': desired.handler['@odata.type'], customExtension: { id: extension.found.id } };

  let targetId = verb === 'update' ? (resource.live.targetId ?? resource.live.payload?.id ?? resource.targetId ?? null) : null;
  let live = verb === 'update' ? resource.live.payload : null;
  let operation = verb;
  // A create first looks for the listener a previous run (or a person) made: the same kind calling the same extension.
  if (verb === 'create') {
    const listed = await readAllPages({ writer, retryOperation: run.retryOperation }, entry.version, entry.collection);
    if (listed.error) return { failed: { naturalKey, error: `could not list the authentication event listeners to look for one made before (${listed.error})` } };
    const twins = listed.value.filter((row) => sameKind(row?.['@odata.type'], kind) && lower(handlerExtensionId(row)) === lower(extension.found.id));
    if (twins.length > 1) return { failed: { naturalKey, error: `${twins.length} listeners already call "${name}", so KEEL cannot tell which one to keep` } };
    if (twins.length === 1) {
      operation = 'update';
      targetId = twins[0].id;
      live = twins[0];
    }
  }
  if (operation === 'update' && !targetId) return { failed: { naturalKey, error: 'authenticationEventListener update has no target id' } };
  if (operation === 'update' && !sameKind(live?.['@odata.type'] ?? kind, kind)) {
    return { failed: { naturalKey, error: `the live listener is a ${kindOf(live['@odata.type'])}, not the backup's ${kindOf(kind)}; a restore never changes a listener's kind` } };
  }

  const fields = entry.fields.filter((field) => body[field] !== undefined && (operation === 'create' || !listenerSame(field, body, live)));
  const sent = operation === 'create' ? body : { '@odata.type': kind, ...Object.fromEntries(fields.map((field) => [field, body[field]])) };
  const done = (id) => ({ applied: { naturalKey, targetId: id, changes: { fields, extension: name } } });
  if (fields.length === 0 || run.mode === 'dry-run') return done(targetId);

  const result = await writeAndVerify(writer, run, {
    naturalKey, version: entry.version, operation, collection: entry.collection, path: `${entry.collection}/${encodeURIComponent(targetId)}`,
    body: sent, live, targetId, what: `the listener that calls "${name}"`,
    problems: (read) => fields.filter((field) => !listenerSame(field, body, read)),
  });
  return result.error ? { failed: result.error } : done(result.id);
}
