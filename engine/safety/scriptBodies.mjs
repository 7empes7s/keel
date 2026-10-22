/**
 * Intune script text (PR #435, #436 follow-up).
 *
 * The backup holds the text of every Intune script, and real tenants often keep
 * passwords and keys in them. So:
 *  - Read views (Activity, Compare, Changes, Technical details) never show the
 *    text. Each body reads as a short summary: its size and a fingerprint, which
 *    still differs when the text differs, so a change still reads as changed.
 *  - Only restore paths (a restore's dry run, and the review of what it would run
 *    on devices) carry the full text.
 */
import { createHash } from 'node:crypto';

/** Each script kind and the fields that hold its script, the first of which every script has. */
export const SCRIPT_BODY_FIELDS = Object.freeze({
  deviceManagementScript: Object.freeze(['scriptContent']),
  deviceShellScript: Object.freeze(['scriptContent']),
  deviceHealthScript: Object.freeze(['detectionScriptContent', 'remediationScriptContent']),
  deviceComplianceScript: Object.freeze(['detectionScriptContent']),
  // Restore gaps, batch 5.
  deviceCustomAttributeShellScript: Object.freeze(['scriptContent']),
});

export const isScriptType = (resourceType) => Object.prototype.hasOwnProperty.call(SCRIPT_BODY_FIELDS, resourceType);

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The script as a person reads it: Graph stores it base64-encoded. */
export function scriptText(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || !BASE64.test(compact)) return value;
  const text = Buffer.from(compact, 'base64').toString('utf8');
  // Text that does not survive the round trip was never base64 of UTF-8 text.
  return Buffer.from(text, 'utf8').toString('base64') === compact ? text : value;
}

/**
 * A stable fingerprint of a stored script body (never the text itself): short for
 * reading, the full sha256 where an approval binds to exactly this text.
 */
export function scriptFingerprint(value, { full = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const hex = createHash('sha256').update(value).digest('hex');
  return full ? hex : hex.slice(0, 12);
}

/** What a read view shows in place of a script body. Null and absent stay as they are. */
export function scriptSummary(value) {
  if (typeof value !== 'string') return value ?? null;
  if (value.length === 0) return value;
  const size = scriptText(value).length;
  return `Script text hidden (${size.toLocaleString('en-US')} ${size === 1 ? 'character' : 'characters'}, fingerprint ${scriptFingerprint(value)})`;
}

/**
 * A script payload with each body replaced by its summary. Any other kind, and a
 * payload that is not an object, is returned as it is.
 */
export function withoutScriptBodies(resourceType, payload) {
  const fields = SCRIPT_BODY_FIELDS[resourceType];
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!fields.some((field) => typeof payload[field] === 'string')) return payload;
  const copy = { ...payload };
  for (const field of fields) {
    if (typeof copy[field] === 'string') copy[field] = scriptSummary(copy[field]);
  }
  return copy;
}
