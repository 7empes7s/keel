/**
 * Pseudonymizes tenant identifiers in a live capture before it is digested, signed and
 * committed. The repository is public, so a record must not carry the tenant's directory
 * id, app (client) ids, object ids or its SharePoint / onmicrosoft host name.
 *
 * Every GUID becomes a GUID-shaped pseudonym, every security identifier (`S-1-12-1-…`, which
 * encodes the object GUID, and on-premises `S-1-5-21-…`, plus any value of a `securityIdentifier`
 * or `onPremisesSecurityIdentifier` field whatever its shape) a SID-shaped one, every immutable id a
 * base64-shaped one, and every tenant host prefix (`<prefix>[-my|-admin].sharepoint.com`,
 * `<prefix>.onmicrosoft.com`) a host-shaped one. All are derived from the record's tenantRef,
 * so the same id maps to the same pseudonym in every gate captured for that tenant: equality
 * checks inside a record, across its capture log and along the gate chain still hold, and
 * validators keep their shape checks.
 * Only the capture tools call this; validators never need to reverse it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// No word boundaries: ids also appear after URL escapes such as `%2C`.
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GUID_ONLY = new RegExp(`^${GUID.source}$`, 'i');
// A prefix starts after a non-label character or right after a %XX escape (`a%40contoso…`),
// never inside the escape itself.
const TENANT_HOST = /(?:(?<=%[0-9a-f]{2})|(?<![a-z0-9%-]|%[0-9a-f]))([a-z0-9]+)(?=(?:-my|-admin)?\.(?:sharepoint\.com|onmicrosoft\.com)\b)/gi;

// Opaque ids that are base64 of text holding GUIDs, such as a Teams membership id
// (`0##<tenant>##<team>##<user>`).
// No `/` in the alphabet: such ids sit inside URL paths, and the capture refuses ids holding one.
const BASE64_TOKEN = /[A-Za-z0-9+_=-]{40,}/g;

// A directory role assignment id (`lAPpYvVpN0KRkAEhdxReEJC2sEqbR_9OmXWfOUQ7FJM-1`) is the
// base64url of the role definition's and the principal's GUID bytes, with an optional `-<n>`
// suffix. Its bytes are not text, so the token rule above cannot see the GUIDs inside it.
const ROLE_ASSIGNMENT_ID = /^([A-Za-z0-9_-]{43})(-\d{1,3})?$/;
const ROLE_ASSIGNMENT_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?:-\d{1,3})?(?![A-Za-z0-9_-])/g;

// Security identifiers. A cloud SID (`S-1-12-1-a-b-c-d`) is the object's GUID encoded as four
// 32-bit words; an on-premises SID (`S-1-5-21-a-b-c[-rid]`) names the domain and the object.
// Case-insensitive: Graph writes `S-`, but a lower-cased copy must not slip through either.
const CLOUD_SID = /S-1-12-1(?:-\d{1,10}){4}(?!\d)/gi;
const ONPREM_SID = /S-1-5-21(?:-\d{1,10}){3,4}(?!\d)/gi;
// A security identifier field (an Entra group's `securityIdentifier` encodes its object id) is
// pseudonymized whole, whatever its shape, so a form the patterns above miss is never published.
const SID_KEYS = new Set(['securityIdentifier', 'onPremisesSecurityIdentifier']);
const ANY_SID = /^S(?:-\d+){2,}$/i;
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

/**
 * The two GUIDs a role assignment id encodes, or null. Each half must read as an RFC 4122
 * GUID (a version 1-8 and the RFC variant), so an arbitrary 32-byte token rarely qualifies.
 */
export function roleAssignmentIdGuids(token) {
  const match = ROLE_ASSIGNMENT_ID.exec(token);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[1]) return null;
  const halves = [bytes.subarray(0, 16), bytes.subarray(16)];
  const guidLike = (le) => (le[7] >> 4) >= 1 && (le[7] >> 4) <= 8 && (le[8] & 0xc0) === 0x80;
  return halves.every(guidLike) ? halves.map((half) => bytesToGuid(half)) : null;
}

/**
 * Every GUID, SID and role assignment id in `text`, lower-cased and deduplicated: the ids a
 * capture must lose.
 */
export function rawIdentifiers(text) {
  const roleAssignmentIds = [...text.matchAll(ROLE_ASSIGNMENT_TOKEN)].filter((m) => roleAssignmentIdGuids(m[0]));
  return [...new Set([...text.matchAll(GUID), ...text.matchAll(CLOUD_SID), ...text.matchAll(ONPREM_SID), ...roleAssignmentIds]
    .map((m) => m[0].toLowerCase()))];
}

/**
 * The ids in `text` that are not pseudonyms. Every GUID the pseudonymizer writes is RFC 9562
 * version 8, and a cloud SID or role assignment id it writes encodes version 8 GUIDs, whereas
 * Entra assigns version 4. So a published capture can be checked without the tenant's raw ids:
 * a SID-shaped value is not a leak when it encodes a pseudonym. An on-premises SID cannot be
 * told apart this way and is always listed.
 */
export function unpseudonymizedIds(text) {
  const isPseudonym = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-8/i.test(value);
  return rawIdentifiers(text).filter((id) => {
    if (GUID_ONLY.test(id)) return !isPseudonym(id);
    if (/^s-1-12-1-/i.test(id)) return !isPseudonym(cloudSidToGuid(id) ?? '');
    if (/^s-1-5-21-/i.test(id)) return true;
    // A role assignment id, lower-cased by rawIdentifiers: decode the original spelling.
    const original = [...text.matchAll(ROLE_ASSIGNMENT_TOKEN)].map((m) => m[0]).find((token) => token.toLowerCase() === id);
    return !(roleAssignmentIdGuids(original ?? '') ?? []).every(isPseudonym);
  });
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
    const parts = sid.toUpperCase().split('-');
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
  // A value under a security identifier key: a recognized SID maps as above; any other SID
  // shape becomes a cloud-SID-shaped pseudonym of the whole value.
  const securityIdentifier = (value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (new RegExp(`^${CLOUD_SID.source}$`, 'i').test(trimmed)) return cloudSid(trimmed);
    if (new RegExp(`^${ONPREM_SID.source}$`, 'i').test(trimmed)) return onPremSid(trimmed);
    if (ANY_SID.test(trimmed)) return `S-1-12-1-${words('sid', trimmed, 4).join('-')}`;
    return text(value);
  };
  const plain = (value) => value.replace(GUID, guid).replace(CLOUD_SID, cloudSid).replace(ONPREM_SID, onPremSid).replace(TENANT_HOST, host);
  // A role assignment id maps through the two GUIDs it encodes, like a cloud SID.
  const roleAssignmentId = (token) => {
    const guids = roleAssignmentIdGuids(token);
    if (!guids) return token;
    const bytes = Buffer.concat(guids.map((value) => guidToBytes(guid(value))));
    return `${bytes.toString('base64url')}${ROLE_ASSIGNMENT_ID.exec(token)[2] ?? ''}`;
  };
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
  const text = (value) => plain(value.replace(ROLE_ASSIGNMENT_TOKEN, roleAssignmentId).replace(BASE64_TOKEN, encoded));
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (IMMUTABLE_ID_KEYS.has(key)) return [text(key), walk(immutableId(item))];
        if (SID_KEYS.has(key) && typeof item === 'string') return [text(key), securityIdentifier(item)];
        return [text(key), walk(item)];
      }));
    }
    return value;
  };
  return { guid, host, cloudSid, onPremSid, immutableId, roleAssignmentId, securityIdentifier, text, walk };
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

/**
 * `node tools/qualification/pseudonymize.mjs check FILE...` lists every id in the files that
 * is not a pseudonym and exits 1 if there is one. Run it on a capture before publishing it.
 */
export function main(argv = process.argv.slice(2), { read = (path) => readFileSync(path, 'utf8'), log = console.log } = {}) {
  const [command, ...files] = argv;
  if (command !== 'check' || files.length === 0) {
    log('usage: node tools/qualification/pseudonymize.mjs check FILE...');
    return 2;
  }
  let found = 0;
  for (const file of files) {
    const ids = unpseudonymizedIds(read(file));
    found += ids.length;
    log(ids.length === 0 ? `${file}: every id is a pseudonym` : `${file}: ${ids.length} id(s) that are not pseudonyms: ${ids.join(', ')}`);
  }
  return found === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
