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
// A prefix starts after a non-label character or right after a %XX escape (`a%40contoso…`),
// never inside the escape itself.
const TENANT_HOST = /(?:(?<=%[0-9a-f]{2})|(?<![a-z0-9%-]|%[0-9a-f]))([a-z0-9]+)(?=(?:-my|-admin)?\.(?:sharepoint\.com|onmicrosoft\.com)\b)/gi;

// Opaque ids that are base64 of text holding GUIDs, such as a Teams membership id
// (`0##<tenant>##<team>##<user>`).
// No `/` in the alphabet: such ids sit inside URL paths, and the capture refuses ids holding one.
const BASE64_TOKEN = /[A-Za-z0-9+_=-]{40,}/g;

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
  const plain = (value) => value.replace(GUID, guid).replace(TENANT_HOST, host);
  const encoded = (token) => {
    const url = /[-_]/.test(token);
    const decoded = Buffer.from(token, url ? 'base64url' : 'base64');
    const reencode = (buffer) => {
      const out = buffer.toString(url ? 'base64url' : 'base64');
      return token.endsWith('=') || url ? out : out.replace(/=+$/, '');
    };
    // Only a canonical encoding of printable text that holds a GUID is rewritten.
    const inner = decoded.toString('latin1');
    if (reencode(decoded) !== token || !/^[\x20-\x7e]+$/.test(inner) || !inner.match(GUID)) return token;
    return reencode(Buffer.from(plain(inner), 'latin1'));
  };
  const text = (value) => plain(value.replace(BASE64_TOKEN, encoded));
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
