/**
 * Roadmap task-85 boundary tests: versioned benchmark and custom-control
 * evaluation. Exercises the production engine/benchmarks/registry.mjs and
 * engine/benchmarks/evaluate.mjs against adversarial fixtures and the
 * isolated test database — including the three required mutation checks:
 *
 * - Treat missing observation as pass.
 * - Conflate edition changes with tenant drift.
 * - Erase underlying finding under exception.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  BENCHMARK_REGISTRY_CONTRACT_VERSION, CONTROL_VERDICTS, PREDICATE_VERDICTS,
  controlFor, listControls, predicateFor, registerControl, registerPredicate, semanticFacts,
} from '../benchmarks/registry.mjs';
import {
  EVALUATION_CONTRACT_VERSION, compareEvaluationsAcrossEditions, effectiveVerdict,
  evaluateControl, listActiveExceptions, recordEvaluation, recordException,
} from '../benchmarks/evaluate.mjs';
import { CrossTenantObservationError, defineObservation } from '../contracts/observation.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const TENANT = 'sha256:benchmark-test';
const OTHER_TENANT = 'sha256:benchmark-other';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const ADMIN_ROLE = '62e90394-69f5-4237-9190-012177145e10';

function observationFor({
  tenantRef = TENANT, resourceType, endedAt, startedAt = endedAt, completeness = 'complete',
}) {
  return defineObservation({
    tenantRef, observationId: `obs-${resourceType}-${endedAt}`, resourceType,
    window: { startedAt, endedAt }, sourceBuild: 'test-build', completeness,
    evidenceLevel: 'fixture-tested',
  });
}

function roleAssignments(n, roleDefinitionId = ADMIN_ROLE) {
  return Array.from({ length: n }, (_, i) => ({
    id: `ra-${i}`, principalId: `principal-${i}`, roleDefinitionId, directoryScopeId: '/',
  }));
}

// ---------------------------------------------------------------------------
// registry.mjs: allowlisted predicates, versioned controls, provenance guard
// ---------------------------------------------------------------------------

test('registerPredicate refuses a duplicate name; predicateFor refuses an unregistered name', () => {
  registerPredicate('test.unique-predicate-1', () => 'pass');
  assert.throws(() => registerPredicate('test.unique-predicate-1', () => 'pass'), TypeError);
  assert.throws(() => registerPredicate('test.bad', 'not-a-function'), TypeError);
  assert.equal(typeof predicateFor('test.unique-predicate-1'), 'function');
  assert.throws(() => predicateFor('test.does-not-exist'), /not allowlisted/);
});

test('registerControl refuses a predicate name that was never allowlisted', () => {
  assert.throws(() => registerControl({
    controlId: 'test.control.unregistered-predicate',
    title: 'Test', description: 'Test control referencing an unregistered predicate.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.does-not-exist' },
  }), /not allowlisted/);
});

test('registerControl requires a licensed-source control to cite recorded rightsEvidence', () => {
  registerPredicate('test.always-pass', () => 'pass');
  assert.throws(() => registerControl({
    controlId: 'test.control.licensed-without-rights',
    title: 'Test', description: 'Would embed a licensed source without citing rights.',
    framework: 'example-framework', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.always-pass' },
    provenance: { source: 'licensed' },
  }), /rightsEvidence/);

  // With rights evidence cited, registration succeeds — proven against a
  // synthetic example framework, never real CIS content.
  registerControl({
    controlId: 'test.control.licensed-with-rights',
    title: 'Test', description: 'Cites its licensed source explicitly.',
    framework: 'example-framework', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.always-pass' },
    provenance: { source: 'licensed', rightsEvidence: 'example-license-grant-2026-09-25' },
  });
  assert.equal(controlFor('test.control.licensed-with-rights').provenance.rightsEvidence, 'example-license-grant-2026-09-25');
});

test('a control may cite multiple framework references without any legal-compliance claim in its shape', () => {
  registerControl({
    controlId: 'test.control.multi-framework-ref',
    title: 'Test', description: 'Maps to two synthetic framework reference codes.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.always-pass' },
    frameworkRefs: [
      { framework: 'EXAMPLE-FRAMEWORK-A', edition: '9.9', profile: 'L1', ref: '1.2.3' },
      { framework: 'EXAMPLE-FRAMEWORK-B', ref: 'AC-2' },
    ],
  });
  const control = controlFor('test.control.multi-framework-ref');
  assert.equal(control.frameworkRefs.length, 2);
  assert.equal(control.frameworkRefs[0].framework, 'EXAMPLE-FRAMEWORK-A');
  assert.equal(control.frameworkRefs[1].edition, null); // optional field defaults to null, never invented
  // Nothing in the control or evaluation result shape asserts compliance.
  assert.equal('compliant' in control, false);
  assert.ok(Object.isFrozen(control.frameworkRefs));
});

test('registry rejects malformed controls: empty requiredObservations, non-positive maxAgeMs, unknown provenance source', () => {
  assert.throws(() => registerControl({
    controlId: 'test.control.empty-required-observations',
    title: 'Test', description: 'Test.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [],
    predicate: { name: 'test.always-pass' },
  }), TypeError);
  assert.throws(() => registerControl({
    controlId: 'test.control.bad-max-age',
    title: 'Test', description: 'Test.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: 0 }],
    predicate: { name: 'test.always-pass' },
  }), TypeError);
  assert.throws(() => registerControl({
    controlId: 'test.control.bad-provenance',
    title: 'Test', description: 'Test.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.always-pass' },
    provenance: { source: 'stolen' },
  }), TypeError);
});

test('semanticFacts excludes sensitiveExport fields while keeping reviewed state fields a predicate needs', () => {
  const facts = semanticFacts('group', {
    id: 'g1', displayName: 'Fixture Group', isAssignableToRole: true, onPremisesSyncEnabled: true,
    onPremisesSecurityIdentifier: 'S-1-5-fixture', onPremisesSamAccountName: 'fixture$',
  });
  // group's sensitiveExport set (on-prem AD correlation identifiers) is excluded...
  assert.equal('onPremisesSecurityIdentifier' in facts, false);
  assert.equal('onPremisesSamAccountName' in facts, false);
  // ...but the server-managed configuration state a predicate reasons about is not —
  // this is what canonicalize()'s comparison-oriented serverOwned exclusion would have
  // wrongly stripped, breaking every control that reads it.
  assert.equal(facts.displayName, 'Fixture Group');
  assert.equal(facts.isAssignableToRole, true);
  assert.equal(facts.onPremisesSyncEnabled, true);
});

test('shipped fixture controls are original, versioned and carry no external framework mapping', () => {
  for (const controlId of [
    'keel-custom.role-assignment.admin-count-at-most',
    'keel-custom.named-location.no-untrusted-all-countries',
    'keel-custom.group.role-assignable-not-synced',
  ]) {
    const control = controlFor(controlId);
    assert.equal(control.contractVersion, BENCHMARK_REGISTRY_CONTRACT_VERSION);
    assert.equal(control.framework, 'keel-custom');
    assert.equal(control.provenance.source, 'original');
    assert.deepEqual(control.frameworkRefs, []);
    assert.ok(Object.isFrozen(control));
  }
  const custom = listControls({ framework: 'keel-custom', edition: '1.0.0', profile: 'default' });
  assert.ok(custom.map((c) => c.controlId).includes('keel-custom.group.role-assignable-not-synced'));
});

// ---------------------------------------------------------------------------
// evaluate.mjs: pure evaluateControl() — observation usability gates first
// ---------------------------------------------------------------------------

test('evaluateControl: a missing observation is unknown, never a pass (required mutation check)', () => {
  const result = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef: TENANT,
    observations: {},
    now: NOW,
  });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /^roleAssignment:no-observation$/);
  assert.deepEqual(result.evidenceRefs, []);
});

test('evaluateControl: a stale observation is unknown, not a pass', () => {
  const staleEndedAt = new Date(NOW.getTime() - 7 * 60 * 60 * 1000).toISOString(); // 7h > 6h max age
  const result = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef: TENANT,
    observations: {
      roleAssignment: {
        observation: observationFor({ resourceType: 'roleAssignment', endedAt: staleEndedAt }),
        resources: roleAssignments(1),
      },
    },
    now: NOW,
  });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /stale-observation/);
});

test('evaluateControl: a future-dated observation cannot justify a current pass', () => {
  const futureEndedAt = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString(); // 30m > 5m tolerance
  const result = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef: TENANT,
    observations: {
      roleAssignment: {
        observation: observationFor({ resourceType: 'roleAssignment', endedAt: futureEndedAt }),
        resources: [], // would trivially "pass" (0 admins) if the future check were skipped
      },
    },
    now: NOW,
  });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /future-observation/);
});

test('evaluateControl: an incomplete (partial) observation is unknown', () => {
  const result = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef: TENANT,
    observations: {
      roleAssignment: {
        observation: observationFor({
          resourceType: 'roleAssignment',
          endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
          completeness: 'partial',
        }),
        resources: [],
      },
    },
    now: NOW,
  });
  assert.equal(result.verdict, 'unknown');
  assert.match(result.reason, /observation-partial/);
});

test('evaluateControl: a cross-tenant observation refuses the join by throwing', () => {
  assert.throws(() => evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef: TENANT,
    observations: {
      roleAssignment: {
        observation: observationFor({
          tenantRef: OTHER_TENANT,
          resourceType: 'roleAssignment',
          endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: roleAssignments(1),
      },
    },
    now: NOW,
  }), CrossTenantObservationError);
});

test('evaluateControl: unregistered controlId throws', () => {
  assert.throws(() => evaluateControl({
    controlId: 'not-a-real-control', tenantRef: TENANT, observations: {}, now: NOW,
  }), /is not registered/);
});

test('evaluateControl: a predicate that returns an out-of-contract verdict is refused', () => {
  registerPredicate('test.bad-verdict', () => 'compliant'); // not in PREDICATE_VERDICTS
  registerControl({
    controlId: 'test.control.bad-verdict',
    title: 'Test', description: 'Predicate returns an invalid verdict token.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.bad-verdict' },
  });
  assert.throws(() => evaluateControl({
    controlId: 'test.control.bad-verdict',
    tenantRef: TENANT,
    observations: {
      group: {
        observation: observationFor({
          resourceType: 'group', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: [{ id: 'g1', displayName: 'x' }],
      },
    },
    now: NOW,
  }), TypeError);
});

test('evaluateControl: the predicate receives only semantic facts, never the raw resource', () => {
  let received = null;
  registerPredicate('test.capture-facts', (facts) => { received = facts; return 'pass'; });
  registerControl({
    controlId: 'test.control.capture-facts',
    title: 'Test', description: 'Captures the facts array handed to it for assertion.',
    framework: 'keel-custom', edition: '1.0.0', profile: 'default', evaluatorVersion: 1,
    requiredObservations: [{ resourceType: 'group', maxAgeMs: MAX_AGE_MS }],
    predicate: { name: 'test.capture-facts' },
  });
  evaluateControl({
    controlId: 'test.control.capture-facts',
    tenantRef: TENANT,
    observations: {
      group: {
        observation: observationFor({
          resourceType: 'group', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: [{
          id: 'g1', displayName: 'Fixture', isAssignableToRole: true,
          onPremisesSecurityIdentifier: 'S-1-5-fixture',
        }],
      },
    },
    now: NOW,
  });
  assert.equal(received.length, 1);
  assert.equal('onPremisesSecurityIdentifier' in received[0], false);
  assert.equal(received[0].displayName, 'Fixture');
  assert.equal(received[0].isAssignableToRole, true);
});

// --- shipped-fixture behavior: pass / fail / not-applicable -----------------

test('keel-custom.role-assignment.admin-count-at-most: passes at the limit, fails over it', () => {
  const obs = (n) => ({
    observation: observationFor({
      resourceType: 'roleAssignment', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
    }),
    resources: roleAssignments(n),
  });
  assert.equal(evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most', tenantRef: TENANT,
    observations: { roleAssignment: obs(5) }, now: NOW,
  }).verdict, 'pass');
  const failResult = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most', tenantRef: TENANT,
    observations: { roleAssignment: obs(6) }, now: NOW,
  });
  assert.equal(failResult.verdict, 'fail');
  assert.equal(failResult.evidenceRefs.length, 6);
  assert.equal(failResult.evaluatorVersion, 1);
});

test('keel-custom.named-location.no-untrusted-all-countries: not-applicable with zero locations, fail on the risky combo', () => {
  const withResources = (resources) => ({
    observation: observationFor({
      resourceType: 'namedLocation', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      completeness: 'complete',
    }),
    resources,
  });
  assert.equal(evaluateControl({
    controlId: 'keel-custom.named-location.no-untrusted-all-countries', tenantRef: TENANT,
    observations: { namedLocation: withResources([]) }, now: NOW,
  }).verdict, 'not-applicable');
  assert.equal(evaluateControl({
    controlId: 'keel-custom.named-location.no-untrusted-all-countries', tenantRef: TENANT,
    observations: { namedLocation: withResources([{ id: 'nl1', isTrusted: true, includeUnknownCountriesAndRegions: false }]) },
    now: NOW,
  }).verdict, 'pass');
  assert.equal(evaluateControl({
    controlId: 'keel-custom.named-location.no-untrusted-all-countries', tenantRef: TENANT,
    observations: { namedLocation: withResources([{ id: 'nl1', isTrusted: true, includeUnknownCountriesAndRegions: true }]) },
    now: NOW,
  }).verdict, 'fail');
});

test('keel-custom.group.role-assignable-not-synced: fail only on the role-assignable + synced combo', () => {
  const withResources = (resources) => ({
    observation: observationFor({
      resourceType: 'group', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
      completeness: 'complete',
    }),
    resources,
  });
  assert.equal(evaluateControl({
    controlId: 'keel-custom.group.role-assignable-not-synced', tenantRef: TENANT,
    observations: { group: withResources([]) }, now: NOW,
  }).verdict, 'not-applicable');
  assert.equal(evaluateControl({
    controlId: 'keel-custom.group.role-assignable-not-synced', tenantRef: TENANT,
    observations: { group: withResources([{ id: 'g1', isAssignableToRole: true, onPremisesSyncEnabled: false }]) },
    now: NOW,
  }).verdict, 'pass');
  assert.equal(evaluateControl({
    controlId: 'keel-custom.group.role-assignable-not-synced', tenantRef: TENANT,
    observations: { group: withResources([{ id: 'g1', isAssignableToRole: true, onPremisesSyncEnabled: true }]) },
    now: NOW,
  }).verdict, 'fail');
});

// ---------------------------------------------------------------------------
// compareEvaluationsAcrossEditions: an edition/evaluator change is never
// reported as tenant drift (required mutation check).
// ---------------------------------------------------------------------------

test('compareEvaluationsAcrossEditions: same edition and evaluatorVersion compares directly', () => {
  const base = {
    controlId: 'c1', edition: '1.0.0', evaluatorVersion: 1, verdict: 'pass',
  };
  assert.deepEqual(
    compareEvaluationsAcrossEditions(base, { ...base, verdict: 'pass' }),
    { comparable: true, changed: false, reason: null },
  );
  assert.deepEqual(
    compareEvaluationsAcrossEditions(base, { ...base, verdict: 'fail' }),
    { comparable: true, changed: true, reason: null },
  );
});

test('compareEvaluationsAcrossEditions: a different edition is never conflated with tenant drift, whether or not the verdict also differs', () => {
  const base = { controlId: 'c1', edition: '1.0.0', evaluatorVersion: 1, verdict: 'pass' };
  // Same verdict, different edition: a naive deep-equal mutant would still say "unchanged"
  // (accidentally correct); the real regression case is the next assertion below, where the
  // verdict ALSO differs — only an edition-aware comparator can refuse to call that "changed".
  const sameVerdictNewEdition = compareEvaluationsAcrossEditions(base, { ...base, edition: '2.0.0' });
  assert.equal(sameVerdictNewEdition.comparable, false);
  assert.equal(sameVerdictNewEdition.changed, null);

  const differentVerdictNewEdition = compareEvaluationsAcrossEditions(base, { ...base, edition: '2.0.0', verdict: 'fail' });
  assert.equal(differentVerdictNewEdition.comparable, false);
  assert.equal(differentVerdictNewEdition.changed, null, 'an edition bump must never be reported as a changed (drifted) verdict');
});

test('compareEvaluationsAcrossEditions: a different evaluatorVersion is also refused, and a mismatched controlId throws', () => {
  const base = { controlId: 'c1', edition: '1.0.0', evaluatorVersion: 1, verdict: 'fail' };
  const result = compareEvaluationsAcrossEditions(base, { ...base, evaluatorVersion: 2, verdict: 'pass' });
  assert.equal(result.comparable, false);
  assert.throws(() => compareEvaluationsAcrossEditions(base, { ...base, controlId: 'c2' }), TypeError);
});

// ---------------------------------------------------------------------------
// DB integration: persistence, exception overlay, and drift-table isolation.
// ---------------------------------------------------------------------------
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  return client;
}

test('recordEvaluation persists the evaluation and appends a benchmark-evaluation evidence record', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:benchmark-record';
  const result = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef,
    observations: {
      roleAssignment: {
        observation: observationFor({
          tenantRef, resourceType: 'roleAssignment', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: roleAssignments(6),
      },
    },
    now: NOW,
  });
  assert.equal(result.contractVersion, EVALUATION_CONTRACT_VERSION);

  const stored = await recordEvaluation(client, { tenantRef, result, actor: 'test-actor' });
  assert.equal(stored.verdict, 'fail');
  assert.ok(stored.evidence_seq);

  const { rows: evidenceRows } = await client.query(
    `SELECT * FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'`,
    [tenantRef],
  );
  assert.equal(evidenceRows.length, 1);
  assert.equal(evidenceRows[0].subject.evaluationId, stored.id);
  assert.equal(evidenceRows[0].subject.verdict, 'fail');
});

test('recordException never rewrites the underlying evaluation verdict, and requires a fail verdict (required mutation check)', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:benchmark-exception';
  const failResult = evaluateControl({
    controlId: 'keel-custom.group.role-assignable-not-synced',
    tenantRef,
    observations: {
      group: {
        observation: observationFor({
          tenantRef, resourceType: 'group', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: [{ id: 'g1', isAssignableToRole: true, onPremisesSyncEnabled: true }],
      },
    },
    now: NOW,
  });
  const evaluation = await recordEvaluation(client, { tenantRef, result: failResult, actor: 'test-actor' });
  assert.equal(evaluation.verdict, 'fail');

  const exception = await recordException(client, {
    tenantRef, evaluationId: evaluation.id, actor: 'reviewer', reason: 'Break-glass group, reviewed quarterly.',
  });
  assert.equal(exception.evaluation_id, evaluation.id);

  // The stored evaluation row itself must be untouched — this is the exact
  // failure mode the mutation check targets.
  const { rows: reread } = await client.query('SELECT * FROM benchmark_evaluation WHERE id = $1', [evaluation.id]);
  assert.equal(reread[0].verdict, 'fail');
  assert.equal(reread[0].reason, failResult.reason);

  const { rows: exceptionEvidence } = await client.query(
    `SELECT * FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-exception'`, [tenantRef],
  );
  assert.equal(exceptionEvidence.length, 1);
  assert.equal(exceptionEvidence[0].subject.underlyingVerdict, 'fail');

  // The original evaluation evidence record is still present, unmodified.
  const { rows: evalEvidence } = await client.query(
    `SELECT * FROM evidence WHERE tenant_ref = $1 AND kind = 'benchmark-evaluation'`, [tenantRef],
  );
  assert.equal(evalEvidence.length, 1);

  const active = await listActiveExceptions(client, { tenantRef, evaluationIds: [evaluation.id] });
  assert.equal(active.length, 1);
  const effective = effectiveVerdict(reread[0], active, { now: NOW });
  assert.equal(effective.verdict, 'exception');
  assert.equal(effective.underlyingVerdict, 'fail');
});

test('recordException refuses a pass or unknown evaluation', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:benchmark-exception-refusal';
  const passResult = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef,
    observations: {
      roleAssignment: {
        observation: observationFor({
          tenantRef, resourceType: 'roleAssignment', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: roleAssignments(1),
      },
    },
    now: NOW,
  });
  const passEvaluation = await recordEvaluation(client, { tenantRef, result: passResult, actor: 'test-actor' });
  await assert.rejects(
    recordException(client, { tenantRef, evaluationId: passEvaluation.id, actor: 'reviewer', reason: 'x' }),
    /requires an underlying 'fail' verdict/,
  );

  const unknownResult = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most', tenantRef, observations: {}, now: NOW,
  });
  const unknownEvaluation = await recordEvaluation(client, { tenantRef, result: unknownResult, actor: 'test-actor' });
  await assert.rejects(
    recordException(client, { tenantRef, evaluationId: unknownEvaluation.id, actor: 'reviewer', reason: 'x' }),
    /requires an underlying 'fail' verdict/,
  );
});

test('the schema itself refuses "exception" as a stored verdict value', async (t) => {
  const client = await freshClient(t);
  await assert.rejects(
    client.query(
      `INSERT INTO benchmark_evaluation
         (tenant_ref, control_id, framework, edition, profile, evaluator_version, verdict, evaluated_at)
       VALUES ('sha256:x', 'c', 'keel-custom', '1.0.0', 'default', 1, 'exception', now())`,
    ),
    (error) => error.code === '23514',
  );
});

test('an expired exception no longer overrides the effective verdict', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:benchmark-exception-expiry';
  const failResult = evaluateControl({
    controlId: 'keel-custom.group.role-assignable-not-synced',
    tenantRef,
    observations: {
      group: {
        observation: observationFor({
          tenantRef, resourceType: 'group', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: [{ id: 'g1', isAssignableToRole: true, onPremisesSyncEnabled: true }],
      },
    },
    now: NOW,
  });
  const evaluation = await recordEvaluation(client, { tenantRef, result: failResult, actor: 'test-actor' });
  await recordException(client, {
    tenantRef, evaluationId: evaluation.id, actor: 'reviewer', reason: 'temporary',
    expiresAt: new Date(NOW.getTime() - 1000).toISOString(), // already expired relative to NOW
  });
  const active = await listActiveExceptions(client, { tenantRef, evaluationIds: [evaluation.id] });
  assert.equal(active.length, 0);
  const effective = effectiveVerdict(evaluation, active, { now: NOW });
  assert.equal(effective.verdict, 'fail');
});

test('an edition/evaluatorVersion change across two stored evaluations is never treated as tenant drift', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:benchmark-edition-drift';
  const passResult = evaluateControl({
    controlId: 'keel-custom.role-assignment.admin-count-at-most',
    tenantRef,
    observations: {
      roleAssignment: {
        observation: observationFor({
          tenantRef, resourceType: 'roleAssignment', endedAt: new Date(NOW.getTime() - 60 * 1000).toISOString(),
        }),
        resources: roleAssignments(5),
      },
    },
    now: NOW,
  });
  await recordEvaluation(client, { tenantRef, result: passResult, actor: 'test-actor' });

  // Simulate a benchmark content bump: same control, new edition, evaluated
  // again (the tenant's actual role assignments are unchanged).
  const bumpedEditionResult = { ...passResult, edition: '2.0.0', evaluatedAt: new Date(NOW.getTime() + 1000).toISOString() };
  await recordEvaluation(client, { tenantRef, result: bumpedEditionResult, actor: 'test-actor' });

  const comparison = compareEvaluationsAcrossEditions(passResult, bumpedEditionResult);
  assert.equal(comparison.comparable, false);

  // This module never writes to the drift table — an edition bump produces
  // benchmark_evaluation rows only.
  const { rows: driftRows } = await client.query('SELECT * FROM drift WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(driftRows.length, 0);
  const { rows: evaluationRows } = await client.query(
    'SELECT edition FROM benchmark_evaluation WHERE tenant_ref = $1 ORDER BY edition', [tenantRef],
  );
  assert.deepEqual(evaluationRows.map((r) => r.edition), ['1.0.0', '2.0.0']);
});

test('CONTROL_VERDICTS and PREDICATE_VERDICTS keep the documented five/three-state contracts', () => {
  assert.deepEqual(CONTROL_VERDICTS, ['pass', 'fail', 'unknown', 'not-applicable', 'exception']);
  assert.deepEqual(PREDICATE_VERDICTS, ['pass', 'fail', 'not-applicable']);
});
