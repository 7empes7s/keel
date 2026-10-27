/**
 * Pseudonymizes tenant identifiers in a live capture before it is digested, signed and
 * committed. The repository is public, so a record must not carry the tenant's directory
 * id, app (client) ids, object ids or its SharePoint / onmicrosoft host name.
 *
 * Every GUID becomes a GUID-shaped pseudonym, every security identifier (`S-1-12-1-…`, which
 * encodes the object GUID, and on-premises `S-1-5-21-…`, plus any value of a `securityIdentifier`
 * or `onPremisesSecurityIdentifier` field whatever its shape) a SID-shaped one, every immutable id a
 * base64-shaped one, every tenant host prefix (`<prefix>[-my|-admin].sharepoint.com`,
 * `<prefix>.onmicrosoft.com`) a host-shaped one, and the user part and mail domain of every
 * SharePoint claims login (`i:0#.f|membership|user@domain`) and of every other sign-in name or mail
 * address (`user@domain`, `user%40domain`, a OneDrive `/personal/user_domain_com` path, a
 * `publisherDomain`) pseudonyms of their own. All are derived from the record's tenantRef,
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
// base64url of the role definition's and the principal's GUID bytes (43 characters), or of three
// GUIDs (64 characters), with optional `-<suffix>` parts such as `-1` or `-1-e`. Its bytes are not
// text, so the token rule above cannot see the GUIDs inside it.
const ROLE_ASSIGNMENT_ID = /^([A-Za-z0-9_-]{64}|[A-Za-z0-9_-]{43})((?:-[A-Za-z0-9]{1,8})*)$/;
const ROLE_ASSIGNMENT_TOKEN = /(?<![A-Za-z0-9_-])(?:[A-Za-z0-9_-]{64}|[A-Za-z0-9_-]{43})(?:-[A-Za-z0-9]{1,8})*(?![A-Za-z0-9_-])/g;

// A GUID written without dashes. Only one that reads as an RFC 4122 GUID (a version 1-8 nibble
// and the RFC variant) counts, so most 32-digit hashes are left alone; longer hex runs never match.
const HEX_GUID = /(?<![0-9a-f])[0-9a-f]{12}[1-8][0-9a-f]{3}[89ab][0-9a-f]{15}(?![0-9a-f])/gi;
const HEX_GUID_ONLY = new RegExp(`^${HEX_GUID.source}$`, 'i');
const dashed = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

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

// A SharePoint claims login (`i:0#.f|membership|user@domain`), raw or URL-escaped
// (`%7Cmembership%7Cuser%40domain`). Its user part names a person and its domain is the
// tenant's real mail domain, so both are replaced. Groups use other claim types with GUIDs.
const CLAIMS_LOGIN = /((?:\||%7c)membership(?:\||%7c))([a-z0-9._'+-]+)(@|%40)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi;
// What a pseudonymized claims login looks like: the `keel-rt-` test-user prefix is kept so the
// gates can still see a test user, the rest is digest-derived, and the domain is host-shaped.
const CLAIMS_USER_PSEUDONYM = /^(?:keel-rt-)?u[0-9a-f]{12}$/;
const CLAIMS_DOMAIN_PSEUDONYM = /^t[0-9a-f]{11}\.(?:onmicrosoft\.com|example)$/;
const FIXTURE_USER_PREFIX = 'keel-rt-';

// A sign-in name or mail address (`user@domain`, or `user%40domain` in a URL path) outside a claims
// login. It starts after a non-name character or right after a %XX escape (`%2Fuser%40…`).
// Graph annotations (`value@odata.context`, `@microsoft.graph.conflictBehavior`) are not addresses.
const MAIL = /(?:(?<=%[0-9a-f]{2})|(?<![a-z0-9._+%-]|%[0-9a-f]))([a-z0-9][a-z0-9._'+-]*)(@|%40)((?:[a-z0-9-]+\.)+[a-z]{2,})(?![a-z0-9-]|\.[a-z0-9])/gi;
const ANNOTATION_DOMAIN = /^(?:odata|microsoft\.graph)\./i;
// Reserved names (RFC 2606 / 6761) never name a real tenant: test fixtures use them as they are.
const RESERVED_DOMAIN = /(?:^|\.)(?:example|test|invalid|localhost|example\.(?:com|net|org))$/i;
// A soft-deleted user's sign-in name is its object id (32 hex digits, no dashes) glued to the old one.
const DELETED_PREFIX = /^([0-9a-f]{32})(?![0-9a-f])/i;
const MAIL_USER_PSEUDONYM = /^(?:[0-9a-f]{32})?(?:keel-rt-)?u[0-9a-f]{12}$/;
// A OneDrive personal site is named after its owner's sign-in name, with `.` and `@` written `_`
// (`/personal/alice_contoso_com`). A site name without a domain tail (`keel-rt-absent-1234`) is left alone.
const PERSONAL_SITE = /((?:\/|%2f)personal(?:\/|%2f))([a-z0-9][a-z0-9.-]*(?:_[a-z0-9-]+)*_[a-z0-9-]+_[a-z]{2,})(?![a-z0-9_.-])/gi;
const PERSONAL_SITE_PSEUDONYM = /^(?:keel-rt-)?u[0-9a-f]{12}_t[0-9a-f]{11}_example$/;
// Fields that hold a bare mail domain of the tenant.
const DOMAIN_KEYS = new Set(['publisherDomain']);
const DOMAIN_FIELD = /"publisherDomain"\s*:\s*"([^"]*)"/gi;

const isMailToRewrite = (user, domain) => !ANNOTATION_DOMAIN.test(domain) && !RESERVED_DOMAIN.test(domain)
  && !(MAIL_USER_PSEUDONYM.test(user.toLowerCase()) && CLAIMS_DOMAIN_PSEUDONYM.test(domain.toLowerCase()));
const isDomainPseudonym = (domain) => domain === '' || RESERVED_DOMAIN.test(domain) || CLAIMS_DOMAIN_PSEUDONYM.test(domain.toLowerCase());

/** Every sign-in name, mail address, OneDrive personal site name and domain field in `text` that is not a pseudonym, lower-cased and deduplicated. */
export function unpseudonymizedMailNames(text) {
  // A claims login is listed by its own rule, not again as an address.
  const outsideClaims = text.replace(CLAIMS_LOGIN, ' ');
  const found = [
    ...[...outsideClaims.matchAll(MAIL)].filter((m) => isMailToRewrite(m[1], m[3])).map((m) => m[0]),
    ...[...text.matchAll(PERSONAL_SITE)].filter((m) => !PERSONAL_SITE_PSEUDONYM.test(m[2].toLowerCase())).map((m) => m[0]),
    ...[...text.matchAll(DOMAIN_FIELD)].filter((m) => !isDomainPseudonym(m[1])).map((m) => m[0]),
  ];
  return [...new Set(found.map((value) => value.toLowerCase()))];
}

/** Every SharePoint claims login in `text` (from its `|membership|` separator on), lower-cased and deduplicated. */
export function claimsLogins(text) {
  return [...new Set([...text.matchAll(CLAIMS_LOGIN)].map((m) => m[0].toLowerCase()))];
}

/** The claims logins in `text` whose user part or domain is not a pseudonym. */
export function unpseudonymizedClaimsLogins(text) {
  return [...text.matchAll(CLAIMS_LOGIN)]
    .filter((m) => !CLAIMS_USER_PSEUDONYM.test(m[2].toLowerCase()) || !CLAIMS_DOMAIN_PSEUDONYM.test(m[4].toLowerCase()))
    .map((m) => m[0].toLowerCase())
    .filter((login, index, all) => all.indexOf(login) === index);
}

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
 * The GUIDs a role assignment id encodes (two, or three), or null. Each must read as an RFC 4122
 * GUID (a version 1-8 and the RFC variant), so an arbitrary 32- or 48-byte token rarely qualifies.
 */
export function roleAssignmentIdGuids(token) {
  const match = ROLE_ASSIGNMENT_ID.exec(token);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64url');
  if (bytes.length % 16 !== 0 || bytes.toString('base64url') !== match[1]) return null;
  const parts = Array.from({ length: bytes.length / 16 }, (_, i) => bytes.subarray(i * 16, i * 16 + 16));
  const guidLike = (le) => (le[7] >> 4) >= 1 && (le[7] >> 4) <= 8 && (le[8] & 0xc0) === 0x80;
  return parts.every(guidLike) ? parts.map((part) => bytesToGuid(part)) : null;
}

/**
 * Every GUID (dashed or not), SID, role assignment id and SharePoint claims login in `text`,
 * lower-cased and deduplicated: the ids a capture must lose.
 */
export function rawIdentifiers(text) {
  const roleAssignmentIds = [...text.matchAll(ROLE_ASSIGNMENT_TOKEN)].filter((m) => roleAssignmentIdGuids(m[0]));
  return [...new Set([...[...text.matchAll(GUID), ...text.matchAll(HEX_GUID), ...text.matchAll(CLOUD_SID), ...text.matchAll(ONPREM_SID), ...roleAssignmentIds]
    .map((m) => m[0].toLowerCase()), ...claimsLogins(text), ...unpseudonymizedMailNames(text)])];
}

/**
 * The ids in `text` that are not pseudonyms. Every GUID the pseudonymizer writes is RFC 9562
 * version 8, and a cloud SID or role assignment id it writes encodes version 8 GUIDs, whereas
 * Entra assigns version 4. So a published capture can be checked without the tenant's raw ids:
 * a SID-shaped value is not a leak when it encodes a pseudonym. An on-premises SID cannot be
 * told apart this way and is always listed. A SharePoint claims login is listed unless both its
 * user part and its domain have the pseudonym shape.
 */
export function unpseudonymizedIds(text) {
  // A GUID that is all zeros but for its version and variant digits is a placeholder (a probe
  // path such as `/restore/dry-run/00000000-0000-4000-8000-000000000000`), never a tenant's id.
  const isPseudonym = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-8/i.test(value) || /^0{8}-0{4}-[0-9a-f]0{3}-[0-9a-f]0{3}-0{12}$/i.test(value);
  const rawClaims = new Set(unpseudonymizedClaimsLogins(text));
  const rawMail = new Set(unpseudonymizedMailNames(text));
  return rawIdentifiers(text).filter((id) => {
    if (rawMail.has(id)) return true;
    // A claims login is checked by shape: a pseudonymized one has a digest user part and domain.
    if (/^(?:\||%7c)membership/.test(id)) return rawClaims.has(id);
    if (GUID_ONLY.test(id)) return !isPseudonym(id);
    if (HEX_GUID_ONLY.test(id)) return !isPseudonym(dashed(id));
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
  // A claims login's user part keeps only the test-user prefix. An onmicrosoft domain has already
  // been mapped by the tenant host rule (it runs first); any other domain becomes host-shaped.
  const claimsUser = (user) => {
    const lower = user.toLowerCase();
    const prefix = lower.startsWith(FIXTURE_USER_PREFIX) ? FIXTURE_USER_PREFIX : '';
    return `${prefix}u${digest('claims-user', lower).slice(0, 12)}`;
  };
  const claimsDomain = (domain) => (/\.onmicrosoft\.com$/i.test(domain) ? domain : `${host(`mail:${domain}`)}.example`);
  const claims = (value) => value.replace(CLAIMS_LOGIN, (_, sep, user, at, domain) => `${sep}${claimsUser(user)}${at}${claimsDomain(domain)}`);
  // Any other sign-in name or mail address maps like a claims login, so the same person reads the
  // same in both forms. A soft-deleted user's object id prefix has already been pseudonymized.
  const mailUser = (user) => {
    const deleted = DELETED_PREFIX.exec(user);
    return deleted ? `${deleted[1]}${claimsUser(user.slice(32))}` : claimsUser(user);
  };
  const mail = (value) => value.replace(MAIL, (whole, user, at, domain) => (isMailToRewrite(user, domain) ? `${mailUser(user)}${at}${claimsDomain(domain)}` : whole));
  // A personal site name cannot be split back into user and domain, so it maps whole.
  const personalSite = (value) => value.replace(PERSONAL_SITE, (whole, path, name) => {
    if (PERSONAL_SITE_PSEUDONYM.test(name.toLowerCase())) return whole;
    const lower = name.toLowerCase();
    const prefix = lower.startsWith(FIXTURE_USER_PREFIX) ? FIXTURE_USER_PREFIX : '';
    return `${path}${prefix}u${digest('personal-site', lower).slice(0, 12)}_${host(`personal-site:${lower}`)}_example`;
  });
  const mailDomain = (value) => (typeof value === 'string' && !isDomainPseudonym(value) ? claimsDomain(text(value)) : value);
  const hexGuid = (value) => guid(dashed(value)).replace(/-/g, '');
  const plain = (value) => value.replace(GUID, guid).replace(HEX_GUID, hexGuid).replace(CLOUD_SID, cloudSid).replace(ONPREM_SID, onPremSid).replace(TENANT_HOST, host);
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
  const text = (value) => personalSite(mail(claims(plain(value.replace(ROLE_ASSIGNMENT_TOKEN, roleAssignmentId).replace(BASE64_TOKEN, encoded)))));
  const walk = (value) => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (IMMUTABLE_ID_KEYS.has(key)) return [text(key), walk(immutableId(item))];
        if (SID_KEYS.has(key) && typeof item === 'string') return [text(key), securityIdentifier(item)];
        if (DOMAIN_KEYS.has(key)) return [text(key), mailDomain(item)];
        return [text(key), walk(item)];
      }));
    }
    return value;
  };
  return { guid, host, cloudSid, onPremSid, immutableId, roleAssignmentId, securityIdentifier, claims, mail, personalSite, text, walk };
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
