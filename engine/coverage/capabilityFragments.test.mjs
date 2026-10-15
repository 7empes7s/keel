import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CAPABILITY_FRAGMENTS, capabilityFor, graphPathFor, recordFixtureProof, registerCapabilityFragment, registerOperationCapability,
} from './capabilities.mjs';

const DIR = new URL('./capabilities.d/', import.meta.url);

test('every capabilities.d fragment is imported and registered', () => {
  const source = readFileSync(new URL('./capabilities.mjs', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/from '\.\/capabilities\.d\/([^']+)'/g)].map((match) => match[1]).sort();
  const files = readdirSync(DIR).filter((name) => name.endsWith('.mjs')).sort();
  assert.deepEqual(imported, files);
  assert.deepEqual(Object.keys(CAPABILITY_FRAGMENTS).sort(), files.map((name) => name.replace(/\.mjs$/, '')));
  for (const entry of Object.values(CAPABILITY_FRAGMENTS).flat()) {
    const record = capabilityFor(entry.resourceType, entry.operation);
    assert.equal(record.path, entry.path, `${entry.resourceType} ${entry.operation}`);
    assert.equal(record.handler, entry.handler);
  }
});

test('a fragment entry registers exactly what the direct calls register', () => {
  const base = { operation: 'update', path: '/keelRtFragment', handler: 'engine/x.mjs#y', idOutcome: 'preserved' };
  registerOperationCapability({ ...base, resourceType: 'keelRtDirect', path: '/keelRtDirect' });
  recordFixtureProof('keelRtDirect', 'update', 'engine/coverage/capabilityFragments.test.mjs');
  registerCapabilityFragment([{ ...base, resourceType: 'keelRtFragment', proofRef: 'engine/coverage/capabilityFragments.test.mjs' }]);
  registerCapabilityFragment([{ ...base, resourceType: 'keelRtFragment', operation: 'create' }]);
  const strip = ({ resourceType, path, ...rest }) => rest;
  assert.deepEqual(strip(capabilityFor('keelRtFragment', 'update')), strip(capabilityFor('keelRtDirect', 'update')));
  assert.equal(capabilityFor('keelRtFragment', 'update').claim, 'fixture-tested');
  assert.equal(capabilityFor('keelRtFragment', 'create').claim, 'declared');
  assert.equal(graphPathFor('keelRtFragment'), '/keelRtFragment');
});

test('a fragment never replaces an existing registration', () => {
  const before = capabilityFor('group', 'create');
  assert.throws(() => registerCapabilityFragment([{ resourceType: 'group', operation: 'create', path: '/groups', handler: 'engine/x.mjs#y' }]), /already registered/);
  assert.deepEqual(capabilityFor('group', 'create'), before);
});
