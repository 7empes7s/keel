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
  const backup = payload?.appId;
  const live = current.payload?.appId;
  if (typeof backup !== 'string' || typeof live !== 'string' || backup.length === 0 || live.length === 0) return payload;
  if (backup.toLowerCase() === live.toLowerCase()) return payload;
  // A GUID may be written in any case, so the match ignores case.
  const pattern = new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return replaceInStrings(payload, pattern, () => live);
}
