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
import { classifyForOperation, exportProjection } from '../contracts/fieldProjection.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';

export const BENCHMARK_REGISTRY_CONTRACT_VERSION = 1;

// A predicate returns one of these three — 'unknown' and 'exception' are never
// predicate outputs. 'unknown' is decided upstream of the predicate entirely
// (evaluate.mjs, from missing/stale/future observation evidence — a predicate
// is never even invoked in that case), and 'exception' is a disposition
// recorded against an existing 'fail' evaluation, never a verdict a predicate
// computes (see evaluate.mjs's recordException/effectiveVerdict).
export const PREDICATE_VERDICTS = Object.freeze(['pass', 'fail', 'not-applicable']);
// A predicate may also say why it fails when the setting it looks for does not exist
// at all ("not set up yet"), as opposed to existing with the wrong value. It returns
// { verdict: 'fail', reason: NOT_CONFIGURED }. The stored verdict stays 'fail', so an
// exception can still be granted and every reader that counts fails still counts it.
export const NOT_CONFIGURED = 'not-configured';
export const CONTROL_VERDICTS = Object.freeze(['pass', 'fail', 'unknown', 'not-applicable', 'exception']);
export const PROVENANCE_SOURCES = Object.freeze(['original', 'licensed']);

// Service reads (engine/collect/workloads) a control may rest on. Their stored fields
// are already the read's declared fields only, with credential-shaped values redacted
// at collection (mailFlow.mjs observeObject), so a predicate sees them as stored. Each
// stored object carries its `kind` (the family it was read from).
export const WORKLOAD_FACT_TYPES = Object.freeze(new Set(['exchange-mail-flow']));

const PREDICATES = new Map();
const FIX_MATCHERS = new Map();
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

/**
 * A fix matcher says whether one object (its semantic facts, never the raw
 * payload) is one the control's fix would change. Allowlisted exactly like a
 * predicate: a control can only name a matcher this module's author shipped.
 */
export function registerFixMatcher(name, fn) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('fix matcher requires a non-empty name');
  }
  if (typeof fn !== 'function') {
    throw new TypeError(`${name}: fix matcher must be a function`);
  }
  if (FIX_MATCHERS.has(name)) {
    throw new TypeError(`${name}: fix matcher already registered`);
  }
  FIX_MATCHERS.set(name, fn);
}

export function fixMatcherFor(name) {
  const fn = FIX_MATCHERS.get(name);
  if (!fn) throw new TypeError(`${name}: fix matcher is not allowlisted`);
  return fn;
}

/**
 * "Make it pass": the one setting a failing object needs, written as a
 * one-value restore through the normal dry run and approval. Declared, never
 * computed: the type must be one the control reads, the field a top-level
 * setting Keel may write on update, and the new value plain JSON.
 */
function frozenFix(controlId, fix, requiredObservations) {
  if (fix === null || fix === undefined) return null;
  if (fix.workload !== undefined) return frozenWorkloadFix(controlId, fix, requiredObservations);
  const { resourceType, field, to, matcher } = fix;
  if (!requiredObservations.some((req) => req.resourceType === resourceType)) {
    throw new TypeError(`${controlId}: fix.resourceType must be one the control reads`);
  }
  if (typeof field !== 'string' || field.length === 0 || field.includes('.')) {
    throw new TypeError(`${controlId}: fix.field must name one top-level setting`);
  }
  if (classifyForOperation('update', field, resourceType) !== 'writable') {
    throw new TypeError(`${controlId}: fix.field ${field} is not a setting Keel writes on update`);
  }
  if (!['boolean', 'string', 'number'].includes(typeof to)) {
    throw new TypeError(`${controlId}: fix.to must be a plain value`);
  }
  if (!FIX_MATCHERS.has(matcher)) {
    throw new TypeError(`${controlId}: fix matcher '${matcher}' is not allowlisted — call registerFixMatcher() first`);
  }
  return Object.freeze({ resourceType, field, to, matcher });
}

/**
 * A fix on a service read (the mail protection policies): one of `settings` on one
 * object of `family`, written by that family's declared Set- cmdlet through the
 * workload restore (restore/workloads/cmdletSettings.mjs). Each setting must be one
 * that write declares; `to` is plain JSON, or null to empty a list. The matcher is
 * called with (fact, setting) and says whether that setting of that object fails.
 */
function frozenWorkloadFix(controlId, fix, requiredObservations) {
  const { workload, family, settings, matcher } = fix;
  if (!requiredObservations.some((req) => req.resourceType === workload && (req.parts ?? []).includes(family))) {
    throw new TypeError(`${controlId}: fix.family must be a kind of a service read the control reads`);
  }
  const write = Object.values(WKLD_WRITE_OPERATIONS).find((entry) => entry.workload === workload && entry.family === family && entry.method.startsWith('Set-'));
  if (!write) throw new TypeError(`${controlId}: Keel declares no write for ${family}`);
  if (!settings || typeof settings !== 'object' || Object.keys(settings).length === 0) {
    throw new TypeError(`${controlId}: fix.settings must name at least one setting`);
  }
  for (const [field, to] of Object.entries(settings)) {
    if (!write.fields.includes(field)) throw new TypeError(`${controlId}: fix setting ${field} is not one ${write.method} is declared to write`);
    if (to !== null && !['boolean', 'string', 'number'].includes(typeof to)) {
      throw new TypeError(`${controlId}: fix setting ${field} must be a plain value or null`);
    }
  }
  if (!FIX_MATCHERS.has(matcher)) {
    throw new TypeError(`${controlId}: fix matcher '${matcher}' is not allowlisted — call registerFixMatcher() first`);
  }
  return Object.freeze({ workload, family, resourceType: write.resourceType, settings: Object.freeze({ ...settings }), matcher });
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
  fix = null,
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
    // `parts`: for a service read that holds several kinds (the mail protection read
    // holds anti-spam, anti-phishing, malware and Safe Links policies...), the kinds this
    // control needs. The read counts as complete when each of these kinds was read in
    // full, whatever happened to the others.
    if (req.parts !== undefined) {
      if (!WORKLOAD_FACT_TYPES.has(req.resourceType)) {
        throw new TypeError(`${controlId}: requiredObservations.parts is only for a service read (${[...WORKLOAD_FACT_TYPES].join(', ')})`);
      }
      if (!Array.isArray(req.parts) || req.parts.length === 0 || req.parts.some((part) => typeof part !== 'string' || part.length === 0)) {
        throw new TypeError(`${controlId}: requiredObservations.parts must name at least one kind`);
      }
      return Object.freeze({ resourceType: req.resourceType, maxAgeMs: req.maxAgeMs, parts: Object.freeze([...req.parts]) });
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
    fix: frozenFix(controlId, fix, frozenRequired),
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
  if (WORKLOAD_FACT_TYPES.has(resourceType)) return structuredClone(rawResource);
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
  const ok = count <= limit;
  return {
    verdict: ok ? 'pass' : 'fail',
    details: [{ subject: args?.roleName ?? 'Admin role', setting: 'assignmentCount', value: count, expected: { atMost: limit }, ok }],
  };
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
    args: { roleDefinitionId: '62e90394-69f5-4237-9190-012177145e10', roleName: 'Global Administrator', limit: 5 },
  },
});

// The name a detail line gives one directory object: its display name, never its id
// (the line is shown on the page).
function objectName(fact, fallback) {
  return typeof fact?.displayName === 'string' && fact.displayName.length > 0 ? fact.displayName : fallback;
}

registerPredicate('named-location-no-untrusted-all-countries', (facts) => {
  if (facts.length === 0) return 'not-applicable';
  // Only a trusted location can make this fail, so each trusted one is a checked line.
  const details = facts.filter((fact) => fact.isTrusted === true).map((fact) => {
    const value = fact.includeUnknownCountriesAndRegions === true;
    return { subject: objectName(fact, 'Unnamed location'), setting: 'includeUnknownCountriesAndRegions', value, expected: false, ok: !value };
  });
  return { verdict: details.some((line) => !line.ok) ? 'fail' : 'pass', details };
});

registerFixMatcher('named-location-trusts-unknown-countries', (fact) => (
  fact.isTrusted === true && fact.includeUnknownCountriesAndRegions === true
));

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
  // Narrowing the location (no unknown countries) keeps every listed country
  // trusted and is the smaller change than dropping the trust altogether.
  fix: {
    resourceType: 'namedLocation',
    field: 'includeUnknownCountriesAndRegions',
    to: false,
    matcher: 'named-location-trusts-unknown-countries',
  },
});

registerPredicate('group-role-assignable-not-synced', (facts) => {
  if (facts.length === 0) return 'not-applicable';
  // Only a role-assignable group can make this fail, so each one is a checked line. A
  // cloud-only group has no sync flag at all (null): it is not synchronized.
  const details = facts.filter((fact) => fact.isAssignableToRole === true).map((fact) => {
    const value = fact.onPremisesSyncEnabled === true;
    return { subject: objectName(fact, 'Unnamed group'), setting: 'onPremisesSyncEnabled', value, expected: false, ok: !value };
  });
  return { verdict: details.some((line) => !line.ok) ? 'fail' : 'pass', details };
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

// --- Defender email protection ----------------------------------------------
// Original controls over the mail protection policies Keel already backs up (the
// exchange-mail-flow service read, engine/collect/workloads/mailFlow.mjs): anti-
// phishing, anti-spam, malware and Safe Links. The settings checked follow
// Microsoft's own published recommendations; the wording is Keel's. Each looks at
// every policy of its kind, because any policy can be the one a mailbox gets, and
// records each policy and setting it checked, with its value and what it should be.

const MAIL_PROTECTION = 'exchange-mail-flow';
// The service read runs once a day (store/scheduleSeed.mjs workload-collect), so a
// read up to a day and a half old still counts.
const MAIL_PROTECTION_MAX_AGE_MS = 36 * 60 * 60 * 1000;

// `fixTo` is the value "Make it pass" writes. An empty list is written as null, the
// documented way to clear one, and reads back as an empty list.
const isOn = Object.freeze({ test: (value) => value === true, expected: true, fixTo: true });
const isOff = Object.freeze({ test: (value) => value === false, expected: false, fixTo: false });
const isEmpty = Object.freeze({ test: (value) => Array.isArray(value) && value.length === 0, expected: [], fixTo: null });
const is = (word) => Object.freeze({
  test: (value) => typeof value === 'string' && value.toLowerCase() === word.toLowerCase(),
  expected: word,
  fixTo: word,
});

function policyName(fact) {
  if (typeof fact?.Name === 'string' && fact.Name.length > 0) return fact.Name;
  return typeof fact?.identity === 'string' ? fact.identity : 'Unnamed policy';
}

/**
 * Checks each policy of `kind` against `settings` ({ field: rule }). Not applicable
 * when the tenant has no policy of that kind (Safe Links without Defender for Office
 * 365); fails when any setting of any policy misses its rule. Every setting checked
 * is a detail line, passing or not, so the page can show expected against current.
 */
function checkPolicies(facts, { kind, settings, applies = () => true }) {
  const policies = facts.filter((fact) => fact?.kind === kind && applies(fact));
  if (policies.length === 0) return { verdict: 'not-applicable', details: [] };
  const details = [];
  for (const policy of policies) {
    for (const [setting, rule] of Object.entries(settings)) {
      const value = policy[setting];
      details.push({ subject: policyName(policy), setting, value: value ?? null, expected: rule.expected, ok: rule.test(value) });
    }
  }
  return { verdict: details.some((line) => !line.ok) ? 'fail' : 'pass', details };
}

function mailControl({ controlId, kind, title, description, severity, settings, applies = () => true }) {
  const predicateName = `${MAIL_PROTECTION}.${controlId.slice(controlId.lastIndexOf('.') + 1)}`;
  registerPredicate(predicateName, (facts) => checkPolicies(facts, { kind, settings, applies }));
  // "Make it pass": each failing setting of each policy the check looks at can be set
  // to what the check expects, one setting at a time.
  registerFixMatcher(predicateName, (fact, setting) => (
    fact?.kind === kind && applies(fact) && Boolean(settings[setting]) && !settings[setting].test(fact[setting])
  ));
  registerControl({
    controlId,
    title,
    description,
    framework: 'keel-custom',
    edition: '1.0.0',
    profile: 'default',
    evaluatorVersion: 1,
    severity,
    requiredObservations: [{ resourceType: MAIL_PROTECTION, maxAgeMs: MAIL_PROTECTION_MAX_AGE_MS, parts: [kind] }],
    predicate: { name: predicateName, args: {} },
    fix: {
      workload: MAIL_PROTECTION,
      family: kind,
      settings: Object.fromEntries(Object.entries(settings).map(([field, rule]) => [field, rule.fixTo])),
      matcher: predicateName,
    },
  });
}

mailControl({
  controlId: 'keel-custom.defender-email.anti-phish-spoof-protection',
  kind: 'antiPhishPolicy',
  title: 'Anti-phishing policies catch spoofed senders',
  description: 'Fails when an anti-phishing policy that is turned on (or the default '
    + 'policy) has spoof intelligence off (EnableSpoofIntelligence), ignores the '
    + "sender domain's DMARC policy (HonorDmarcPolicy), or does not mark unverified "
    + 'senders (EnableUnauthenticatedSender). An original check; not applicable when '
    + 'the tenant has no anti-phishing policy.',
  severity: 'high',
  settings: { EnableSpoofIntelligence: isOn, HonorDmarcPolicy: isOn, EnableUnauthenticatedSender: isOn },
  applies: (policy) => policy.IsDefault === true || policy.Enabled !== false,
});

mailControl({
  controlId: 'keel-custom.defender-email.anti-spam-phish-quarantined',
  kind: 'antiSpamPolicy',
  title: 'Anti-spam policies quarantine phishing',
  description: 'Fails when an anti-spam policy delivers phishing or high-confidence '
    + 'phishing anywhere but quarantine (PhishSpamAction, HighConfidencePhishAction), '
    + 'or does not pull phishing back out of mailboxes after delivery (PhishZapEnabled). '
    + 'An original check; not applicable when the tenant has no anti-spam policy.',
  severity: 'high',
  settings: { PhishSpamAction: is('Quarantine'), HighConfidencePhishAction: is('Quarantine'), PhishZapEnabled: isOn },
});

mailControl({
  controlId: 'keel-custom.defender-email.anti-spam-no-allowed-domains',
  kind: 'antiSpamPolicy',
  title: 'No anti-spam policy lets whole sender domains skip filtering',
  description: 'Fails when an anti-spam policy lists allowed sender domains '
    + '(AllowedSenderDomains): mail from those domains, including spoofed mail, skips '
    + 'spam filtering. An original check; not applicable when the tenant has no '
    + 'anti-spam policy.',
  severity: 'medium',
  settings: { AllowedSenderDomains: isEmpty },
});

mailControl({
  controlId: 'keel-custom.defender-email.malware-file-filter',
  kind: 'antiMalwarePolicy',
  title: 'Malware policies block risky attachment types',
  description: 'Fails when a malware policy has the common attachments filter off '
    + '(EnableFileFilter) or does not pull malware back out of mailboxes after '
    + 'delivery (ZapEnabled). An original check; not applicable when the tenant has no '
    + 'malware policy.',
  severity: 'high',
  settings: { EnableFileFilter: isOn, ZapEnabled: isOn },
});

mailControl({
  controlId: 'keel-custom.defender-email.safe-links-email',
  kind: 'safeLinksPolicy',
  title: 'Safe Links checks links in email',
  description: 'Fails when a Safe Links policy does not check links in email '
    + '(EnableSafeLinksForEmail), does not scan them when clicked (ScanUrls), or lets '
    + 'people click through a warning to a malicious site (AllowClickThrough). An '
    + 'original check; not applicable when the tenant has no Safe Links policy, as '
    + 'without Defender for Office 365.',
  severity: 'medium',
  settings: { EnableSafeLinksForEmail: isOn, ScanUrls: isOn, AllowClickThrough: isOff },
});

// Blocking legacy authentication: an enabled Conditional Access policy that blocks
// both legacy client app types (Exchange ActiveSync and other clients). A policy that
// would do this but is off, report-only or misses one of the two fails; no such
// policy at all is "not set up yet".
const LEGACY_CLIENTS = ['exchangeActiveSync', 'other'];

function blocksLegacy(fact) {
  const clients = fact?.conditions?.clientAppTypes;
  const controls = fact?.grantControls?.builtInControls;
  return Array.isArray(clients) && Array.isArray(controls) && controls.includes('block')
    && clients.some((client) => LEGACY_CLIENTS.includes(client));
}

registerPredicate('conditional-access-block-legacy', (facts) => {
  const candidates = facts.filter(blocksLegacy);
  if (candidates.length === 0) return { verdict: 'fail', reason: NOT_CONFIGURED };
  const enforced = candidates.some((fact) => fact.state === 'enabled'
    && LEGACY_CLIENTS.every((client) => fact.conditions.clientAppTypes.includes(client)));
  return enforced ? 'pass' : 'fail';
});

registerControl({
  controlId: 'keel-custom.conditional-access.block-legacy',
  title: 'Legacy authentication is blocked',
  description: 'Passes when an enabled conditionalAccessPolicy blocks both legacy '
    + 'client app types (exchangeActiveSync and other). Fails when such a '
    + 'policy is disabled, report-only or covers only one of them, and is '
    + 'recorded as not configured when no policy blocks legacy clients at '
    + 'all. An original check.',
  framework: 'keel-custom',
  edition: '1.0.0',
  profile: 'default',
  evaluatorVersion: 1,
  severity: 'high',
  requiredObservations: [{ resourceType: 'conditionalAccessPolicy', maxAgeMs: 6 * 60 * 60 * 1000 }],
  predicate: { name: 'conditional-access-block-legacy', args: {} },
});
