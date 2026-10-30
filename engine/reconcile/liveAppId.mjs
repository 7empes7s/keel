/** Issue #726: Entra gives a recreated app a new appId, and its service
 * principal carries that one too. An earlier restore that recreated them leaves
 * the backup's appId in the backup only, and it can never be written back. So
 * each occurrence of the backup's appId (the appId itself, a principal's
 * servicePrincipalNames, an `api://<appId>` URI) is read as the live object's
 * appId: when the backup is compared with live, and in the body an update
 * writes, so a later update never puts the old appId back. */
const APP_ID_TYPES = new Set(['application', 'servicePrincipal']);

function replaceInStrings(value, pattern, to) {
  if (typeof value === 'string') return value.replace(pattern, to);
  if (Array.isArray(value)) return value.map((item) => replaceInStrings(item, pattern, to));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceInStrings(item, pattern, to)]));
  }
  return value;
}

/** `payload` with the backup's appId replaced by the live one. `current` is the
 * live object it is matched to ({ state, payload }). Unchanged when the type has
 * no appId, the live object is absent, or both appIds are the same. */
export function withLiveAppId(payload, resourceType, current) {
  if (!APP_ID_TYPES.has(resourceType) || current?.state !== 'present') return payload;
  return withAppId(payload, payload?.appId, current.payload?.appId);
}

/** `value` with every occurrence of the appId `from` (in any case) replaced by
 * `to`. Unchanged when either is missing or both are the same. */
export function withAppId(value, from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || from.length === 0 || to.length === 0) return value;
  if (from.toLowerCase() === to.toLowerCase()) return value;
  // A GUID may be written in any case, so the match ignores case.
  const pattern = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return replaceInStrings(value, pattern, () => to);
}

/** A soft-deleted app an earlier restore recreated comes back with the appId
 * Entra gave it, so its restore writes that appId, never the backup's. */
export function withDeletedAppId(payload, resourceType, current) {
  if (resourceType !== 'application' || current?.state !== 'soft-deleted') return payload;
  return withAppId(payload, payload?.appId, current.payload?.appId);
}

/** An application's create body split in two. Entra assigns the appId at
 * create, so an identifierUris entry naming the backup's appId
 * (`api://<old appId>`) is left out of the create (Graph refuses it or keeps
 * a URI naming another app), and written with the new appId right after. */
export function holdOwnAppIdUris(body, resourceType, backupAppId) {
  const uris = body?.identifierUris;
  if (resourceType !== 'application' || typeof backupAppId !== 'string' || backupAppId.length === 0 || !Array.isArray(uris)) {
    return { body, held: [] };
  }
  const needle = backupAppId.toLowerCase();
  const held = uris.filter((uri) => typeof uri === 'string' && uri.toLowerCase().includes(needle));
  if (held.length === 0) return { body, held: [] };
  return { body: { ...body, identifierUris: uris.filter((uri) => !held.includes(uri)) }, held };
}
