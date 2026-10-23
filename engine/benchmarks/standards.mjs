/**
 * Known baselines the Compliance page measures against: which of a published
 * standard's policies Keel's checks cover, and how closely.
 *
 * Only public-domain standards ship, and only as reference codes: CISA SCuBA (CC0, a
 * U.S. government work, pinned at docs/roadmap/benchmark-content/scubagear-pin.json)
 * and NIST SP 800-53 Rev 5 (public domain, pinned beside it). No standard's own text
 * is copied; area names are Keel's words. CIS Benchmarks are left out on purpose:
 * their licence does not allow a commercial product to ship them.
 *
 * A mapping is Keel's own reading of what a check covers, never a claim that meeting
 * it meets the standard. `match` says how close it is: 'full' when the check tests
 * what the policy asks, 'partial' when it tests part of it (the note says which part).
 * A policy no check maps to is listed as not checked, so the gaps show too.
 */
const BLOCK_LEGACY = 'keel-custom.conditional-access.block-legacy';
const ADMIN_COUNT = 'keel-custom.role-assignment.admin-count-at-most';
const ADMIN_GROUPS = 'keel-custom.group.role-assignable-not-synced';

// The Entra ID (aad) and Exchange Online (exo) policies of the pinned ScubaGear commit
// that carry a NIST mapping: exactly the imported profile in
// docs/release/qualifications/scubagear-benchmark-acceptance.artifact.json (a test
// keeps the two equal).
export const SCUBA_COMMIT = '8fd29cb8f1a47f33b8c8b3e304e71fa55117002b';
export const SCUBA_POLICY_IDS = Object.freeze([
  'MS.AAD.1.1v1', 'MS.AAD.2.1v1', 'MS.AAD.2.2v1', 'MS.AAD.2.3v1', 'MS.AAD.3.1v1', 'MS.AAD.3.2v2',
  'MS.AAD.3.3v2', 'MS.AAD.3.4v1', 'MS.AAD.3.5v2', 'MS.AAD.3.6v1', 'MS.AAD.3.7v1', 'MS.AAD.3.8v1',
  'MS.AAD.3.9v1', 'MS.AAD.4.1v1', 'MS.AAD.5.1v1', 'MS.AAD.5.2v1', 'MS.AAD.5.3v1', 'MS.AAD.6.1v1',
  'MS.AAD.7.1v1', 'MS.AAD.7.2v1', 'MS.AAD.7.3v1', 'MS.AAD.7.4v1', 'MS.AAD.7.5v1', 'MS.AAD.7.6v1',
  'MS.AAD.7.7v1', 'MS.AAD.7.8v1', 'MS.AAD.7.9v1', 'MS.AAD.8.1v1', 'MS.AAD.8.2v1', 'MS.AAD.8.3v1',
  'MS.AAD.9.1v1', 'MS.EXO.1.1v2', 'MS.EXO.13.1v1', 'MS.EXO.2.2v3', 'MS.EXO.3.1v1', 'MS.EXO.4.1v1',
  'MS.EXO.4.2v1', 'MS.EXO.4.3v1', 'MS.EXO.4.4v1', 'MS.EXO.5.1v1', 'MS.EXO.6.1v1', 'MS.EXO.6.2v1',
  'MS.EXO.7.1v1',
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
  'MS.EXO.1': 'Exchange: automatic forwarding',
  'MS.EXO.2': 'Exchange: SPF',
  'MS.EXO.3': 'Exchange: DKIM',
  'MS.EXO.4': 'Exchange: DMARC',
  'MS.EXO.5': 'Exchange: SMTP sign-in',
  'MS.EXO.6': 'Exchange: calendar and contact sharing',
  'MS.EXO.7': 'Exchange: external sender warnings',
  'MS.EXO.13': 'Exchange: mailbox auditing',
});

const SCUBA_MAPPINGS = Object.freeze({
  'MS.AAD.1.1v1': [{ controlId: BLOCK_LEGACY, match: 'full', note: null }],
  'MS.AAD.7.1v1': [{ controlId: ADMIN_COUNT, match: 'partial', note: 'Keel checks for at most 5 top admins. SCuBA asks for between 2 and 8.' }],
  'MS.AAD.7.3v1': [{ controlId: ADMIN_GROUPS, match: 'partial', note: 'Keel checks that groups granting admin roles are not copied from on-premises. SCuBA asks the same of the admin accounts themselves.' }],
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
 * to it. `complete` says whether `refs` is the whole published list (SCuBA's pinned
 * profile) or only the policies Keel maps (NIST's catalogue runs to over a thousand).
 */
export const STANDARDS = freeze([
  {
    id: 'cisa-scuba',
    name: 'CISA SCuBA',
    publisher: 'CISA (U.S. Cybersecurity and Infrastructure Security Agency)',
    edition: `ScubaGear ${SCUBA_COMMIT.slice(0, 7)}`,
    scope: 'Entra ID and Exchange Online policies',
    licence: 'Public domain (CC0)',
    source: 'https://github.com/cisagov/ScubaGear',
    complete: true,
    refs: SCUBA_POLICY_IDS.map((ref) => ({ ref, ...scubaArea(ref), controls: SCUBA_MAPPINGS[ref] ?? [] })).sort(byRef),
  },
  {
    id: 'nist-800-53',
    name: 'NIST SP 800-53',
    publisher: 'NIST (U.S. National Institute of Standards and Technology)',
    edition: 'Rev 5',
    scope: 'Access control policies Keel maps',
    licence: 'Public domain',
    source: 'https://github.com/usnistgov/oscal-content',
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
