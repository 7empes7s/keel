/** Detail-line subjects stay apart when objects share a name, on every control that
 * names objects: a repeated name is numbered "(1 of 2)" by the object's key, never
 * by showing the key. Pure: no database. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { defineObservation } from '../contracts/observation.mjs';
import { evaluateControl } from './evaluate.mjs';
import { distinctNames, predicateFor } from './registry.mjs';
import { OWN_PREDICATE } from './ownChecks.mjs';

const TENANT = 'sha256:distinct-names-test';
const NOW = new Date('2026-10-22T12:00:00.000Z');

function check(controlId, resourceType, resources) {
  const endedAt = new Date(NOW.getTime() - 60_000).toISOString();
  return evaluateControl({
    controlId, tenantRef: TENANT, now: NOW,
    observations: {
      [resourceType]: {
        observation: defineObservation({
          tenantRef: TENANT, observationId: `obs-${resourceType}`, resourceType,
          window: { startedAt: endedAt, endedAt }, sourceBuild: 'test-build', completeness: 'complete',
          evidenceLevel: 'fixture-tested',
        }),
        resources,
      },
    },
  });
}

test('distinctNames numbers only repeated names, by key, in input order', () => {
  const facts = [{ id: 'z', n: 'A' }, { id: 'm', n: 'B' }, { id: 'a', n: 'A' }, { n: 'C' }];
  assert.deepEqual(distinctNames(facts, (fact) => fact.n), ['A (2 of 2)', 'B', 'A (1 of 2)', 'C']);
  // Exchange policies carry an identity, not an id.
  assert.deepEqual(distinctNames([{ identity: 'y' }, { identity: 'x' }], () => 'P'), ['P (2 of 2)', 'P (1 of 2)']);
  // No key at all: input order decides, and the names still differ.
  assert.deepEqual(distinctNames([{}, {}, {}], () => 'Unnamed group'), ['Unnamed group (1 of 3)', 'Unnamed group (2 of 3)', 'Unnamed group (3 of 3)']);
  assert.deepEqual(distinctNames([], () => 'x'), []);
});

test('trusted locations with the same name keep their own lines', () => {
  const result = check('keel-custom.named-location.no-untrusted-all-countries', 'namedLocation', [
    { id: 'loc-2', displayName: 'KEEL-RT-Office', isTrusted: true, includeUnknownCountriesAndRegions: true },
    { id: 'loc-1', displayName: 'KEEL-RT-Office', isTrusted: true, includeUnknownCountriesAndRegions: false },
  ]);
  assert.equal(result.verdict, 'fail');
  assert.deepEqual(result.details.map((line) => [line.subject, line.ok]), [
    ['KEEL-RT-Office (2 of 2)', false],
    ['KEEL-RT-Office (1 of 2)', true],
  ]);
});

test('admin groups with the same name keep their own lines', () => {
  const result = check('keel-custom.group.role-assignable-not-synced', 'group', [
    { id: 'g-1', displayName: 'KEEL-RT-Admins', isAssignableToRole: true, onPremisesSyncEnabled: true },
    { id: 'g-2', displayName: 'KEEL-RT-Admins', isAssignableToRole: true, onPremisesSyncEnabled: null },
  ]);
  assert.deepEqual(result.details.map((line) => line.subject), ['KEEL-RT-Admins (1 of 2)', 'KEEL-RT-Admins (2 of 2)']);
});

test('mail protection policies with the same name keep their own lines', () => {
  const answer = predicateFor('exchange-mail-flow.malware-file-filter')([
    { kind: 'antiMalwarePolicy', identity: 'p-2', Name: 'KEEL-RT-Malware', EnableFileFilter: false, ZapEnabled: true },
    { kind: 'antiMalwarePolicy', identity: 'p-1', Name: 'KEEL-RT-Malware', EnableFileFilter: true, ZapEnabled: true },
  ], {});
  assert.equal(answer.verdict, 'fail');
  assert.deepEqual([...new Set(answer.details.map((line) => line.subject))], ['KEEL-RT-Malware (2 of 2)', 'KEEL-RT-Malware (1 of 2)']);
});

test('own checks number repeated names, and a pass numbers only what it shows', () => {
  const own = predicateFor(OWN_PREDICATE);
  const facts = [
    { id: 'b', displayName: 'KEEL-RT-Twin', enabled: true },
    { id: 'a', displayName: 'KEEL-RT-Twin', enabled: false },
  ];
  const all = own(facts, { field: 'enabled', operator: 'equals', expected: true });
  assert.equal(all.verdict, 'fail');
  assert.deepEqual(all.details.map((line) => line.subject), ['KEEL-RT-Twin (2 of 2)', 'KEEL-RT-Twin (1 of 2)']);
  const any = own(facts, { field: 'enabled', operator: 'equals', expected: true, appliesTo: 'any' });
  assert.equal(any.verdict, 'pass');
  assert.deepEqual(any.details.map((line) => [line.subject, line.ok]), [['KEEL-RT-Twin', true]]);
});
