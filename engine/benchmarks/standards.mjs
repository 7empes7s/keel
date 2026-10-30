/**
 * Known baselines the Compliance page measures against: which of a published
 * standard's policies Keel's checks cover, and how closely.
 *
 * Only public-domain standards ship, and only as reference codes: CISA SCuBA (CC0, a
 * U.S. government work) and NIST SP 800-53 Rev 5 (public domain, pinned at
 * docs/roadmap/benchmark-content). No standard's own text is copied; area names are
 * Keel's words. CIS Benchmarks are left out on purpose: their licence does not allow a
 * commercial product to ship them.
 *
 * SCuBA's policies are CISA ScubaGear's own rules, run unchanged on Keel's backups
 * (scubagear/controls.mjs): each policy maps to the one control that runs its rule.
 * NIST's are Keel's own reading of what a check covers, never a claim that meeting it
 * meets the standard. `match` says how close a mapping is: 'full' when the check tests
 * what the policy asks, 'partial' when it tests part of it (the note says which part).
 * A policy no check maps to is listed as not checked, so the gaps show too.
 *
 * This module reads nothing from disk, because the portal bundles it.
 */
const ADMIN_COUNT = 'keel-custom.role-assignment.admin-count-at-most';
const ADMIN_GROUPS = 'keel-custom.group.role-assignable-not-synced';

// The ScubaGear release whose rules run (scubagear/pin.json), and the rules of every
// product it registers as controls (a test keeps the list equal to the registered
// cisa-scuba controls).
export const SCUBA_VERSION = '2.0.0';
export const SCUBA_CONTROL_PREFIX = 'scubagear.';
export const SCUBA_POLICY_IDS = Object.freeze([
  'MS.AAD.1.1v1', 'MS.AAD.2.1v1', 'MS.AAD.2.2v1', 'MS.AAD.2.3v1', 'MS.AAD.3.1v1', 'MS.AAD.3.2v2',
  'MS.AAD.3.3v2', 'MS.AAD.3.4v1', 'MS.AAD.3.5v2', 'MS.AAD.3.6v1', 'MS.AAD.3.7v1', 'MS.AAD.3.8v1',
  'MS.AAD.3.9v1', 'MS.AAD.4.1v1', 'MS.AAD.5.1v1', 'MS.AAD.5.2v1', 'MS.AAD.5.3v1', 'MS.AAD.5.5v1',
  'MS.AAD.5.6v1', 'MS.AAD.5.7v1', 'MS.AAD.6.1v1', 'MS.AAD.7.1v1', 'MS.AAD.7.2v1', 'MS.AAD.7.3v1',
  'MS.AAD.7.4v1', 'MS.AAD.7.5v1', 'MS.AAD.7.6v1', 'MS.AAD.7.7v1', 'MS.AAD.7.8v1', 'MS.AAD.7.9v1',
  'MS.AAD.8.1v1', 'MS.AAD.8.2v1', 'MS.AAD.8.3v1', 'MS.AAD.9.1v1', 'MS.EXO.1.1v2', 'MS.EXO.2.2v3',
  'MS.EXO.3.1v1', 'MS.EXO.4.1v1', 'MS.EXO.4.2v1', 'MS.EXO.4.3v1', 'MS.EXO.4.4v1', 'MS.EXO.5.1v1',
  'MS.EXO.6.1v1', 'MS.EXO.6.2v1', 'MS.EXO.7.1v1', 'MS.EXO.13.1v1',
  'MS.POWERBI.1.1v1', 'MS.POWERBI.2.1v1', 'MS.POWERBI.3.1v1', 'MS.POWERBI.4.1v1', 'MS.POWERBI.4.2v1',
  'MS.POWERBI.5.1v1', 'MS.POWERBI.6.1v1', 'MS.POWERBI.7.1v1', 'MS.POWERPLATFORM.1.1v1', 'MS.POWERPLATFORM.1.2v1',
  'MS.POWERPLATFORM.2.1v1', 'MS.POWERPLATFORM.2.2v1', 'MS.POWERPLATFORM.3.1v1', 'MS.POWERPLATFORM.3.2v1', 'MS.POWERPLATFORM.4.1v1',
  'MS.POWERPLATFORM.5.1v1', 'MS.POWERPLATFORM.6.1v1', 'MS.SECURITYSUITE.1.1v1', 'MS.SECURITYSUITE.1.2v1', 'MS.SECURITYSUITE.1.3v1',
  'MS.SECURITYSUITE.1.4v1', 'MS.SECURITYSUITE.2.1v1', 'MS.SECURITYSUITE.2.2v1', 'MS.SECURITYSUITE.2.3v1', 'MS.SECURITYSUITE.2.4v1',
  'MS.SECURITYSUITE.3.1v1', 'MS.SECURITYSUITE.3.2v1', 'MS.SECURITYSUITE.3.3v1', 'MS.SECURITYSUITE.3.4v1', 'MS.SECURITYSUITE.3.5v1',
  'MS.SECURITYSUITE.4.1v1', 'MS.SECURITYSUITE.4.2v1', 'MS.SECURITYSUITE.5.1v1', 'MS.SECURITYSUITE.5.2v1', 'MS.SECURITYSUITE.6.1v1',
  'MS.SECURITYSUITE.6.2v1', 'MS.SECURITYSUITE.7.1v1', 'MS.SECURITYSUITE.7.2v1', 'MS.SECURITYSUITE.7.3v1', 'MS.SECURITYSUITE.8.1v1',
  'MS.SECURITYSUITE.8.2v1', 'MS.SHAREPOINT.1.1v1', 'MS.SHAREPOINT.1.2v1', 'MS.SHAREPOINT.1.3v1', 'MS.SHAREPOINT.2.1v1',
  'MS.SHAREPOINT.2.2v1', 'MS.SHAREPOINT.3.1v1', 'MS.SHAREPOINT.3.2v1', 'MS.SHAREPOINT.3.3v2', 'MS.TEAMS.1.1v1',
  'MS.TEAMS.1.2v2', 'MS.TEAMS.1.3v1', 'MS.TEAMS.1.4v1', 'MS.TEAMS.1.5v1', 'MS.TEAMS.1.6v1',
  'MS.TEAMS.1.7v2', 'MS.TEAMS.2.1v2', 'MS.TEAMS.2.2v2', 'MS.TEAMS.2.3v2', 'MS.TEAMS.4.1v1',
  'MS.TEAMS.5.1v2', 'MS.TEAMS.5.2v2', 'MS.TEAMS.5.3v2',
]);

// Each SCuBA section in Keel's words. A section not named here shows by its code only.
const SCUBA_AREAS = Object.freeze({
  'MS.AAD.1': 'Entra ID: legacy sign-in',
  'MS.AAD.2': 'Entra ID: risky users and sign-ins',
  'MS.AAD.3': 'Entra ID: strong sign-in (MFA)',
  'MS.AAD.4': 'Entra ID: sign-in and audit logs',
  'MS.AAD.5': 'Entra ID: apps and consent',
  'MS.AAD.6': 'Entra ID: passwords',
  'MS.AAD.7': 'Entra ID: admin roles',
  'MS.AAD.8': 'Entra ID: guest access',
  'MS.AAD.9': 'Entra ID: AI agents',
  'MS.EXO.1': 'Exchange: automatic forwarding',
  'MS.EXO.2': 'Exchange: SPF',
  'MS.EXO.3': 'Exchange: DKIM',
  'MS.EXO.4': 'Exchange: DMARC',
  'MS.EXO.5': 'Exchange: SMTP sign-in',
  'MS.EXO.6': 'Exchange: calendar and contact sharing',
  'MS.EXO.7': 'Exchange: external sender warnings',
  'MS.EXO.13': 'Exchange: mailbox auditing',
  'MS.SECURITYSUITE.1': 'Defender: malware protection',
  'MS.SECURITYSUITE.2': 'Defender: impersonation protection',
  'MS.SECURITYSUITE.3': 'Defender: data loss prevention',
  'MS.SECURITYSUITE.4': 'Defender: alerts',
  'MS.SECURITYSUITE.5': 'Defender: audit logging',
  'MS.SECURITYSUITE.6': 'Defender: inbound spam protection',
  'MS.SECURITYSUITE.7': 'Defender: link protection',
  'MS.SECURITYSUITE.8': 'Defender: IP allow lists',
  'MS.SHAREPOINT.1': 'SharePoint: external sharing',
  'MS.SHAREPOINT.2': 'SharePoint: default sharing links',
  'MS.SHAREPOINT.3': 'SharePoint: anyone links and guest codes',
  'MS.TEAMS.1': 'Teams: meetings',
  'MS.TEAMS.2': 'Teams: external access',
  'MS.TEAMS.4': 'Teams: email into channels',
  'MS.TEAMS.5': 'Teams: apps',
  'MS.POWERPLATFORM.1': 'Power Platform: creating environments',
  'MS.POWERPLATFORM.2': 'Power Platform: data loss prevention',
  'MS.POWERPLATFORM.3': 'Power Platform: tenant isolation',
  'MS.POWERPLATFORM.4': 'Power Platform: content security policy',
  'MS.POWERPLATFORM.5': 'Power Platform: creating Power Pages sites',
  'MS.POWERPLATFORM.6': 'Power Platform: sharing apps',
  'MS.POWERBI.1': 'Power BI: publish to web',
  'MS.POWERBI.2': 'Power BI: guest access',
  'MS.POWERBI.3': 'Power BI: external invitations',
  'MS.POWERBI.4': 'Power BI: service principals',
  'MS.POWERBI.5': 'Power BI: resource key sign-in',
  'MS.POWERBI.6': 'Power BI: Python and R visuals',
  'MS.POWERBI.7': 'Power BI: sensitive data',
});

function scubaArea(ref) {
  const section = ref.replace(/\.\d+v\d+$/, '');
  return { area: section, areaName: SCUBA_AREAS[section] ?? null };
}

// The NIST pack's mappings (tools/qualification/benchmarkLicense.mjs NIST_MAPPINGS; a
// test keeps the two equal). Copied, not imported: that module reads the pinned
// catalogue from disk, which the portal never needs.
export const NIST_REFS = Object.freeze([
  [ADMIN_COUNT, 'ac-6'],
  ['keel-custom.named-location.no-untrusted-all-countries', 'ac-3'],
  [ADMIN_GROUPS, 'ac-2'],
].map(Object.freeze));

const NIST_AREAS = Object.freeze({ AC: 'Access control' });
const byRef = (left, right) => left.ref.localeCompare(right.ref, 'en', { numeric: true });

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * The known baselines, each with every policy Keel lists for it and the checks mapped
 * to it, and `how` says in plain words how its policies are checked. `complete` says whether `refs` is the whole published list (SCuBA's pinned
 * release) or only the policies Keel maps (NIST's catalogue runs to over a thousand).
 */
export const STANDARDS = freeze([
  {
    id: 'cisa-scuba',
    name: 'CISA SCuBA',
    publisher: 'CISA (U.S. Cybersecurity and Infrastructure Security Agency)',
    edition: `ScubaGear v${SCUBA_VERSION}`,
    scope: 'Entra ID, Exchange, Defender, SharePoint, Teams, Power Platform and Power BI policies',
    licence: 'Public domain (CC0)',
    source: `https://github.com/cisagov/ScubaGear/tree/v${SCUBA_VERSION}`,
    how: 'Each policy is checked by CISA\'s own ScubaGear rule, run unchanged on Keel\'s backups.',
    complete: true,
    refs: SCUBA_POLICY_IDS.map((ref) => ({
      ref, ...scubaArea(ref), controls: [{ controlId: `${SCUBA_CONTROL_PREFIX}${ref}`, match: 'full', note: null }],
    })).sort(byRef),
  },
  {
    id: 'nist-800-53',
    name: 'NIST SP 800-53',
    publisher: 'NIST (U.S. National Institute of Standards and Technology)',
    edition: 'Rev 5',
    scope: 'Access control policies Keel maps',
    licence: 'Public domain',
    source: 'https://github.com/usnistgov/oscal-content',
    how: 'Keel\'s own reading of which of its checks cover which control.',
    complete: false,
    refs: NIST_REFS.map(([controlId, ref]) => ({
      ref: ref.toUpperCase(),
      area: ref.split('-')[0].toUpperCase(),
      areaName: NIST_AREAS[ref.split('-')[0].toUpperCase()] ?? null,
      controls: [{ controlId, match: 'partial', note: 'Keel checks one setting this control asks for.' }],
    })).sort(byRef),
  },
]);

export function standardFor(id) {
  return STANDARDS.find((standard) => standard.id === id) ?? null;
}
