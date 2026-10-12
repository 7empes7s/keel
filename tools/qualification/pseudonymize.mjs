/**
 * Pseudonymizes tenant identifiers in a live capture before it is digested, signed and
 * committed. The repository is public, so a record must not carry the tenant's directory
 * id, app (client) ids, object ids or its SharePoint / onmicrosoft host name.
 *
 * Every GUID becomes a GUID-shaped pseudonym, every security identifier (`S-1-12-1-…`, which
 * encodes the object GUID, and on-premises `S-1-5-21-…`) a SID-shaped one, every immutable id a
 * base64-shaped one, and every tenant host prefix (`<prefix>[-my|-admin].sharepoint.com`,
 * `<prefix>.onmicrosoft.com`) a host-shaped one. All are derived from the record's tenantRef,
 * so the same id maps to the same pseudonym in every gate captured for that tenant: equality
 * checks inside a record, across its capture log and along the gate chain still hold, and
 * validators keep their shape checks.
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

// Security identifiers. A cloud SID (`S-1-12-1-a-b-c-d`) is the object's GUID encoded as four
// 32-bit words; an on-premises SID (`S-1-5-21-a-b-c[-rid]`) names the domain and the object.
const CLOUD_SID = /S-1-12-1(?:-\d{1,10}){4}(?!\d)/g;
const ONPREM_SID = /S-1-5-21(?:-\d{1,10}){3,4}(?!\d)/g;
// An immutable id (`onPremisesImmutableId`) is the base64 of an AD objectGUID's 16 bytes.
const IMMUTABLE_ID_KEYS = new Set(['onPremisesImmutableId', 'immutableId']);
const IMMUTABLE_ID = /^[A-Za-z0-9+/]{22}==$/;

const sha256Hex = (text) => createHash('sha256').update(text).digest('hex');
const MAX_WORD = 0xffffffff;

// Windows lays a GUID's first three groups out little-endian; a cloud SID reads the resulting
// 16 bytes as four little-endian words, and an immutable id is their base64.
const guidToBytes = (value) => {
  const be = Buffer.from(value.replace(/-/g, ''), 'hex');
  return Buffer.from([be[3], be[2], be[1], be[0], be[5], be[4], be[7], be[6], ...be.subarray(8)]);
};
const bytesToGuid = (le) => {
  const h = Buffer.from([le[3], le[2], le[1], le[0], le[5], le[4], le[7], le[6], ...le.subarray(8)]).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
export const guidToCloudSid = (value) => {
  const bytes = guidToBytes(value);
  return `S-1-12-1-${[0, 4, 8, 12].map((offset) => bytes.readUInt32LE(offset)).join('-')}`;
};
export const cloudSidToGuid = (sid) => {
  const words = sid.split('-').slice(4).map(Number);
  if (words.length !== 4 || words.some((word) => word > MAX_WORD)) return null;
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt32LE(word, index * 4));
  return bytesToGuid(bytes);
};

/** Every GUID and SID in `text`, lower-cased and deduplicated: the ids a capture must lose. */
export function rawIdentifiers(text) {
  return [...new Set([...text.matchAll(GUID), ...text.matchAll(CLOUD_SID), ...text.matchAll(ONPREM_SID)].map((m) => m[0].toLowerCase()))];
}

export function pseudonymizer(tenantRef) {
  if (!tenantRef) throw new Error('pseudonymizing a capture needs its tenantRef');
  const digest = (kind, value) => sha256Hex(`keel-pseudonym:v1|${tenantRef}|${kind}|${value.toLowerCase()}`);
  const guid = (value) => {
    const h = digest('guid', value);
    // RFC 9562 version 8 (custom) with the RFC variant, so it still reads as a GUID.
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const host = (value) => `t${digest('host', value).slice(0, 11)}`;
  const words = (kind, value, count) => {
    const h = digest(kind, value);
    return Array.from({ length: count }, (_, i) => parseInt(h.slice(i * 8, i * 8 + 8), 16));
  };
  // A cloud SID maps through the GUID it encodes, so the SID and the GUID stay consistent.
  const cloudSid = (sid) => {
    const decoded = cloudSidToGuid(sid);
    return decoded ? guidToCloudSid(guid(decoded)) : `S-1-12-1-${words('sid', sid, 4).join('-')}`;
  };
  // An on-premises SID keeps its domain part stable across the domain's objects.
  const onPremSid = (sid) => {
    const parts = sid.split('-');
    const domain = parts.slice(0, 7).join('-');
    const out = [...words('sid-domain', domain, 3)];
    if (parts.length > 7) out.push(words('sid-rid', sid, 1)[0]);
    return `S-1-5-21-${out.join('-')}`;
  };
  const immutableId = (value) => {
    if (typeof value !== 'string' || !IMMUTABLE_ID.test(value)) return value;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 16 ? guidToBytes(guid(bytesToGuid(bytes))).toString('base64') : value;
  };
  const plain = (value) => value.replace(GUID, guid).replace(CLOUD_SID, cloudSid).replace(ONPREM_SID, onPremSid).replace(TENANT_HOST, host);
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
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [text(key), IMMUTABLE_ID_KEYS.has(key) ? walk(immutableId(item)) : walk(item)]));
    }
    return value;
  };
  return { guid, host, cloudSid, onPremSid, immutableId, text, walk };
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
