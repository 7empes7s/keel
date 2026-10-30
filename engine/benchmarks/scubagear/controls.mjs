/**
 * CISA ScubaGear's rules as Keel controls: one control per rule of each product Keel
 * runs (the products compiled into build/rules.wasm), all through one predicate,
 * `scuba-rego`, that takes the rule id as data. No rule is mapped by hand: what a rule
 * reads comes from its Rego (import.mjs), how Keel builds each input from adapters.mjs.
 *
 * Every rule gets one of four answers, the way ScubaGear's own report gives them:
 *  - pass: the rule says the requirement is met;
 *  - fail: it is not met (ScubaGear's "Fail", and its "Warning" for a SHOULD rule);
 *  - not-applicable: the rule itself says it does not apply here (ScubaGear's N/A);
 *  - unknown ("could not check"), never a pass, when:
 *      - CISA marks the rule as a manual check (scubagear:check-by-hand);
 *      - it reads data Keel does not collect (scubagear:not-read:<input>);
 *      - its code names a field Keel's read of that input does not keep
 *        (scubagear:field-not-read:<input>.<field>);
 *      - a backup it needs is missing, too old or incomplete (the usual reasons);
 *      - the backup cannot answer what it asks (scubagear:incomplete:<input>);
 *      - it gave no result, or the rule runner could not load or failed (scubagear:no-result,
 *        scubagear:runner-unavailable, scubagear:runner-error).
 *
 * The verdicts feed the Compliance page and its score like every other control; the
 * score leaves "could not check" out.
 */
import { createHash } from 'node:crypto';
import { PREDICATE_UNKNOWN_PREFIX, WORKLOAD_FACT_TYPES, registerControl, registerPredicate } from '../registry.mjs';
import { ADAPTERS, buildInput } from './adapters.mjs';
import { configHasList, DEFAULT_SCUBA_CONFIG, listForRule } from './config.mjs';
import { importScubaGearRules, openPinnedScubaGear } from './import.mjs';
import { SCUBA_INPUT_SOURCES } from './inputs.mjs';
import { readBuild, scubaRules } from './opa.mjs';
import { regoRuleInputs } from './rego.mjs';

export const SCUBA_PREDICATE = 'scuba-rego';
export const SCUBA_FRAMEWORK = 'cisa-scuba';
export const SCUBA_CONTROL_PREFIX = 'scubagear.';
// ScubaGear config sections that hold per-rule lists a tenant sets (config.mjs).
const CONFIG_SECTIONS = Object.freeze(['SecuritySuite', 'Defender']);
const REASON = (code) => `${PREDICATE_UNKNOWN_PREFIX}${code}`;
const SETTING_STATES = new Set(['run-setting', 'run-status']);

// --- Turning ScubaGear's result into Keel's ----------------------------------------

/** ScubaGear's report text as plain words: no markup, no object ids, kept short. */
export function plainDetails(text) {
  if (typeof text !== 'string') return null;
  const plain = text
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '(id)')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 400 ? `${plain.slice(0, 399)}…` : plain;
}

/** CreateReport.psm1's order: met is a pass; a manual or third-party rule is N/A; else a fail. */
export function verdictOf(result) {
  if (result.RequirementMet === true) return 'pass';
  if (/(Not-Implemented|3rd Party)$/.test(String(result.Criticality ?? ''))) return 'not-applicable';
  return 'fail';
}

// The rules are run once per distinct input document; several controls share one.
const RESULTS = new Map();
const RESULT_CACHE_SIZE = 16;
function resultsFor(product, document) {
  const key = `${product}:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`;
  if (!RESULTS.has(key)) {
    RESULTS.set(key, scubaRules().evaluate(`${product}/tests`, document) ?? []);
    if (RESULTS.size > RESULT_CACHE_SIZE) RESULTS.delete(RESULTS.keys().next().value);
  }
  return RESULTS.get(key);
}

registerPredicate(SCUBA_PREDICATE, (facts, args, context = {}) => {
  // The tenant's ScubaGear lists (config.mjs). A rule that needs a list the tenant has
  // not set could only fail for the missing list, not for the tenant: could not check.
  const config = context?.scubaConfig ?? DEFAULT_SCUBA_CONFIG;
  if (args.needsList && !configHasList(config, args.policyId)) {
    return { verdict: 'unknown', reason: REASON(`needs-setting:${args.needsList}`) };
  }
  const byType = Array.isArray(facts) ? { [args.reads[0]]: facts } : facts;
  const built = buildInput(args.inputs, byType, { version: args.version, config, now: context?.now });
  if (built.couldNotBuild) {
    return { verdict: 'unknown', reason: REASON(`incomplete:${built.couldNotBuild.key}`), details: [line(args, built.couldNotBuild.why, false)] };
  }
  let results;
  try {
    results = resultsFor(args.product, built.document);
  } catch (error) {
    // Never let one rule's failure stop the other checks or leave an older pass standing.
    const unavailable = /rules\.(wasm|json)|ENOENT|WebAssembly/.test(String(error?.message));
    return { verdict: 'unknown', reason: REASON(unavailable ? 'runner-unavailable' : 'runner-error') };
  }
  const own = results.filter((result) => result?.PolicyId === args.policyId);
  if (own.length !== 1) return { verdict: 'unknown', reason: REASON(own.length ? 'several-results' : 'no-result') };
  const verdict = verdictOf(own[0]);
  return { verdict, details: [line(args, plainDetails(own[0].ReportDetails), verdict !== 'fail')] };
});

function line(args, text, ok) {
  return { subject: args.productName, setting: 'ScubaGear finding', value: text ?? null, expected: 'Requirement met', ok };
}

// --- Registering every rule ----------------------------------------------------------

/**
 * Names a product's rules build themselves and read back, so no backup needs to hold
 * them: keys of the objects a rule makes (a check's { Compliant, Message } answer), and
 * Power BI setting names, which are the settingName values its rules look settings up
 * by. A name here is read off nothing Keel stores, so a missing field can never hide
 * behind it: each one was checked in the pinned Rego, and a test checks each is a string
 * there.
 */
export const REGO_BUILT_NAMES = Object.freeze({
  securitysuite: Object.freeze([
    'Compliant', 'Message', // UserImpersonationCompliant and the other anti-phish checks
    'ContentNames', 'SSN', 'ITIN', 'Credit_Card', // the DLP rules' own tally of sensitive types
    'Exchange', 'SharePoint', 'OneDrive', 'Teams', 'Devices', // the DLP locations it tallies
  ]),
  powerplatform: Object.freeze(['EnvironmentType']), // DefaultEnvPolicies' own objects
  powerbi: Object.freeze([
    'PublishToWeb', 'AllowGuestUserToAccessSharedContent', 'ExternalSharingV2', 'ServicePrincipalAccessPermissionAPIs',
    'AllowServicePrincipalsCreateAndUseProfiles', 'BlockResourceKeyAuthentication', 'RScriptVisual', 'EimInformationProtectionEdit',
  ]),
});

/**
 * Why a rule cannot run on Keel's data at all, decided from its Rego alone, or null.
 * `rule` carries `inputs` (the keys it reads) and `members` (every member name its code
 * uses on the way: a superset of the fields it reads).
 */
export function staticReason(rule, { adapters = ADAPTERS, sources = SCUBA_INPUT_SOURCES } = {}) {
  if (rule.manual) return REASON('check-by-hand');
  // A rule that reads its own section of ScubaGear's config (the sensitive users or the
  // partner domains to protect) runs once the tenant sets its list (config.mjs); until
  // then the predicate answers could not check. A section with no list Keel keeps is
  // a list the tenant has no place for.
  if (CONFIG_SECTIONS.some((section) => rule.members.includes(section)) && !listForRule(rule.id)) return REASON('needs-setting:unknown-list');
  const tenant = rule.inputs.filter((key) => !SETTING_STATES.has(sources[key]?.state));
  for (const key of tenant) {
    if (sources[key]?.state === 'not-read' || !adapters[key]) return REASON(`not-read:${key}`);
  }
  for (const key of tenant) {
    const lacking = (adapters[key].lacks ?? []).filter((field) => rule.members.includes(field));
    if (lacking.length) return REASON(`field-not-read:${key}.${lacking.sort().join(',')}`);
  }
  // When every input is a read of declared fields, every member the rule names must be
  // one of them (or an input key, or a run setting): anything else is a field Keel drops.
  const limited = tenant.filter((key) => Array.isArray(adapters[key].fields));
  if (limited.length && limited.length === tenant.length) {
    const known = new Set([...rule.inputs, ...rule.inputs.flatMap((key) => adapters[key]?.fields ?? []), ...(REGO_BUILT_NAMES[rule.product] ?? [])]);
    const missing = rule.members.filter((member) => !known.has(member)).sort();
    if (missing.length) return REASON(`field-not-read:${limited.length === 1 ? limited[0] : limited.join('+')}.${missing.join(',')}`);
  } else if (limited.length) {
    throw new Error(`${rule.id} mixes reads of declared fields with full objects; decide how to check its fields first`);
  }
  return null;
}

/** The backups a rule's control needs: every read of every input it uses, merged. */
export function requiredReads(inputs, adapters = ADAPTERS) {
  const graphTypes = new Map();
  const workloads = new Map();
  for (const key of inputs) {
    const adapter = adapters[key];
    if (adapter.setting) continue;
    if (!adapter.reads) throw new Error(`${key} has no backup wired to it yet`);
    for (const read of adapter.reads) {
      if (WORKLOAD_FACT_TYPES.has(read.resourceType)) {
        const entry = workloads.get(read.resourceType) ?? { resourceType: read.resourceType, maxAgeMs: read.maxAgeMs, parts: new Set() };
        for (const part of read.parts ?? []) entry.parts.add(part);
        workloads.set(read.resourceType, entry);
      } else {
        graphTypes.set(read.resourceType, { resourceType: read.resourceType, maxAgeMs: read.maxAgeMs });
      }
    }
  }
  // A service read with no kinds (SharePoint's tenant settings) is needed whole.
  return [...graphTypes.values(), ...[...workloads.values()].map(({ parts, ...entry }) => (parts.size ? { ...entry, parts: [...parts].sort() } : entry))];
}

/**
 * Every pinned rule of `products` (all by default) with the reason it cannot run on
 * Keel's data, or null when it runs: the list the coverage report shows.
 */
export function scubaRuleOutcomes({ products = null, imported = importScubaGearRules() } = {}) {
  const pinned = openPinnedScubaGear();
  const { pin } = pinned;
  const chosen = products ?? Object.keys(pin.products);
  const files = [...chosen.map((product) => pin.products[product].rego), ...pin.regoUtils]
    .map((file) => ({ file, source: pinned.read(file) }));
  const members = regoRuleInputs(files);
  return imported.rules.filter((rule) => chosen.includes(rule.product)).map((rule) => {
    const shaped = { ...rule, members: [...members.get(rule.id).members] };
    return { rule, reason: staticReason(shaped) };
  });
}

function registerScubaControls() {
  const { build } = readBuild();
  const { pin } = openPinnedScubaGear();
  for (const { rule, reason: unchecked } of scubaRuleOutcomes({ products: build.products })) {
    const tenantInputs = rule.inputs.filter((key) => ADAPTERS[key] && !SETTING_STATES.has(SCUBA_INPUT_SOURCES[key]?.state));
    const reads = unchecked ? [] : requiredReads(rule.inputs);
    registerControl({
      controlId: `${SCUBA_CONTROL_PREFIX}${rule.id}`,
      title: rule.title,
      description: `CISA ScubaGear ${rule.id} (${pin.products[rule.product].name}, ${rule.criticality}): ${rule.statement}`,
      framework: SCUBA_FRAMEWORK,
      edition: pin.version,
      profile: rule.product,
      evaluatorVersion: 1,
      severity: rule.criticality === 'SHALL' ? 'high' : 'medium',
      requiredObservations: reads,
      predicate: {
        name: SCUBA_PREDICATE,
        args: {
          product: rule.product,
          productName: pin.products[rule.product].name,
          policyId: rule.id,
          version: pin.version,
          inputs: rule.inputs.filter((key) => ADAPTERS[key]),
          ...(listForRule(rule.id) ? { needsList: listForRule(rule.id) } : {}),
          reads: reads.map((read) => read.resourceType),
        },
      },
      frameworkRefs: [
        { framework: 'CISA SCuBA', edition: pin.version, ref: rule.id },
        ...rule.nistControlIds.map((ref) => ({ framework: 'NIST SP 800-53', edition: 'Rev. 5', profile: 'FedRAMP High', ref })),
      ],
      provenance: { source: 'public-domain', license: 'CC0-1.0', sourceUrl: pin.sourceUrl },
      unchecked: unchecked ? { reason: unchecked } : null,
      facts: tenantInputs.some((key) => ADAPTERS[key].masked) ? 'masked' : 'semantic',
    });
  }
}

registerScubaControls();
