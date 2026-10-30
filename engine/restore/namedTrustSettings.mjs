/**
 * The restore-writer trust rule (CLAUDE.md) for Intune settings that are named
 * by a value, not a key. The key-based check (isTrustField) never sees them:
 *
 *  - custom (OMA-URI) profiles hold every setting under the same keys
 *    (omaSettings[].omaUri, .value) and say which setting it is only in the
 *    omaUri value, such as ./Device/Vendor/MSFT/RootCATrustedCertificates/...;
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

// Custom settings whose value is text Graph returns (a base64 value is left out:
// random text in it can look like a name, and its OMA-URI says what it is).
const TEXT_VALUE = /^#microsoft\.graph\.omaSetting(?:String|StringXml)$/;

/**
 * The OMA-URIs anywhere in a payload that name a trust setting, or whose text
 * value holds one (a VPN EAP or Wi-Fi XML naming its trusted root
 * certificates and servers), sorted and without repeats.
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
      const text = TEXT_VALUE.test(node['@odata.type'] ?? '') && typeof node.value === 'string' ? node.value : null;
      if (isTrustSettingName(node.omaUri) || isTrustSettingName(text)) found.add(node.omaUri);
    }
    Object.values(node).forEach(walk);
  };
  walk(payload);
  return [...found].sort();
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
