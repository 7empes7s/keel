/**
 * Wave 2 IDO: one record-driven writer for the identity object and Intune
 * types that are written through the writer registry rather than a built-in
 * applyEngine branch (engine/restore/identityObjectOperations.mjs and
 * engine/restore/intuneOperations.mjs hold the records).
 *
 * A record names everything a write needs, and nothing is inferred from the
 * snapshot payload:
 *
 *  - `version`, and `collection` (or `collectionFor(payload)` for a type whose
 *    subtypes live in different collections, `singleton` for an object that is
 *    only ever updated in place);
 *  - `operations`: the verbs the record writes; anything else is refused;
 *  - `excluded`: fields never sent (navigation properties, reports, values the
 *    service computes); `createOnly`: fields sent on create and never on update;
 *  - `odataType`: 'required' (sent and checked), 'keep' (sent when present) or
 *    'drop' (never sent);
 *  - `refusal(resource, verb, ctx)`: a type's own refusals before any call;
 *  - `preflight(io, step)`: live reads before a write; returns null, the text
 *    of a missing dependency (the write fails), or { skipped } when live
 *    already holds what the write would make (the write is skipped);
 *  - `afterWrite(io, step)`: child writes made after the object (target apps,
 *    localized messages), each verified by the record;
 *  - `deleteGuard(io, step)`: a type's own reason not to delete (a string), or
 *    null, or { prior } (fields journaled with the prior state, such as the
 *    assignments an undo removes before the delete);
 *  - `beforeDelete(io, step)`: writes made after the delete is journaled and
 *    before it is sent (an undo that removes a policy's assignments first);
 *    returns null, { changes }, or { error, outcome, changed } (the delete is
 *    not sent; `outcome` is the journal outcome, `changed` says the tenant was
 *    changed anyway);
 *  - `updateGuard(io, step)`: a type's own reason not to update, worked out
 *    from live reads; returns { reason, completion? } and the update is
 *    skipped as a manual step;
 *  - `sameField(field, desired, live)`: a type's own equality for a field
 *    Graph may return in another form (a JSON string with other spacing);
 *  - `checkedAfterWrite`: sent fields the object's own read never returns
 *    (Graph leaves them out); the record's `afterWrite` reads each one back
 *    from its own collection and fails the write when it differs;
 *  - `writeVia(io, step)` and `readVia(io, step)`: for a type Graph writes
 *    through an action on another object rather than its own collection (an
 *    app's links, through the app's updateRelationships). `writeVia` makes the
 *    create or update and returns Graph's answer (a failed answer may carry
 *    `skipped`, a plain reason the write was not possible, and nothing was
 *    written); `readVia` reads the one object back ({ ok, status, body }, 404
 *    when it is not there). A create's id comes from the read back.
 *    `writeRoute` names that route for the ledger;
 *  - `deleteVia(io, step)`: the delete of such a type, through the same route
 *    (an app's link, taken out of the links its app holds); it is verified as
 *    gone through `readVia`, and the ledger names `writeRoute` for it too;
 *  - `planChanges(io, step)`: in a dry run, the changes the record's
 *    `afterWrite` would make (an app's categories), read from live, so the plan
 *    shows a difference that is not in a field of the object;
 *  - `tenantWide`: the object is one setting for the whole tenant and cannot
 *    carry a KEEL-RT- fixture name. On the test tenant it is planned and
 *    written only with the separate tenant-wide option (`ctx.allowTenantWide`),
 *    the same gate the workload writers use (workloads/fixtureGuard.mjs). A
 *    write whose tenant is not known is refused.
 *
 * Every write is journalled first and read back; every field it sent must read
 * back as sent (nulls and absent fields read the same). A reference held in a
 * written field must resolve to the same id in the target: remapping a
 * reference to another id fails instead of being written, except for a record
 * with `remapsReferences` whose operation has a remapping proof
 * (qualification.mjs recordRemappingProof). Its references are rewritten to
 * the target's ids (an object this run recreated, or one found by its natural
 * key) through the `rewriteReferences` the wave passes in ctx.
 */
import { isDeepStrictEqual } from 'node:util';

import { SERVER_OWNED_ALWAYS } from '../cir/serverOwned.mjs';
import { remappingFor, withExplicitReferences } from '../coverage/qualification.mjs';
import { VERBATIM_RESOLUTIONS, isServerOwnedReference, resolveSymbol } from '../graph/resolver.mjs';
import { refuseUnsafeDeletion } from '../safety/deletionGuard.mjs';
import { followUpSteps } from './bestEffortRecreate.mjs';
import { TEST_TENANT_REFS, fixtureProblem } from './workloads/fixtureGuard.mjs';
import { classifyWriteOutcome, recordPriorState, recordWriteOutcome } from './rollbackJournal.mjs';

export const RECORD_WRITER_CONTRACT_VERSION = 1;

const VERBS = new Set(['create', 'update', 'delete']);
const COMPLETE = new Set(['complete', 'complete-empty']);
const isAnnotation = (key) => key.includes('@odata.') && key !== '@odata.type';
export const stripGraph = (odata) => (typeof odata === 'string' ? odata.replace(/^#?microsoft\.graph\./, '') : null);

/** A frozen record with defaults filled in. */
export function defineRecord(spec) {
  if (!spec?.resourceType) throw new TypeError('a record needs a resourceType');
  for (const verb of spec.operations ?? []) {
    if (!VERBS.has(verb)) throw new TypeError(`${spec.resourceType}: unknown operation ${verb}`);
  }
  if ((spec.checkedAfterWrite ?? []).length > 0 && typeof spec.afterWrite !== 'function') {
    throw new TypeError(`${spec.resourceType}: a field checked after the write needs an afterWrite that checks it`);
  }
  // A record read field by field reads nothing else: every read is rewritten.
  if (spec.readEach && (spec.readQuery || spec.preflight || spec.afterWrite || spec.updateGuard || spec.deleteGuard)) {
    throw new TypeError(`${spec.resourceType}: a record read field by field takes no readQuery and no read hook`);
  }
  if (Boolean(spec.writeVia) !== Boolean(spec.readVia)) {
    throw new TypeError(`${spec.resourceType}: a record written through another route reads its object back through it too (writeVia and readVia)`);
  }
  if (spec.deleteVia && !spec.writeVia) {
    throw new TypeError(`${spec.resourceType}: a record deleted through another route is written and read through it too (deleteVia needs writeVia)`);
  }
  if (spec.singleton && (spec.operations ?? []).some((verb) => verb !== 'update')) {
    throw new TypeError(`${spec.resourceType}: a singleton is only ever updated`);
  }
  return Object.freeze({
    updateMethod: 'PATCH',
    odataType: 'drop',
    excluded: [],
    createOnly: [],
    readQuery: null,
    readEach: null,
    singleton: false,
    collection: null,
    collectionFor: null,
    writable: null,
    refusal: null,
    preflight: null,
    afterWrite: null,
    deleteGuard: null,
    beforeDelete: null,
    updateGuard: null,
    transform: null,
    sameField: null,
    writeVia: null,
    readVia: null,
    writeRoute: null,
    deleteVia: null,
    planChanges: null,
    remapsReferences: false,
    tenantWide: false,
    checkedAfterWrite: [],
    ...spec,
    operations: Object.freeze([...(spec.operations ?? [])]),
    excluded: Object.freeze([...(spec.excluded ?? [])]),
    writable: spec.writable ? Object.freeze([...spec.writable]) : null,
    createOnly: Object.freeze([...(spec.createOnly ?? [])]),
    checkedAfterWrite: Object.freeze([...(spec.checkedAfterWrite ?? [])]),
  });
}

/** Every @odata annotation except @odata.type, at every depth. */
export function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (isAnnotation(key)) continue;
    out[key] = withoutAnnotations(child);
  }
  return out;
}

/** Nulls (and fields Graph leaves out) read the same as an absent field. */
export function normalised(value) {
  if (Array.isArray(value)) return value.map(normalised);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const child = normalised(value[key]);
    if (child === null || child === undefined) continue;
    out[key] = child;
  }
  return out;
}

export const sameValue = (left, right) => isDeepStrictEqual(normalised(left ?? null), normalised(right ?? null));

/** Field equality as the record means it (its own `sameField`, else sameValue). */
const sameRecordField = (record, field, left, right) => (record.sameField
  ? record.sameField(field, left, right) ?? sameValue(left, right)
  : sameValue(left, right));

/** The collection a record writes to for one payload, or null when it has none. */
export function recordCollection(record, payload) {
  return record.collectionFor ? record.collectionFor(payload) : record.collection;
}

/** The path of one object (or the singleton itself). */
export function recordObjectPath(record, payload, targetId) {
  const collection = recordCollection(record, payload);
  if (!collection) return null;
  return record.singleton ? collection : `${collection}/${encodeURIComponent(targetId)}`;
}

const withQuery = (record, path) => (record.readQuery ? `${path}?${record.readQuery}` : path);

/**
 * The body a write sends: the payload minus server-owned, excluded and
 * annotation fields; minus create-only fields on update; @odata.type per the
 * record. `transform` may adjust the result (a create's safe defaults).
 */
export function recordWriteBody(record, payload, verb) {
  const body = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (SERVER_OWNED_ALWAYS.has(key)) continue;
    if (key === '@odata.type') {
      if (record.odataType !== 'drop') body[key] = value;
      continue;
    }
    if (isAnnotation(key) || record.excluded.includes(key)) continue;
    if (record.writable && !record.writable.includes(key) && !record.createOnly.includes(key)) continue;
    if (verb !== 'create' && record.createOnly.includes(key)) continue;
    body[key] = withoutAnnotations(value);
  }
  return record.transform ? record.transform(body, { verb, payload }) : body;
}

/** The fields of the desired body whose value live does not hold. */
export function changedRecordFields(record, desired, live, verb = 'update') {
  const want = recordWriteBody(record, desired, verb);
  const have = recordWriteBody(record, live ?? {}, verb);
  return Object.keys(want).filter((key) => key !== '@odata.type' && !sameRecordField(record, key, want[key], have[key]));
}

/** null, or the post-state refusal text: every sent field reads back as sent. */
export function recordPostStateRefusal(record, sent, live) {
  if (!live || typeof live !== 'object') return 'post-state: the object could not be read back';
  if (record.odataType === 'required' && typeof sent['@odata.type'] === 'string'
    && stripGraph(live['@odata.type']) !== stripGraph(sent['@odata.type'])) {
    return `post-state: the object reads back as ${stripGraph(live['@odata.type']) ?? 'an unnamed kind'}, not ${stripGraph(sent['@odata.type'])}`;
  }
  const wrong = Object.keys(sent).filter((key) => key !== '@odata.type' && key !== 'id' && !record.checkedAfterWrite.includes(key)
    && !sameRecordField(record, key, sent[key], live[key]));
  return wrong.length > 0 ? `post-state: ${wrong.join(', ')} did not read back as written` : null;
}

/**
 * Every reference in a field this write sends must resolve to the id it
 * already holds. Returns null, or the failure text.
 */
export function referenceRefusal(resource, body, referenceContext) {
  const sent = new Set(Object.keys(body));
  for (const ref of withExplicitReferences(resource)) {
    const top = String(ref.field ?? '').split(/[.[]/)[0];
    if (!sent.has(top) || isServerOwnedReference(ref, resource.resourceType)) continue;
    const result = resolveSymbol(ref.symbol, referenceContext ?? { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() });
    if (!result.resolved) return `${resource.naturalKey}: cannot resolve reference at "${ref.field}" (symbol ${ref.symbol ?? 'null'}): ${result.reason}`;
    if (VERBATIM_RESOLUTIONS.has(result.via)) continue;
    const held = String(ref.field).split(/\.|\[|\]/).filter(Boolean)
      .reduce((value, segment) => value?.[/^\d+$/.test(segment) ? Number(segment) : segment], resource.payload);
    const id = ref.prefix && typeof held === 'string' ? held.slice(ref.prefix.length) : held;
    if (String(id ?? '').toLowerCase() !== String(result.targetId ?? '').toLowerCase()) {
      return `unqualified-remapping: ${resource.resourceType} ${ref.field} would be rewritten to a different id, and reference remapping is not proven for this type`;
    }
  }
  return null;
}

// ---------------------------------------------------------------- execution

async function journal(ctx, resource, { operation, targetId = null, priorState, intendedState }) {
  if (!ctx.rollbackClient) return { ok: true, entryId: null };
  try {
    const entryId = await recordPriorState(ctx.rollbackClient, ctx.restoreRef
      ? {
        runId: ctx.runId, naturalKey: resource.naturalKey, priorState, restoreRef: ctx.restoreRef,
        resourceType: resource.resourceType, operation, targetId, blastRadius: resource.blastRadius ?? null, intendedState,
      }
      : { runId: ctx.runId, naturalKey: resource.naturalKey, priorState });
    return { ok: true, entryId: ctx.restoreRef ? entryId : null };
  } catch {
    return { ok: false, entryId: null };
  }
}

async function note(ctx, entry, outcome, extras = {}) {
  if (!ctx.rollbackClient || !entry?.entryId) return;
  try {
    await recordWriteOutcome(ctx.rollbackClient, { entryId: entry.entryId, outcome, ...extras });
  } catch {
    // left pending: compensation reconciles it by reading
  }
}

export function outcomeDetail(result) {
  if (result?.status !== undefined && result?.status !== null) return `status ${result.status}`;
  return result?.error ? String(result.error).slice(0, 200) : 'no response';
}

export function graphFailure(naturalKey, result, prefix = '') {
  const failure = { naturalKey, error: `${prefix}${JSON.stringify(result?.body ?? result?.error ?? null)}` };
  if (result?.attempts !== undefined) {
    failure.status = result.status;
    failure.attempts = result.attempts;
  }
  return failure;
}

// Graph names the permission it wants in a 403's message, in one of these shapes.
const NAMED_SCOPES = [/following scopes:\s*([\w.]+(?:\s*,\s*[\w.]+)*)/i, /requires one of '([^']+)'/i, /required scopes\s*=\s*\[([^\]]+)\]/i];

/**
 * A failed write. A 403 whose message names the permission Graph wants starts
 * with that permission, so the run shows which grant the Restorer is missing
 * (an admin-consent step). A 403 for any other reason (an admin role, a
 * first-party object) is left as Graph's answer.
 */
export function writeFailure(record, naturalKey, result) {
  const message = result?.status === 403 ? JSON.stringify(result?.body ?? result?.error ?? '') : '';
  const named = NAMED_SCOPES.map((pattern) => message.match(pattern)?.[1]).find(Boolean)
    ?.split(',').map((scope) => scope.trim()).filter(Boolean) ?? [];
  if (named.length === 0) return graphFailure(naturalKey, result);
  const permission = named.includes(record?.permission) ? record.permission : named[0];
  const failure = graphFailure(naturalKey, result, `missing permission: the Restorer needs ${permission} (admin consent); Graph answered `);
  failure.missingPermission = permission;
  return failure;
}

export const isNotFound = (result) => result?.ok === false && result?.status === 404;

/** Calls `read` until `isStale` clears (Graph's read-after-write lag), bounded. */
async function readUntilWith(read, isStale, { attempts = 6, delayMs = 3000 } = {}) {
  let result;
  for (let i = 0; i < attempts; i += 1) {
    result = await read();
    if (!isStale(result)) return result;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return result;
}

/** Re-reads until `isStale` clears (Graph's read-after-write lag), bounded. */
export function readUntil(io, version, path, isStale, options = {}) {
  return readUntilWith(() => io.retryOperation(() => io.writer.read(version, path)), isStale, options);
}

/** One object read back: through the record's own route, or at its path. */
function readRecordObject(io, record, payload, targetId) {
  if (record.readVia) return record.readVia(io, { payload, targetId });
  return io.retryOperation(() => io.writer.read(record.version, withQuery(record, recordObjectPath(record, payload, targetId))));
}

/**
 * Why a tenant-wide record may not be planned or written here, or null.
 * `ctx.tenantRef` is the target tenant's reference; `ctx.allowTenantWide` the
 * separate tenant-wide option, off by default.
 */
export function tenantWideRecordProblem(record, ctx = {}) {
  if (!record.tenantWide) return null;
  if (typeof ctx.tenantRef !== 'string' || !ctx.tenantRef) {
    return `${record.resourceType} is a tenant-wide setting and the target tenant is not known, so it is not written`;
  }
  return fixtureProblem({
    tenantRef: ctx.tenantRef, testTenantRefs: ctx.testTenantRefs ?? TEST_TENANT_REFS,
    label: record.resourceType, tenantWide: true, allowTenantWide: ctx.allowTenantWide === true,
  });
}

const refusalEntry = (naturalKey, refusal) => (refusal.outcome === 'skipped'
  ? { skipped: { naturalKey, reason: refusal.reason, ...(refusal.completion ? { completion: refusal.completion } : {}) } }
  : { failed: { naturalKey, error: refusal.reason } });

/** The id a resource has in the target, when it exists there. */
export function liveTargetId(resource, ctx) {
  return resource.targetId ?? resource.live?.targetId ?? ctx.existingTargetIds?.get(resource.naturalKey) ?? null;
}

/**
 * A writer whose reads of a record with `readEach` read each field on its own
 * request (`$select=<field>`) and merge the answers (issue #447: Graph routes
 * a read of fields from more than one backend to one that cannot answer it).
 * The first failed read is the answer. Writes go to the writer unchanged.
 */
export function eachFieldReader(writer, fields) {
  const reader = Object.create(writer);
  reader.read = async (version, path, ...rest) => {
    const base = String(path).split('?')[0];
    const body = {};
    let last = null;
    for (const field of fields) {
      last = await writer.read(version, `${base}?$select=${field}`, ...rest);
      if (last?.ok !== true) return last;
      Object.assign(body, last.body);
    }
    return { ...last, body };
  };
  return reader;
}

/**
 * A record with `remapsReferences`: the backup's references rewritten to the
 * target's ids by the wave's `ctx.rewriteReferences` (without one, nothing is
 * rewritten and referenceRefusal still guards). A rewrite to another id needs
 * a remapping proof for exactly this operation. Returns { resource } | { error }.
 */
function remapRecordReferences(record, resource, verb, ctx) {
  if (typeof ctx.rewriteReferences !== 'function' || !resource.payload || typeof resource.payload !== 'object') return { resource };
  let payload;
  try {
    payload = ctx.rewriteReferences(resource.payload);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
  const read = (value, field) => String(field).split(/\.|\[|\]/).filter(Boolean)
    .reduce((held, segment) => held?.[/^\d+$/.test(segment) ? Number(segment) : segment], value);
  // Only a field this write sends counts: an update never sends the ends of a link.
  const sent = new Set(Object.keys(recordWriteBody(record, payload, verb)));
  const changed = withExplicitReferences(resource)
    .filter((ref) => sent.has(String(ref.field ?? '').split(/[.[]/)[0]))
    .filter((ref) => String(read(resource.payload, ref.field) ?? '').toLowerCase() !== String(read(payload, ref.field) ?? '').toLowerCase());
  if (changed.length > 0 && !remappingFor(resource.resourceType, verb).qualified) {
    return { error: `unqualified-remapping: ${resource.resourceType} ${verb} would rewrite ${changed.map((ref) => ref.field).join(', ')} to a different id, and reference remapping is not proven for this operation` };
  }
  return { resource: { ...resource, payload } };
}

/**
 * One write through a record. `ctx`: { mode, retryOperation, referenceContext,
 * rollbackClient, runId, restoreRef, existingTargetIds, deletionGuardOptions,
 * observedCoverage, readAfterWriteOptions, tenantRef, allowTenantWide }. Returns { applied } | { skipped }
 * | { failed }.
 */
export async function applyRecordWrite(writer, record, resource, verb, ctx = {}) {
  if (record.readEach && writer) writer = eachFieldReader(writer, record.readEach);
  const { naturalKey } = resource;
  const io = {
    writer,
    retryOperation: ctx.retryOperation ?? ((operation) => operation()),
    readOptions: ctx.readAfterWriteOptions ?? {},
  };
  if (!record.operations.includes(verb)) {
    return { failed: { naturalKey, error: `unsupported operation: ${resource.resourceType} ${verb} has no operation record` } };
  }
  if (record.remapsReferences && verb !== 'delete') {
    const remapped = remapRecordReferences(record, resource, verb, ctx);
    if (remapped.error) return { failed: { naturalKey, error: remapped.error } };
    resource = remapped.resource;
  }
  const payload = verb === 'delete' ? (resource.live?.payload ?? resource.payload) : resource.payload;
  if (!payload || typeof payload !== 'object') return { failed: { naturalKey, error: 'the backup holds no object to write' } };
  if (!recordCollection(record, payload)) {
    return { skipped: { naturalKey, reason: `manual: ${resource.resourceType} of kind ${stripGraph(payload['@odata.type']) ?? 'unknown'} has no write route` } };
  }
  if (record.odataType === 'required' && verb !== 'delete' && typeof payload['@odata.type'] !== 'string') {
    return { failed: { naturalKey, error: 'the backup does not record which kind of object this is (@odata.type), and Graph needs it to write one' } };
  }
  const own = record.refusal ? record.refusal(resource, verb, ctx) : null;
  if (own) return refusalEntry(naturalKey, own);

  if (verb === 'delete') return applyRecordDelete(io, record, resource, payload, ctx);

  const body = recordWriteBody(record, payload, verb);
  const references = referenceRefusal(resource, body, ctx.referenceContext);
  if (references) return { failed: { naturalKey, error: references } };

  const before = resource.live?.payload ?? null;
  let targetId = record.singleton ? null : (verb === 'update' ? liveTargetId(resource, ctx) : null);
  if (verb === 'update' && !record.singleton && !targetId) return { failed: { naturalKey, error: 'update has no targetId' } };
  const fields = verb === 'create' || !before
    ? Object.keys(body).filter((field) => field !== '@odata.type' && field !== 'id')
    : changedRecordFields(record, payload, before, verb);

  // A recreate lists the parts the backup cannot give back (ENTRA's
  // best-effort rule), worked out before anything is written.
  const followUp = verb === 'create' ? { followUp: followUpSteps(resource.resourceType, payload, { decision: 'automated' }) } : {};
  if (verb === 'create') {
    const existingId = ctx.existingTargetIds?.get(naturalKey);
    if (existingId) {
      if (ctx.mode === 'dry-run') return { applied: { naturalKey, targetId: existingId, changes: { fields } } };
      const found = await readRecordObject(io, record, payload, existingId);
      if (found?.ok !== true) {
        return { failed: { naturalKey, error: `conflict: an object with this key exists in the target but could not be read (status ${found?.status}) — manual reconciliation required` } };
      }
      if (changedRecordFields(record, payload, found.body, 'create').length === 0) return { applied: { naturalKey, targetId: existingId } };
      return { failed: { naturalKey, error: 'conflict: a different object with this key exists in the target — manual reconciliation required' } };
    }
  }
  // A tenant-wide setting with something to write passes the test tenant's
  // fixture guard first, in the dry run and again before the write.
  if (fields.length > 0 || record.afterWrite) {
    const tenantWide = tenantWideRecordProblem(record, ctx);
    if (tenantWide) return refusalEntry(naturalKey, { outcome: 'skipped', reason: tenantWide });
  }
  if (record.preflight && writer) {
    const reason = await record.preflight(io, { resource, payload, verb, targetId, ctx });
    // A preflight may also find the write already done another way: { skipped }.
    if (reason?.skipped) return refusalEntry(naturalKey, { outcome: 'skipped', reason: reason.skipped });
    if (reason) return { failed: { naturalKey, error: `dependency: ${reason}; nothing was written` } };
  }
  if (verb === 'update' && record.updateGuard && writer && fields.length > 0) {
    const held = await record.updateGuard(io, { resource, payload, targetId, before, fields, ctx });
    if (held) return refusalEntry(naturalKey, { outcome: 'skipped', ...held });
  }
  if (ctx.mode === 'dry-run') {
    const planned = record.planChanges && writer ? await record.planChanges(io, { resource, payload, verb, targetId, before, ctx }) : null;
    return { applied: { naturalKey, targetId, changes: { fields, ...(planned ?? {}) }, ...followUp } };
  }
  if (verb === 'update' && fields.length === 0 && !record.afterWrite) return { applied: { naturalKey, targetId, changes: { fields } } };

  const entry = await journal(ctx, resource, { operation: verb, targetId, priorState: before, intendedState: body });
  if (!entry.ok) return { failed: { naturalKey, error: `refusing to ${verb}: rollback journal write failed` } };

  // A failed write: Graph's answer, or the record's plain reason nothing could be written.
  const writeFailed = async (result) => {
    await note(ctx, entry, classifyWriteOutcome(result), { detail: outcomeDetail(result) });
    if (typeof result?.skipped === 'string') return refusalEntry(naturalKey, { outcome: 'skipped', reason: result.skipped });
    return { failed: writeFailure(record, naturalKey, result) };
  };

  let sent = {};
  if (verb === 'create') {
    const collection = recordCollection(record, payload);
    const result = record.writeVia
      ? await record.writeVia(io, { resource, payload, verb, body, sent: body, targetId: null, ctx })
      : await io.retryOperation(() => writer.write(record.version, collection, { method: 'POST', body }));
    if (!result?.ok) return writeFailed(result);
    targetId = result.body?.id ?? null;
    if (!record.writeVia && (typeof targetId !== 'string' || targetId.length === 0)) {
      await note(ctx, entry, 'uncertain', { postState: result.body ?? null, detail: 'create returned no id' });
      return { failed: { naturalKey, error: 'create returned no id' } };
    }
    sent = body;
  } else if (fields.length > 0) {
    sent = record.updateMethod === 'PUT' ? body
      : Object.fromEntries(Object.entries(body).filter(([field]) => field === '@odata.type' || fields.includes(field)));
    const result = record.writeVia
      ? await record.writeVia(io, { resource, payload, verb, body, sent, targetId, ctx })
      : await io.retryOperation(() => writer.write(record.version, recordObjectPath(record, payload, targetId), { method: record.updateMethod, body: sent }));
    if (!result?.ok) return writeFailed(result);
  }

  const reRead = await readUntilWith(() => readRecordObject(io, record, payload, targetId),
    (r) => isNotFound(r) || (r?.ok === true && recordPostStateRefusal(record, sent, r.body) !== null), io.readOptions);
  if (reRead?.ok !== true) {
    await note(ctx, entry, 'uncertain', { targetId, detail: `${verb} could not be re-read` });
    return { failed: graphFailure(naturalKey, reRead) };
  }
  let live = reRead.body;
  // A create written through another route has its id only once it reads back.
  if (record.writeVia && !targetId) targetId = typeof live?.id === 'string' && live.id.length > 0 ? live.id : null;
  if (record.writeVia && !targetId) {
    await note(ctx, entry, 'uncertain', { postState: live, detail: 'create read back with no id' });
    return { failed: { naturalKey, error: 'create read back with no id' } };
  }
  const postState = recordPostStateRefusal(record, sent, live);
  if (postState) {
    await note(ctx, entry, 'uncertain', { targetId, postState: live, detail: 'post-state did not verify' });
    return { failed: { naturalKey, error: postState } };
  }

  let extra = null;
  if (record.afterWrite) {
    extra = await record.afterWrite(io, { resource, payload, verb, targetId, live, before, ctx });
    if (extra?.error) {
      await note(ctx, entry, 'uncertain', { targetId, postState: live, detail: extra.error.slice(0, 500) });
      return { failed: { naturalKey, error: `${verb === 'create' ? 'the object was created, but ' : ''}${extra.error}` } };
    }
    if (extra?.live) live = extra.live;
  }

  await note(ctx, entry, 'succeeded', { targetId, postState: live });
  const changes = { fields, ...(extra?.changes ?? {}) };
  return {
    applied: {
      naturalKey, targetId,
      changes,
      ...(extra?.completion?.length ? { completion: extra.completion } : {}),
      ...followUp,
    },
  };
}

/**
 * An undo of a create (compensation.mjs): the delete of an object this restore
 * created, named by the journal entries it undoes. Its authority is that
 * journal and the fresh read the plan compared, not the snapshot's absence.
 */
export const undoesCreate = (resource) => resource.undoes === 'create'
  && Array.isArray(resource.compensates) && resource.compensates.length > 0;

/**
 * A delete: the shared deletion guard, a complete observation of the type in
 * the source snapshot (or, for an undo of a create, the journal), the record's
 * own guard, then DELETE (or the record's `deleteVia`) and a read that shows
 * the object gone (absent or soft-deleted).
 */
async function applyRecordDelete(io, record, resource, payload, ctx) {
  const { naturalKey } = resource;
  const guard = refuseUnsafeDeletion({ ...resource, payload }, ctx.deletionGuardOptions ?? { breakGlassUserIds: [] });
  if (guard.refused) return { skipped: { naturalKey, reason: guard.reason } };
  const coverage = ctx.observedCoverage?.[resource.resourceType]?.outcome ?? null;
  if (!COMPLETE.has(coverage) && !undoesCreate(resource)) {
    return { failed: { naturalKey, error: `partial observation cannot authorise delete: the snapshot's ${resource.resourceType} collection is ${coverage ?? 'not recorded'}, so its absence there is not evidence` } };
  }
  const targetId = liveTargetId(resource, ctx);
  if (!targetId) return { failed: { naturalKey, error: 'delete has no targetId' } };
  const path = recordObjectPath(record, payload, targetId);
  let prior = null;
  if (record.deleteGuard && io.writer) {
    const reason = await record.deleteGuard(io, { resource, payload, targetId, path, ctx });
    if (typeof reason === 'string' && reason) return { skipped: { naturalKey, reason } };
    prior = reason?.prior ?? null;
  }
  if (ctx.mode === 'dry-run') return { applied: { naturalKey, targetId } };

  const entry = await journal(ctx, resource, { operation: 'delete', targetId, priorState: prior ? { ...payload, ...prior } : payload, intendedState: null });
  if (!entry.ok) return { failed: { naturalKey, error: 'refusing to delete: rollback journal write failed' } };
  const before = record.beforeDelete ? await record.beforeDelete(io, { resource, payload, targetId, path, ctx }) : null;
  if (before?.error) {
    await note(ctx, entry, before.outcome ?? 'failed', { detail: before.error });
    return { failed: { naturalKey, error: before.error } };
  }
  const changes = before?.changes ?? null;
  // Assignments taken off before a delete that then fails: the tenant changed.
  const removedFirst = changes?.assignmentsRemoved
    ? ` (its ${changes.assignmentsRemoved} assignment(s) were already removed, and the policy was not deleted)` : '';
  const result = record.deleteVia
    ? await record.deleteVia(io, { resource, payload, targetId, ctx })
    : await io.retryOperation(() => io.writer.write(record.version, path, { method: 'DELETE', body: {} }));
  if (!result?.ok) {
    await note(ctx, entry, removedFirst ? 'uncertain' : classifyWriteOutcome(result), { detail: `${outcomeDetail(result)}${removedFirst}` });
    if (typeof result?.skipped === 'string') return refusalEntry(naturalKey, { outcome: 'skipped', reason: `${result.skipped}${removedFirst}` });
    const failure = writeFailure(record, naturalKey, result);
    return { failed: removedFirst ? { ...failure, error: `${failure.error}${removedFirst}` } : failure };
  }
  const gone = (r) => r?.ok === true && r.body?.deletedDateTime == null;
  const reRead = record.readVia
    ? await readUntilWith(() => record.readVia(io, { payload, targetId }), gone, io.readOptions)
    : await readUntil(io, record.version, path, gone, io.readOptions);
  if (!isNotFound(reRead) && reRead?.body?.deletedDateTime == null) {
    await note(ctx, entry, 'uncertain', { postState: reRead?.body ?? null, detail: 'delete did not verify' });
    return { failed: { naturalKey, error: 'delete did not verify as absent or soft-deleted' } };
  }
  const removed = changes?.assignmentsRemoved ? `; its ${changes.assignmentsRemoved} assignment(s) were removed first` : '';
  await note(ctx, entry, 'succeeded', { detail: `${isNotFound(reRead) ? 'absent' : 'soft-deleted'}${removed}` });
  return { applied: { naturalKey, targetId, ...(changes ? { changes } : {}) } };
}

/** The ledger rows of a set of records: what each writes, where and with which permission. */
export function recordLedger(records) {
  return Object.freeze(records.flatMap((record) => record.operations.map((operation) => Object.freeze({
    resourceType: record.resourceType,
    operation,
    version: record.version,
    method: operation === 'create' || (record.writeRoute && (operation !== 'delete' || record.deleteVia)) ? 'POST' : operation === 'delete' ? 'DELETE' : record.updateMethod,
    route: record.writeRoute && (operation !== 'delete' || record.deleteVia) ? record.writeRoute
      : record.singleton ? record.collection
      : operation === 'create' ? (record.collection ?? '{subtype collection}') : `${record.collection ?? '{subtype collection}'}/{id}`,
    permission: record.permission ?? null,
  }))));
}
