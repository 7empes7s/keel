/**
 * Writers for resource types applyEngine.mjs has no built-in writer for (Wave 2 seam).
 *
 * Packages add writers in their own fragment file here (entra.mjs, ido.mjs), never in
 * applyEngine.mjs. An entry is
 *
 *   { resourceType, handler: 'engine/restore/<file>.mjs#<fn>', apply }
 *
 * and applyWave calls apply(writer, resource, verb, ctx) for that type, after every
 * shared gate has passed: the capability registry (a writer alone never makes a type
 * writable), the policy, tenant-policy, Intune, admin-role and recovery refusals, the
 * relationship-via-parent check, the deletion guard for a delete and the synced-object
 * guard otherwise. `verb` is create, update, delete or restore-soft-deleted. ctx holds
 *
 *   mode, targetTenant, targetId, existingTargetIds, referenceContext, retryOperation,
 *   rollbackClient, runId, restoreRef, now, approvedContentEffects, readAfterWriteOptions,
 *   journalBeforeMutation(fields) -> { ok, entryId }, noteOutcome(journal, outcome, extras),
 *   rewriteReferences(payload) -> payload (throws UnresolvedReferenceError)
 *
 * apply resolves to { applied?, skipped?, failed?, notRemediable? }, the same entries
 * applyWave reports: applied { naturalKey, targetId }, skipped { naturalKey, reason },
 * failed { naturalKey, error }. A writer journals before it mutates, writes nothing in
 * dry-run mode and reads back what it wrote.
 */
import entraWriters from './entra.mjs';
import idoWriters from './ido.mjs';

const WRITERS = new Map();

export function registerWriter({ resourceType, handler, apply }) {
  if (typeof resourceType !== 'string' || resourceType.length === 0) throw new TypeError('a writer needs a resourceType');
  if (typeof handler !== 'string' || !/^engine\/.+\.mjs#\w+$/.test(handler)) {
    throw new TypeError(`${resourceType}: a writer needs a handler reference like engine/restore/file.mjs#fn`);
  }
  if (typeof apply !== 'function') throw new TypeError(`${resourceType}: a writer needs an apply function`);
  if (WRITERS.has(resourceType)) throw new Error(`${resourceType}: a writer is already registered (${WRITERS.get(resourceType).handler})`);
  WRITERS.set(resourceType, Object.freeze({ resourceType, handler, apply }));
}

/** The registered writer for a type, or null. */
export function writerFor(resourceType) {
  return WRITERS.get(resourceType) ?? null;
}

export function registeredWriterTypes() {
  return [...WRITERS.keys()].sort();
}

export const WRITER_FRAGMENTS = Object.freeze({ entra: entraWriters, ido: idoWriters });

for (const entries of Object.values(WRITER_FRAGMENTS)) {
  for (const entry of entries) registerWriter(entry);
}
