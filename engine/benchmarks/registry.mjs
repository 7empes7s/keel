/**
 * Versioned benchmark control registry (roadmap task-85).
 *
 * A control names a framework/edition/profile identity, an evaluator version,
 * the observations it requires and an allowlisted predicate — never inline or
 * dynamically constructed code. Four rules are enforced here, non-negotiably:
 *
 * 1. A predicate is a plain function registered ahead of time through
 *    registerPredicate(); registerControl() refuses any control whose
 *    predicate.name is not already in the allowlist. There is no eval(),
 *    Function() construction, or string-keyed dispatch to arbitrary code —
 *    a control can only reference behavior this module's author shipped.
 * 2. A control's predicate never sees a raw collected payload. evaluate.mjs
 *    builds predicate input exclusively through semanticFacts(), which
 *    reprojects through engine/contracts/fieldProjection.mjs's
 *    exportProjection() (task-51 field-projection machinery) — every field a
 *    type's review marked sensitiveExport (on-prem AD correlation
 *    identifiers, internal HR ids, ...) is excluded before a predicate ever
 *    runs. Unlike a hash/PATCH projection, this deliberately keeps
 *    server-managed status fields (onPremisesSyncEnabled, isAssignableToRole,
 *    ...) intact — a benchmark predicate reasons about the resource's actual
 *    configuration state, not just what a caller could write back to it.
 * 3. frameworkRefs is a mapping of reference codes only (framework/edition/
 *    profile/ref) — never descriptive or normative text copied from a
 *    licensed benchmark document. A control may cite several framework
 *    references at once without that mapping being (or implying) a legal
 *    compliance claim; nothing in this module or its result shape exposes a
 *    "compliant" field. A control whose provenance.source is 'licensed' must
 *    carry a recorded rightsEvidence citation or registration is refused —
 *    licensed text is never embedded speculatively.
 * 4. The controls this module ships by default are original, hand-written
 *    fixtures with empty frameworkRefs — no CIS (or other licensed
 *    benchmark) text or section numbering is embedded anywhere in this repo.
 *    The multi-framework-reference capability itself is real and tested
 *    (see engine/roadmap/benchmark-engine.test.mjs), but exercised against
 *    synthetic example framework names, never asserted against real CIS
 *    content this project holds no rights to reproduce.
 */
import { exportProjection } from '../contracts/fieldProjection.mjs';

export const BENCHMARK_REGISTRY_CONTRACT_VERSION = 1;

// A predicate returns one of these three — 'unknown' and 'exception' are never
// predicate outputs. 'unknown' is decided upstream of the predicate entirely
// (evaluate.mjs, from missing/stale/future observation evidence — a predicate
// is never even invoked in that case), and 'exception' is a disposition
// recorded against an existing 'fail' evaluation, never a verdict a predicate
// computes (see evaluate.mjs's recordException/effectiveVerdict).
export const PREDICATE_VERDICTS = Object.freeze(['pass', 'fail', 'not-applicable']);
export const CONTROL_VERDICTS = Object.freeze(['pass', 'fail', 'unknown', 'not-applicable', 'exception']);
export const PROVENANCE_SOURCES = Object.freeze(['original', 'licensed']);

const PREDICATES = new Map();
const CONTROLS = new Map();

/** The only way a predicate becomes callable from a control (rule 1 above). */
export function registerPredicate(name, fn) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('predicate requires a non-empty name');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`${name}: predicate must be a function`);
  }
  if (PREDICATES.has(name)) {
    throw new TypeError(`${name}: predicate already registered`);
  }
  PREDICATES.set(name, fn);
}

export function predicateFor(name) {
  const fn = PREDICATES.get(name);
  if (!fn) throw new TypeError(`${name}: predicate is not allowlisted`);
  return fn;
}

function frozenFrameworkRef(ref) {
  if (typeof ref?.framework !== 'string' || ref.framework.length === 0
    || typeof ref?.ref !== 'string' || ref.ref.length === 0) {
    throw new TypeError("frameworkRefs entries require non-empty { framework, ref }");
  }
  return Object.freeze({
    framework: ref.framework,
    edition: typeof ref.edition === 'string' && ref.edition.length > 0 ? ref.edition : null,
    profile: typeof ref.profile === 'string' && ref.profile.length > 0 ? ref.profile : null,
    ref: ref.ref,
  });
}

/**
 * Declares one benchmark control. `framework`/`edition`/`profile` identify
 * the benchmark this control itself belongs to (Keel's own custom benchmark
 * by default); `evaluatorVersion` is bumped whenever this control's
 * predicate logic changes meaning, so a stored evaluation always names the
 * exact logic that produced it (the same pinning discipline task-51 applies
 * to field-projection versions).
 */
export function registerControl({
  controlId, title, description, framework, edition, profile, evaluatorVersion,
  requiredObservations, predicate, frameworkRefs = [], provenance = { source: 'original' }, severity = 'medium',
}) {
  if (typeof controlId !== 'string' || controlId.length === 0) {
    throw new TypeError('control requires a non-empty controlId');
  }
  if (CONTROLS.has(controlId)) {
    throw new TypeError(`${controlId}: control already registered`);
  }
  if (typeof title !== 'string' || title.length === 0 || typeof description !== 'string' || description.length === 0) {
    throw new TypeError(`${controlId}: title and description are required (original wording, never copied benchmark text)`);
  }
  if (typeof framework !== 'string' || framework.length === 0
    || typeof edition !== 'string' || edition.length === 0
    || typeof profile !== 'string' || profile.length === 0) {
    throw new TypeError(`${controlId}: framework, edition and profile are required`);
  }
  if (!Number.isInteger(evaluatorVersion) || evaluatorVersion < 1) {
    throw new TypeError(`${controlId}: evaluatorVersion must be a positive integer`);
  }
  if (!Array.isArray(requiredObservations) || requiredObservations.length === 0) {
    throw new TypeError(`${controlId}: requiredObservations must name at least one resourceType`);
  }
  const frozenRequired = requiredObservations.map((req) => {
    if (typeof req?.resourceType !== 'string' || req.resourceType.length === 0) {
      throw new TypeError(`${controlId}: requiredObservations entries need a resourceType`);
    }
    if (!Number.isInteger(req.maxAgeMs) || req.maxAgeMs <= 0) {
      throw new TypeError(`${controlId}: requiredObservations.maxAgeMs must be a positive integer`);
    }
    return Object.freeze({ resourceType: req.resourceType, maxAgeMs: req.maxAgeMs });
  });
  if (!PREDICATES.has(predicate?.name)) {
    throw new TypeError(`${controlId}: predicate '${predicate?.name}' is not allowlisted — call registerPredicate() first`);
  }
  if (!PROVENANCE_SOURCES.includes(provenance?.source)) {
    throw new TypeError(`${controlId}: provenance.source must be one of ${PROVENANCE_SOURCES.join(', ')}`);
  }
  // Rule 3/4: licensed source material is never embedded speculatively — a
  // control claiming a licensed source must cite recorded rights evidence.
  if (provenance.source === 'licensed'
    && (typeof provenance.rightsEvidence !== 'string' || provenance.rightsEvidence.length === 0)) {
    throw new TypeError(`${controlId}: a licensed-source control requires provenance.rightsEvidence — never embed licensed benchmark text without recorded rights`);
  }

  CONTROLS.set(controlId, Object.freeze({
    contractVersion: BENCHMARK_REGISTRY_CONTRACT_VERSION,
    controlId,
    title,
    description,
    framework,
    edition,
    profile,
    evaluatorVersion,
    requiredObservations: Object.freeze(frozenRequired),
    predicate: Object.freeze({ name: predicate.name, args: Object.freeze({ ...(predicate.args ?? {}) }) }),
    frameworkRefs: Object.freeze((frameworkRefs ?? []).map(frozenFrameworkRef)),
    provenance: Object.freeze({ ...provenance }),
    severity,
  }));
}

export function controlFor(controlId) {
  return CONTROLS.get(controlId) ?? null;
}

export function listControls({ framework, edition, profile } = {}) {
  return [...CONTROLS.values()].filter((control) => (
    (!framework || control.framework === framework)
    && (!edition || control.edition === edition)
    && (!profile || control.profile === profile)
  ));
}

/**
 * The only way a predicate sees resource data (rule 2 above): reprojected
 * through task-51's exportProjection(), which excludes every field the
 * type's review named sensitiveExport. Never hand a predicate the raw
 * collected payload directly.
 */
export function semanticFacts(resourceType, rawResource) {
  return exportProjection(rawResource, resourceType);
}

// --- Original custom-control fixtures --------------------------------------
// No CIS (or other licensed benchmark) text or section numbering appears
// anywhere below — these are hand-written, original controls scoped to
// fields engine/contracts/fieldProjection.mjs already reviewed for the six
// M1 types. frameworkRefs is empty: nothing here claims to implement or map
// to any external benchmark's numbering.

registerPredicate('role-assignment-admin-count-at-most', (facts, args) => {
  const roleDefinitionId = args?.roleDefinitionId;
  if (typeof roleDefinitionId !== 'string' || roleDefinitionId.length === 0) {
    throw new TypeError('role-assignment-admin-count-at-most requires args.roleDefinitionId');
  }
  const limit = Number.isInteger(args?.limit) ? args.limit : 5;
  const count = facts.filter((fact) => fact.roleDefinitionId === roleDefinitionId).length;
  return count <= limit ? 'pass' : 'fail';
});

registerControl({
  controlId: 'keel-custom.role-assignment.admin-count-at-most',
  title: 'Global Administrator assignment count stays at or below a set limit',
  description: 'Counts active roleAssignment records against a named admin role '
    + 'definition and fails when more than the configured limit hold it — an '
    + 'original least-privilege sprawl check, not a reproduction of any '
    + 'licensed benchmark control.',
  framework: 'keel-custom',
  edition: '1.0.0',
  profile: 'default',
  evaluatorVersion: 1,
  severity: 'high',
  requiredObservations: [{ resourceType: 'roleAssignment', maxAgeMs: 6 * 60 * 60 * 1000 }],
  predicate: {
    name: 'role-assignment-admin-count-at-most',
    // 62e90394-69f5-4237-9190-012177145e10 is the Microsoft-global Global
    // Administrator directory role template id (same basis as
    // engine/coverage/diagnosis.mjs's ROLE_TEMPLATES), not tenant-specific.
    args: { roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', limit: 5 },
  },
});

registerPredicate('named-location-no-untrusted-all-countries', (facts) => {
  if (facts.length === 0) return 'not-applicable';
  const risky = facts.some((fact) => fact.isTrusted === true && fact.includeUnknownCountriesAndRegions === true);
  return risky ? 'fail' : 'pass';
});

registerControl({
  controlId: 'keel-custom.named-location.no-untrusted-all-countries',
  title: 'No named location marks unknown-country traffic as trusted',
  description: 'Fails when any namedLocation is simultaneously flagged trusted '
    + '(isTrusted) and configured to include unknown countries/regions '
    + '(includeUnknownCountriesAndRegions) — a combination that treats '
    + 'traffic from an unresolvable location as trusted network origin. '
    + 'An original check; not-applicable when the tenant defines no named '
    + 'locations at all.',
  framework: 'keel-custom',
  edition: '1.0.0',
  profile: 'default',
  evaluatorVersion: 1,
  severity: 'medium',
  requiredObservations: [{ resourceType: 'namedLocation', maxAgeMs: 6 * 60 * 60 * 1000 }],
  predicate: { name: 'named-location-no-untrusted-all-countries', args: {} },
});

registerPredicate('group-role-assignable-not-synced', (facts) => {
  if (facts.length === 0) return 'not-applicable';
  const risky = facts.some((fact) => fact.isAssignableToRole === true && fact.onPremisesSyncEnabled === true);
  return risky ? 'fail' : 'pass';
});

registerControl({
  controlId: 'keel-custom.group.role-assignable-not-synced',
  title: 'Role-assignable groups are not synchronized from on-premises AD',
  description: 'Fails when any group is both role-assignable (isAssignableToRole) '
    + 'and synchronized from on-premises AD (onPremisesSyncEnabled) — an '
    + 'on-prem compromise of such a group would escalate directly to a '
    + 'cloud directory role. An original check; not-applicable when the '
    + 'tenant has no groups.',
  framework: 'keel-custom',
  edition: '1.0.0',
  profile: 'default',
  evaluatorVersion: 1,
  severity: 'high',
  requiredObservations: [{ resourceType: 'group', maxAgeMs: 6 * 60 * 60 * 1000 }],
  predicate: { name: 'group-role-assignable-not-synced', args: {} },
});
