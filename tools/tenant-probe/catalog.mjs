/**
 * M1-scope resource catalog: Entra ID and Intune.
 *
 * This is the read-side of the adapter contract in spec §7, reduced to what a
 * measurement pass needs. `criticality` and `blastRadius` are the spec's
 * declared values, carried here so the probe can report scale per tier rather
 * than as one undifferentiated object count.
 *
 * `pageCap` bounds collections that can run to tens of thousands of objects.
 * Where a cap is set the probe still reports the true total via $count, so a
 * capped enumeration yields an accurate size with a sampled payload.
 *
 * Entries live in catalog.d/, one file per family, so families can change in
 * parallel. CATALOG is the families in the order below; a new family adds one
 * import and one spread.
 */
import tenant from './catalog.d/tenant.mjs';
import principals from './catalog.d/principals.mjs';
import identity from './catalog.d/identity.mjs';
import rbac from './catalog.d/rbac.mjs';
import conditionalAccess from './catalog.d/conditional-access.mjs';
import policies from './catalog.d/policies.mjs';
import intune from './catalog.d/intune.mjs';
import entraGovernance from './catalog.d/entra-governance.mjs';
import intuneExtended from './catalog.d/intune-extended.mjs';

export const CATALOG = [
  ...tenant,
  ...principals,
  ...identity,
  ...rbac,
  ...conditionalAccess,
  ...policies,
  ...intune,
  ...entraGovernance,
  ...intuneExtended,
];

/** Directory object types whose ids other resources reference by GUID. */
export const REFERENCEABLE_TYPES = new Set([
  'user',
  'group',
  'application',
  'servicePrincipal',
  'administrativeUnit',
  'roleDefinition',
  'namedLocation',
  'deviceCompliancePolicy',
  'deviceConfiguration',
  'domain',
  'subscribedSku',
]);

const CATALOG_BY_TYPE = new Map(CATALOG.map((entry) => [entry.type, entry]));

/**
 * The read path for a catalogue entry: its $select and any fixed query
 * (roadmap task-151: a scope filter or an $expand). `basePath` defaults to the
 * entry's path; the organization placeholder is resolved by the caller.
 */
export function catalogReadPath(entry, basePath = entry.path) {
  const query = [entry.select ? `$select=${entry.select}` : null, entry.query ?? null].filter(Boolean);
  return query.length > 0 ? `${basePath}?${query.join('&')}` : basePath;
}

/**
 * The catalogue entry for a resource type, or null when the type is not part
 * of the measured estate. engine/coverage/diagnosis.mjs registers feature
 * prerequisites through this lookup so a prerequisite is always source-linked
 * to a real measured endpoint — never to a type string nothing collects.
 */
export function catalogEntryFor(type) {
  return CATALOG_BY_TYPE.get(type) ?? null;
}
