/**
 * Pseudonymizes tenant identifiers in a live capture before it is digested, signed and
 * committed. The repository is public, so a record must not carry the tenant's directory
 * id, app (client) ids, object ids or its SharePoint / onmicrosoft host name.
 *
 * Every GUID becomes a GUID-shaped pseudonym and every tenant host prefix
 * (`<prefix>[-my|-admin].sharepoint.com`, `<prefix>.onmicrosoft.com`) becomes a host-shaped
 * one. Both are derived from the record's tenantRef, so the same id maps to the same
 * pseudonym in every gate captured for that tenant: equality checks inside a record, across
 * its capture log and along the gate chain still hold, and validators keep their shape checks.
 * Only the capture tools call this; validators never need to reverse it.
 */
import { createHash } from 'node:crypto';

// No word boundaries: ids also appear after URL escapes such as `%2C`.
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TENANT_HOST = /(?<![a-z0-9-])([a-z0-9]+)(?=(?:-my|-admin)?\.(?:sharepoint\.com|onmicrosoft\.com)\b)/gi;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');

export function pseudonymizer(tenantRef) {
  if (!tenantRef) throw new Error('pseudonymizing a capture needs its tenantRef');
  const digest = (kind, value) => sha256Hex(`keel-pseudonym:v1|${tenantRef}|${kind}|${value.toLowerCase()}`);
  const guid = (value) => {
    const h = digest('guid', value);
    // RFC 9562 version 8 (custom) with the RFC variant, so it still reads as a GUID.
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const host = (value) => `t${digest('host', value).slice(0, 11)}`;
  const text = (value) => value.replace(GUID, guid).replace(TENANT_HOST, host);
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), walk(item)]));
    return value;
  };
  return { guid, host, text, walk };
}

/**
 * Returns the record and the serialized capture log with identifiers pseudonymized, and
 * the record's captureLogSha256 recomputed over the log that will actually be written.
 */
export function pseudonymizeCapture({ record, log }) {
  const { walk } = pseudonymizer(record.tenantRef);
  const captureLog = `${JSON.stringify(walk(log), null, 2)}\n`;
  const safe = walk(record);
  if (safe.subject && typeof safe.subject === 'object' && 'captureLogSha256' in safe.subject) {
    safe.subject.captureLogSha256 = sha256Hex(captureLog);
  }
  return { record: safe, captureLog };
}
