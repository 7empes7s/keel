/**
 * Checks a tenant writes itself ("Write your own check" on the Compliance page).
 *
 * A check names one setting of one backed-up configuration type, the value it should
 * (or should not) have, and whether every object of the type or at least one must
 * meet it. Checks are grouped by a standard the tenant names. They run with the
 * shipped controls after every backup and on "Check now", through the same evaluator,
 * so freshness, "could not check", exceptions and evidence work exactly as they do
 * for Keel's own checks.
 *
 * The registry's rules hold here too. A check is data, never code: it is evaluated by
 * one predicate this module ships (OWN_PREDICATE), registered in the allowlist like
 * every other. The predicate sees only semantic facts (fields a type's review marked
 * sensitive are gone), and a check may not name a sensitive field at all. A check is
 * never changed in place: it is removed and written again, so a stored result always
 * names the exact rule that produced it.
 *
 * Writes only Keel's own database: the check row and its evidence entry. Never the tenant.
 */
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { SERVER_OWNED } from '../cir/serverOwned.mjs';
import { classifyForOperation, exportProjection } from '../contracts/fieldProjection.mjs';
import { appendEvidence } from '../govern/evidence.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { BENCHMARK_REGISTRY_CONTRACT_VERSION, NOT_CONFIGURED, registerPredicate } from './registry.mjs';

export const OWN_FRAMEWORK = 'own';
export const OWN_PREFIX = 'own.';
export const OWN_PREDICATE = 'own-setting-check';
export const OWN_EVIDENCE_KIND = 'compliance-own-check';
export const OPERATORS = Object.freeze(['equals', 'not-equals']);
export const APPLIES_TO = Object.freeze(['every', 'any']);
export const SEVERITIES = Object.freeze(['low', 'medium', 'high']);
// The same freshness Keel's own checks on backed-up settings ask for.
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_TEXT = 200;
// A setting is a top-level field or a short path into one ("conditions.users.includeUsers").
const FIELD_PATH = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,3}$/;
// How many objects and sample values the field list offers for one type.
const SAMPLE_OBJECTS = 200;
const SAMPLE_VALUES = 5;

/** A field's value on one object, by dotted path. Missing reads as null. */
export function valueAt(fact, path) {
  let value = fact;
  for (const key of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    value = value[key];
  }
  return value === undefined ? null : value;
}

/** Strings compare without case (Microsoft mixes "Enabled" and "enabled"); the rest exactly. */
function sameValue(actual, expected) {
  if (typeof actual === 'string' && typeof expected === 'string') return actual.toLowerCase() === expected.toLowerCase();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function subjectOf(fact) {
  for (const key of ['displayName', 'name', 'Name', 'id']) {
    if (typeof fact?.[key] === 'string' && fact[key].length > 0) return fact[key];
  }
  return 'Unnamed object';
}

registerPredicate(OWN_PREDICATE, (facts, { field, operator, expected, appliesTo } = {}) => {
  const meets = (fact) => (operator === 'not-equals') !== sameValue(valueAt(fact, field), expected);
  const shouldBe = operator === 'not-equals' ? `Anything but ${typeof expected === 'string' ? expected : JSON.stringify(expected)}` : expected;
  const misses = (list) => list.map((fact) => ({ subject: subjectOf(fact), setting: field, value: valueAt(fact, field), expected: shouldBe }));
  if (appliesTo === 'any') {
    if (facts.some(meets)) return 'pass';
    // Nothing of the type exists, so the setting cannot be met anywhere: "not set up yet".
    if (facts.length === 0) return { verdict: 'fail', reason: NOT_CONFIGURED };
    return { verdict: 'fail', details: misses(facts) };
  }
  if (facts.length === 0) return 'not-applicable';
  const failing = facts.filter((fact) => !meets(fact));
  return failing.length ? { verdict: 'fail', details: misses(failing) } : 'pass';
});

/** Whether Keel backs up this type with a reviewed field split, so a check can read it. */
export function checkableType(resourceType) {
  return typeof resourceType === 'string' && SERVER_OWNED.has(resourceType);
}

function plainValue(value) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.length <= MAX_TEXT;
}

function text(value, name, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`a check needs a ${name}`);
  if (value.trim().length > max) throw new TypeError(`a check's ${name} is at most ${max} characters`);
  return value.trim();
}

/** Validates what a person typed into a check; throws a TypeError naming the problem. */
export function validateOwnCheck(input) {
  const standard = text(input?.standard, 'standard name', 80);
  const name = text(input?.name, 'name');
  const resourceType = input?.resourceType;
  if (!checkableType(resourceType)) throw new TypeError('a check reads a configuration type Keel backs up');
  const field = input?.field;
  if (typeof field !== 'string' || !FIELD_PATH.test(field)) throw new TypeError('a check names one setting');
  if (classifyForOperation('sensitiveExport', field, resourceType) === 'sensitive') {
    throw new TypeError('that setting is kept out of checks because it is sensitive');
  }
  const operator = input?.operator ?? 'equals';
  if (!OPERATORS.includes(operator)) throw new TypeError(`a check's operator is one of ${OPERATORS.join(', ')}`);
  if (!Object.hasOwn(input ?? {}, 'expected') || !plainValue(input.expected)) {
    throw new TypeError('a check compares with one plain value: on or off, a number, or a short text');
  }
  const appliesTo = input?.appliesTo ?? 'every';
  if (!APPLIES_TO.includes(appliesTo)) throw new TypeError(`a check applies to ${APPLIES_TO.join(' or ')}`);
  const severity = input?.severity ?? 'medium';
  if (!SEVERITIES.includes(severity)) throw new TypeError(`a check's weight is one of ${SEVERITIES.join(', ')}`);
  return { standard, name, resourceType, field, operator, expected: input.expected, appliesTo, severity };
}

function describe(row) {
  const who = row.applies_to === 'any' ? `At least one ${row.resource_type}` : `Every ${row.resource_type}`;
  const how = row.operator === 'not-equals' ? 'does not have' : 'has';
  return `${who} ${how} ${row.field} = ${JSON.stringify(row.expected)}. A check written by this tenant.`;
}

/** The control a stored check evaluates as: the registry's shape, built from the row. */
export function controlFromRow(row) {
  return Object.freeze({
    contractVersion: BENCHMARK_REGISTRY_CONTRACT_VERSION,
    controlId: `${OWN_PREFIX}${row.id}`,
    title: row.name,
    description: describe(row),
    framework: OWN_FRAMEWORK,
    edition: '1',
    profile: row.standard,
    evaluatorVersion: 1,
    requiredObservations: Object.freeze([Object.freeze({ resourceType: row.resource_type, maxAgeMs: MAX_AGE_MS })]),
    predicate: Object.freeze({
      name: OWN_PREDICATE,
      args: Object.freeze({ field: row.field, operator: row.operator, expected: row.expected, appliesTo: row.applies_to }),
    }),
    frameworkRefs: Object.freeze([]),
    provenance: Object.freeze({ source: 'original' }),
    severity: row.severity,
    fix: null,
  });
}

/** A stored check as the portal shows it. */
export function shapeOwnCheck(row) {
  return {
    id: String(row.id),
    controlId: `${OWN_PREFIX}${row.id}`,
    standard: row.standard,
    name: row.name,
    resourceType: row.resource_type,
    field: row.field,
    operator: row.operator,
    expected: row.expected,
    appliesTo: row.applies_to,
    severity: row.severity,
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

/** Every check of the tenant, removed ones included (`removed_at` set), oldest first. */
export async function ownCheckRows(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query(
    'SELECT * FROM compliance_own_check WHERE tenant_ref = $1 ORDER BY created_at, id',
    [tenantRef],
  );
  return rows;
}

/** The tenant's checks in force, as controls the evaluator runs. */
export async function listOwnControls(client, { tenantRef }) {
  return (await ownCheckRows(client, { tenantRef })).filter((row) => !row.removed_at).map(controlFromRow);
}

async function authorize(client, principalId, now) {
  const principal = await findPrincipalById(client, principalId);
  if (!principal || !(await can(client, principal, 'configuration', now))) {
    throw new Error('forbidden: writing a compliance check requires configuration');
  }
}

/** Saves a new check (needs `configuration`) and records it in the evidence chain. */
export async function createOwnCheck(client, { principalId, tenantRef, input, now = new Date() }) {
  assertTenantRef(tenantRef);
  await authorize(client, principalId, now);
  const check = validateOwnCheck(input);
  const { rows: [row] } = await client.query(
    `INSERT INTO compliance_own_check
       (tenant_ref, standard, name, resource_type, field, operator, expected, applies_to, severity, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
     RETURNING *`,
    [tenantRef, check.standard, check.name, check.resourceType, check.field, check.operator,
      JSON.stringify(check.expected), check.appliesTo, check.severity, principalId, now],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: OWN_EVIDENCE_KIND,
    actor: principalId,
    subject: { action: 'created', checkId: String(row.id), ...check },
  });
  return row;
}

/** Removes a check (needs `configuration`). Its row and past results stay; it no longer runs or shows. */
export async function removeOwnCheck(client, { principalId, tenantRef, checkId, now = new Date() }) {
  assertTenantRef(tenantRef);
  await authorize(client, principalId, now);
  const { rows: [row] } = await client.query(
    `UPDATE compliance_own_check SET removed_at = $3, removed_by = $4
      WHERE id = $1 AND tenant_ref = $2 AND removed_at IS NULL
      RETURNING *`,
    [checkId, tenantRef, now, principalId],
  );
  if (!row) return null;
  await appendEvidence(client, {
    tenantRef,
    kind: OWN_EVIDENCE_KIND,
    actor: principalId,
    subject: { action: 'removed', checkId: String(row.id), standard: row.standard, name: row.name },
  });
  return row;
}

function collectPaths(value, prefix, depth, into) {
  for (const [key, child] of Object.entries(value ?? {})) {
    if (key.includes('@') || !/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
      if (depth < 3) collectPaths(child, path, depth + 1, into);
      continue;
    }
    if (Array.isArray(child)) continue;
    const values = into.get(path) ?? new Set();
    if (values.size < SAMPLE_VALUES) values.add(JSON.stringify(child));
    into.set(path, values);
  }
}

/**
 * What a check can be written on: each type in the tenant's newest complete backup,
 * with its object count and the plain settings its objects carry (sensitive fields
 * left out), each with a few values seen. Lists of values are left out: a check
 * compares one plain value.
 */
export async function ownCheckChoices(client, { tenantRef }) {
  assertTenantRef(tenantRef);
  const { rows: [snapshot] } = await client.query(
    `SELECT id FROM snapshot WHERE tenant_ref = $1 AND status = 'complete' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC, id DESC LIMIT 1`,
    [tenantRef],
  );
  if (!snapshot) return { snapshotId: null, types: [] };
  const { rows: counts } = await client.query(
    'SELECT resource_type, count(*)::int AS count FROM resource_version WHERE snapshot_id = $1 GROUP BY resource_type ORDER BY resource_type',
    [snapshot.id],
  );
  const types = [];
  for (const { resource_type: resourceType, count } of counts) {
    if (!checkableType(resourceType)) continue;
    const { rows } = await client.query(
      `SELECT payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key LIMIT ${SAMPLE_OBJECTS}`,
      [snapshot.id, resourceType],
    );
    const paths = new Map();
    for (const { payload } of rows) collectPaths(exportProjection(payload, resourceType), '', 0, paths);
    const fields = [...paths.entries()]
      .filter(([path]) => classifyForOperation('sensitiveExport', path, resourceType) !== 'sensitive')
      .map(([path, values]) => ({ field: path, values: [...values].map((value) => JSON.parse(value)) }))
      .sort((left, right) => left.field.localeCompare(right.field));
    types.push({ resourceType, count, fields });
  }
  return { snapshotId: String(snapshot.id), types };
}
