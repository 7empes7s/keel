/**
 * Security audit run 1, finding 2: a named location decides which networks and
 * countries Conditional Access trusts, and live policies that name it change
 * who can sign in from where. A backup that was changed, or is simply older
 * than live, could trust a wider range than the admins chose. So a restore
 * never changes these fields on an existing location, and never creates a
 * trusted one: the difference is reported as a step for a person to check and
 * set by hand.
 *
 * A new untrusted location is still created with its ranges or countries: no
 * live policy can name an object that does not exist yet, and every
 * Conditional Access policy a restore writes is report-only.
 */
export const NAMED_LOCATION_TRUST_FIELDS = Object.freeze([
  'isTrusted', 'ipRanges', 'countriesAndRegions', 'includeUnknownCountriesAndRegions',
  // Whether a country comes from the client IP or the Authenticator app's GPS.
  'countryLookupMethod',
]);

const PORTAL_PATH = 'Entra admin center > Protection > Conditional Access > Named locations';

// Absent, null, false and an empty list read the same: Graph's defaults.
function comparable(value) {
  if (value === undefined || value === null || value === false) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => JSON.stringify(withoutAnnotations(item))).sort();
  }
  return withoutAnnotations(value);
}

function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !key.startsWith('@odata.')).sort()
    .map((key) => [key, withoutAnnotations(value[key])]));
}

const same = (left, right) => JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));

/** The trust fields the backup would change on the live location (on a create: a trusted location). */
export function namedLocationTrustChanges(resource, verb) {
  if (resource?.resourceType !== 'namedLocation') return [];
  const desired = resource.payload ?? {};
  if (verb === 'create') return desired.isTrusted === true ? ['isTrusted'] : [];
  if (verb !== 'update') return [];
  const live = resource.live?.payload ?? null;
  return NAMED_LOCATION_TRUST_FIELDS.filter((field) => Object.hasOwn(desired, field)
    && (!live || !same(desired[field], live[field])));
}

/**
 * Null when the write may go ahead, otherwise a skip with a manual step.
 *
 * A compliance fix is the one exception: it is planned from the live object,
 * changes one setting to the value its control declares, and needs its own
 * approval. Only that exact change is let through.
 */
export function namedLocationTrustRefusal(resource, verb) {
  const changes = namedLocationTrustChanges(resource, verb);
  if (changes.length === 0) return null;
  const fix = resource.complianceFix;
  if (verb === 'update' && fix?.resourceType === 'namedLocation' && fix.naturalKey === resource.naturalKey && changes.length === 1
    && changes[0] === fix.field && same(resource.payload[fix.field], fix.to)) {
    return null;
  }
  const name = resource.payload?.displayName ?? resource.naturalKey;
  const description = verb === 'create'
    ? `The backup marks the named location "${name}" as trusted. A restore never creates a trusted location, so a changed backup cannot `
      + `make Conditional Access trust a network. Create it by hand in ${PORTAL_PATH} after checking its ranges, then restore the policies that use it.`
    : `The named location "${name}" in the backup differs from the tenant in ${changes.join(', ')}. A restore never changes which networks `
      + `or countries Conditional Access trusts, so a changed or older backup cannot widen them. Check the values, then set them by hand in ${PORTAL_PATH}.`;
  return {
    reason: `manual: ${description}`,
    completion: [{ kind: 'manual-setting', requirement: 'namedLocationTrust', fields: changes, portalPath: PORTAL_PATH, description }],
  };
}

/**
 * Whether a named location this run wrote still trusts what it did before:
 * every trust field reads back as before (a new location: untrusted), except
 * the one setting an approved compliance fix changed to its declared value.
 * `before` and `after` are the raw items the sign-in path gate read.
 */
export function namedLocationTrustKept(before, after, complianceFix = null) {
  if (!after) return false;
  if (!before) return after.isTrusted !== true;
  return NAMED_LOCATION_TRUST_FIELDS.every((field) => (complianceFix?.field === field
    ? same(after[field], complianceFix.to)
    : same(before[field], after[field])));
}

/**
 * An update body with the trust fields left out (all but the one setting an
 * approved compliance fix changes). Other resource types pass through.
 */
export function withoutNamedLocationTrust(body, resource) {
  if (resource?.resourceType !== 'namedLocation' || !body || typeof body !== 'object') return body;
  const kept = resource.complianceFix?.field;
  return Object.fromEntries(Object.entries(body).filter(([field]) => field === kept || !NAMED_LOCATION_TRUST_FIELDS.includes(field)));
}
