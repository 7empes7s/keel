/**
 * Writers for (resource type, verb) pairs applyEngine.mjs has no built-in writer for
 * (Wave 2 seam). Packages add writers in their own fragment file here (entra.mjs,
 * ido.mjs), never in applyEngine.mjs. An entry is
 *
 *   { resourceType, verbs: ['create', ...], handler: 'engine/restore/<file>.mjs#<fn>', apply }
 *
 * Each (resourceType, verb) also needs a capability registration (capabilities.d/)
 * whose handler is the same string: a writer alone never makes a pair writable, and a
 * pair registered for applyWave's own handler keeps its built-in writer.
 *
 * applyWave calls apply(writer, resource, verb, ctx) for a registered pair before its
 * built-in branches (Intune, tenant policy, admin role, user, generic), after the shared
 * gates: administrative, capability, policy, tenant-policy, Intune, admin-role and
 * recovery refusals, the relationship-via-parent check, then the deletion guard for a
 * delete and the synced-object guard otherwise. `verb` is create, update, delete or
 * restore-soft-deleted. ctx holds
 *
 *   mode, targetTenant, targetId, existingTargetIds, referenceContext, retryOperation,
 *   rollbackClient, runId, restoreRef, now, approvedContentEffects, readAfterWriteOptions,
 *   deletionGuardOptions, observedCoverage,
 *   journalBeforeMutation(fields) -> { ok, entryId }, noteOutcome(journal, outcome, extras),
 *   rewriteReferences(payload) -> payload (throws UnresolvedReferenceError),
 *   graphFailure(naturalKey, result) -> failed entry,
 *   readAfterWrite(version, path, isStale) -> the read-back (retried while isStale)
 *
 * apply resolves to { applied?, skipped?, failed?, notRemediable? }, the same entries
 * applyWave reports: applied { naturalKey, targetId }, skipped { naturalKey, reason },
 * failed { naturalKey, error }. A writer journals before it mutates, writes nothing in
 * dry-run mode and reads back what it wrote.
 */
import entraWriters from './entra.mjs';
import idoWriters from './ido.mjs';

const WRITERS = new Map();

const VERBS = ['create', 'update', 'delete', 'restore-soft-deleted'];
const key = (resourceType, verb) => `${resourceType}|${verb}`;

export function registerWriter({ resourceType, verbs, handler, apply }) {
  if (typeof resourceType !== 'string' || resourceType.length === 0) throw new TypeError('a writer needs a resourceType');
  if (!Array.isArray(verbs) || verbs.length === 0 || verbs.some((verb) => !VERBS.includes(verb))) {
    throw new TypeError(`${resourceType}: a writer names its verbs, each one of ${VERBS.join(', ')}`);
  }
  if (typeof handler !== 'string' || !/^engine\/.+\.mjs#\w+$/.test(handler)) {
    throw new TypeError(`${resourceType}: a writer needs a handler reference like engine/restore/file.mjs#fn`);
  }
  if (typeof apply !== 'function') throw new TypeError(`${resourceType}: a writer needs an apply function`);
  for (const verb of verbs) {
    if (WRITERS.has(key(resourceType, verb))) {
      throw new Error(`${resourceType} ${verb}: a writer is already registered (${WRITERS.get(key(resourceType, verb)).handler})`);
    }
  }
  const entry = Object.freeze({ resourceType, verbs: Object.freeze([...verbs]), handler, apply });
  for (const verb of verbs) WRITERS.set(key(resourceType, verb), entry);
}

/** The registered writer for a (type, verb) pair, or null. */
export function writerFor(resourceType, verb) {
  return WRITERS.get(key(resourceType, verb)) ?? null;
}

/** Every registered pair as 'resourceType|verb', sorted. */
export function registeredWriterKeys() {
  return [...WRITERS.keys()].sort();
}

export const WRITER_FRAGMENTS = Object.freeze({ entra: entraWriters, ido: idoWriters });

for (const entries of Object.values(WRITER_FRAGMENTS)) {
  for (const entry of entries) registerWriter(entry);
}
