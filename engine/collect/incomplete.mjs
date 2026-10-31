// Issue #447: a collect that saved its snapshot but could not read some types in
// full is partial, not failed. keel-collect exits with PARTIAL_EXIT_CODE and
// prints one INCOMPLETE_TYPES_PREFIX line; the worker turns that line into the
// job's result so the portal names what was not backed up.
export const PARTIAL_EXIT_CODE = 3;
export const INCOMPLETE_TYPES_PREFIX = 'incomplete types: ';

export const FULL_READ_OUTCOMES = Object.freeze(['complete', 'complete-empty']);
// Not requested (out of tier) and unavailable (no licence or feature, #309) are
// not gaps in a backup.
export const NOT_A_GAP = Object.freeze([...FULL_READ_OUTCOMES, 'not-requested', 'unavailable']);

/** Types a collect did not read in full, with outcome and HTTP status, sorted by type. */
export function incompleteTypesOf(coverageDigest) {
  return Object.entries(coverageDigest ?? {})
    .filter(([, entry]) => !NOT_A_GAP.includes(entry?.outcome))
    .map(([type, entry]) => ({ type, outcome: entry?.outcome ?? 'unknown', httpStatus: entry?.httpStatus ?? null }))
    .sort((a, b) => a.type.localeCompare(b.type));
}
