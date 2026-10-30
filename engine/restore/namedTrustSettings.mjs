/**
 * The restore-writer trust rule (CLAUDE.md) for Intune settings that are named
 * by a value, not a key. The key-based check (isTrustField) never sees them:
 *
 *  - custom (OMA-URI) profiles hold every setting under the same keys
 *    (omaSettings[].omaUri, .value) and say which setting it is only in the
 *    omaUri value, such as ./Device/Vendor/MSFT/RootCATrustedCertificates/...,
 *    or in the value itself (text, or base64 of text or a certificate);
 *  - Apple custom profiles hold the whole profile file (a property list,
 *    base64) in one field, and name each payload by its PayloadType;
 *  - administrative templates (groupPolicyConfiguration) name each setting by
 *    a GUID definition id; only the definition's display name and category
 *    path (read with $expand=definition) say what it is.
 *
 * A name is checked with spaces, slashes and punctuation taken out, so
 * "Browser sign-in settings" and "./Vendor/MSFT/Policy/Config/Authentication/
 * EnableWebSignIn" both read as holding "signin".
 */
import { TRUST_SETTING_PATTERN } from './workloads/writeDeclarations.mjs';

/**
 * The settings catalog's trust setting names (TRUST_SETTING_PATTERN: trust,
 * certificates, sign-in, federation, single sign-on, Kerberos, certificate
 * enrolment), plus the words administrative templates and OMA-URIs use for the
 * same things: the servers a browser sends or delegates credentials to,
 * Internet Explorer zone assignment (which sites are trusted), Windows Hello
 * for Business and smart card sign-in.
 */
const NAMED_TRUST_PATTERN = new RegExp(
  `${TRUST_SETTING_PATTERN.source}|authenticationserver|delegat[a-z]*credential|credentialsdelegation`
  + '|sitetozone|zoneassignment|passportforwork|windowshello|smartcard',
  'i',
);

// The Trusted Platform Module is device hardware, not a trust relationship.
const NOT_TRUST = /trusted[^a-z0-9]*platform[^a-z0-9]*module/gi;

/**
 * Whether a setting name (an OMA-URI, a display name, a category path or a
 * custom setting's text) is a trust setting. It is checked as written (the
 * settings catalog ids with dots, such as com.apple.security.root) and with
 * punctuation taken out.
 */
export function isTrustSettingName(text) {
  if (typeof text !== 'string') return false;
  const kept = text.replace(NOT_TRUST, '');
  return NAMED_TRUST_PATTERN.test(kept) || NAMED_TRUST_PATTERN.test(kept.replace(/[^a-z0-9]/gi, ''));
}

// Custom settings whose value is base64. Graph returns a StringXml value as
// base64 (Edm.Binary); older backups hold it as written.
const BASE64_VALUE = /^#microsoft\.graph\.omaSetting(?:StringXml|Base64)$/;

/**
 * The bytes a base64 value holds, or null when it is not strict base64 (the
 * value is then not decoded: a guess could read random text as a name).
 */
export function decodeBase64(value) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  return Buffer.from(compact, 'base64');
}

/**
 * The text bytes hold (UTF-8, or UTF-16 with a byte order mark), or null when
 * they are binary: a control character or an invalid UTF-8 sequence.
 */
export function bytesAsText(bytes) {
  if (!bytes || bytes.length === 0) return null;
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  else text = bytes.toString('utf8');
  text = text.replace(/^\uFEFF/, '');
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/.test(text) ? null : text;
}

/** Whether bytes are a certificate: PEM text, or DER (an ASN.1 sequence whose length fits). */
export function isCertificateBytes(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (/-----BEGIN [A-Z0-9 ]*CERTIFICATE-----/.test(bytes.toString('latin1'))) return true;
  if (bytes[0] !== 0x30) return false;
  if (bytes[1] === 0x82) return bytes.length >= 4 + ((bytes[2] << 8) | bytes[3]);
  if (bytes[1] === 0x83) return bytes.length >= 5 + ((bytes[2] << 16) | (bytes[3] << 8) | bytes[4]);
  return false;
}

/** Whether a custom setting's value holds a trust setting, read as text or decoded from base64. */
function omaValueHoldsTrust(node) {
  const type = node['@odata.type'] ?? '';
  const value = node.value;
  if (typeof value !== 'string') return false;
  if (type === '#microsoft.graph.omaSettingString') return isTrustSettingName(value);
  // A StringXml value written as XML (older backups) is read as it is.
  if (type === '#microsoft.graph.omaSettingStringXml' && value.trimStart().startsWith('<')) return isTrustSettingName(value);
  if (!BASE64_VALUE.test(type)) return false;
  const bytes = decodeBase64(value);
  if (!bytes) return false;
  if (isCertificateBytes(bytes)) return true;
  const text = bytesAsText(bytes);
  return text !== null && isTrustSettingName(text);
}

/**
 * The OMA-URIs anywhere in a payload that name a trust setting, or whose value
 * holds one (a VPN EAP or Wi-Fi XML naming its trusted root certificates and
 * servers, or a base64 value that decodes to such text or to a certificate),
 * sorted and without repeats.
 */
export function trustOmaUris(payload) {
  const found = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.omaUri === 'string') {
      if (isTrustSettingName(node.omaUri) || omaValueHoldsTrust(node)) found.add(node.omaUri);
    }
    Object.values(node).forEach(walk);
  };
  walk(payload);
  return [...found].sort();
}

/**
 * Apple custom profiles: the field that holds the profile file, base64 of an
 * XML property list (a .mobileconfig, possibly signed) or, for a macOS
 * preference file, its XML.
 */
const APPLE_PROFILE_FIELDS = Object.freeze({
  '#microsoft.graph.macOSCustomConfiguration': 'payload',
  '#microsoft.graph.iosCustomConfiguration': 'payload',
  '#microsoft.graph.macOSCustomAppConfiguration': 'configurationXml',
});

/** The field holding an Apple custom profile's file, or null when the payload is not one or the file is empty. */
export function appleProfileField(payload) {
  const field = APPLE_PROFILE_FIELDS[payload?.['@odata.type']];
  return field && typeof payload[field] === 'string' && payload[field].trim().length > 0 ? field : null;
}

const PAYLOAD_TYPE = /<key>\s*PayloadType\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/g;
const DATA_BLOCK = /<data>([^<]*)<\/data>/g;

/** The property list text in bytes: the file itself, or the one a signature wraps. */
function propertyListText(bytes) {
  const text = bytesAsText(bytes);
  if (text !== null) return text;
  // A signed profile is CMS (binary) around the XML, which is kept as written.
  const raw = bytes.toString('latin1');
  const start = raw.search(/<\?xml|<plist/);
  const end = raw.lastIndexOf('</plist>');
  if (start < 0 || end < start) return null;
  return Buffer.from(raw.slice(start, end + '</plist>'.length), 'latin1').toString('utf8');
}

/**
 * Trust, certificate and sign-in content in an Apple custom profile file:
 * the trust payload types it holds (com.apple.security.root, .pkcs12,
 * com.apple.extensiblesso, ...), or the field name when the trust content is
 * elsewhere (a certificate in a data block, a Wi-Fi trusted server name).
 * A file that cannot be read (binary property list, or not base64) is
 * returned under unreadable, since nothing shows it holds none.
 */
export function appleProfileTrust(payload) {
  const field = appleProfileField(payload);
  if (field === null) return { trust: [], unreadable: [] };
  const value = payload[field];
  const bytes = decodeBase64(value);
  const text = bytes ? propertyListText(bytes) : value.trimStart().startsWith('<') ? value : null;
  if (text === null) return { trust: [], unreadable: [field] };
  const trust = new Set();
  for (const [, type] of text.matchAll(PAYLOAD_TYPE)) if (isTrustSettingName(type)) trust.add(type);
  // Data blocks are base64: read only for a certificate, never as text.
  let certificate = false;
  for (const [, data] of text.matchAll(DATA_BLOCK)) if (isCertificateBytes(decodeBase64(data))) certificate = true;
  if (trust.size === 0 && (certificate || isTrustSettingName(text.replace(DATA_BLOCK, '<data></data>')))) trust.add(field);
  return { trust: [...trust].sort(), unreadable: [] };
}

/**
 * An administrative template's settings, sorted into trust settings (by
 * display name, or the definition id when it has none) and settings whose
 * definition the backup does not describe (no display name and no category
 * path), which cannot be checked.
 */
export function groupPolicyTrustSettings(definitionValues) {
  const trust = new Set();
  const unknown = new Set();
  for (const setting of Array.isArray(definitionValues) ? definitionValues : []) {
    const definition = setting?.definition ?? {};
    const names = [definition.displayName, definition.categoryPath].filter((name) => typeof name === 'string' && name.length > 0);
    const label = definition.displayName || definition.id || '(unnamed setting)';
    if (names.length === 0) unknown.add(label);
    else if (names.some(isTrustSettingName)) trust.add(label);
  }
  return { trust: [...trust].sort(), unknown: [...unknown].sort() };
}

/**
 * A skipped write for trust settings named by a value, with the open
 * completion item a person works from (the same shape the whole-object
 * refusal uses: kind manual-setting, requirement trustFields).
 */
export function namedTrustSkip(names, description) {
  const fields = Object.freeze([...new Set(names)].sort());
  return Object.freeze({
    outcome: 'skipped',
    reason: `manual: ${description(fields.join(', '))}`,
    completion: Object.freeze([Object.freeze({ kind: 'manual-setting', requirement: 'trustFields', fields, description: description(fields.join(', ')) })]),
  });
}
