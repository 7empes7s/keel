/**
 * What every diff view (Changes, Compare, Activity, Emergency changes, Approvals)
 * treats as "the same" and what it never shows. UI audit 2026-10-31, item B4.
 *
 * - An empty value is no value: null, a missing field, "" and an empty list or
 *   object read the same, so "Description: Not set -> not set" is never a change.
 * - A list is a set: two lists that hold the same entries in another order are
 *   the same. (Read views only: drift hashes and restore payloads are unchanged.)
 * - Credential material is never shown. Graph returns a password's first three
 *   characters as its `hint`; that and any field named like a password or secret
 *   reads as HIDDEN. A changed credential still reads as changed, by its other
 *   fields (key id, dates) or by the hidden marker on each side.
 */

/** What a hidden credential value reads as in a diff; the portal words it. */
export const HIDDEN = '<hidden>';

// Field names whose string values are credential material.
const CREDENTIAL_FIELD = /^(hint|passwordHint|secretText|password|passphrase|secret|clientSecret|sharedSecret|preSharedKey|presharedKey|sharedKey|privateKey|certificatePassword|wifiPassword|apiKey|accessToken|refreshToken|token)$/i;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a field (its last path segment) holds credential material. */
export function isCredentialField(path) {
  const last = String(path ?? '').split('.').pop() ?? '';
  return CREDENTIAL_FIELD.test(last);
}

/**
 * The value with every credential string replaced by HIDDEN. `field` is the name
 * (or path) the value sits under, so a lone hint value is hidden too.
 */
export function maskCredentials(value, field = '') {
  if (typeof value === 'string') return value !== '' && isCredentialField(field) ? HIDDEN : value;
  if (Array.isArray(value)) return value.map((entry) => maskCredentials(entry, field));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = maskCredentials(inner, key);
    return out;
  }
  return value;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The form two values are compared in: empty values are null, object keys with an
 * empty value are dropped, keys are sorted and list entries are sorted.
 */
export function diffNormal(value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    const entries = value.map(diffNormal).filter((entry) => entry !== null);
    if (!entries.length) return null;
    return entries.map((entry) => [stable(entry), entry]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, entry]) => entry);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      const inner = diffNormal(value[key]);
      if (inner !== null) out[key] = inner;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

/** Whether a value is empty: null, missing, "" or a list or object of nothing. */
export const isEmptyValue = (value) => diffNormal(value) === null;

/** Whether two values are the same for a person reading a diff. */
export function sameForDiff(a, b) {
  return stable(diffNormal(a)) === stable(diffNormal(b));
}
