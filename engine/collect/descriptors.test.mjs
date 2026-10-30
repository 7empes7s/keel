/**
 * Full-coverage Wave 1 seam: a type added to the catalogue (catalog.d) gets a
 * descriptor with no edit to descriptors.mjs, after the listed types and with
 * read-only, not-remappable defaults.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS, descriptorsFor } from './descriptors.mjs';

test('every catalogue type has exactly one descriptor, except one waiting for its live read check', () => {
  assert.deepEqual(DESCRIPTORS.map((d) => d.type).sort(), CATALOG.filter((entry) => !entry.liveGate).map((entry) => entry.type).sort());
});

test('a new catalogue entry is described by default, after the listed types', () => {
  const added = { type: 'keelRtWidget', path: '/keelRtWidgets', version: 'beta', criticality: 'tier2', blastRadius: 'access-affecting' };
  const descriptors = descriptorsFor([...CATALOG, added]);
  assert.deepEqual(descriptors.slice(0, DESCRIPTORS.length).map((d) => d.type), DESCRIPTORS.map((d) => d.type));
  assert.deepEqual(descriptors.at(-1), {
    type: 'keelRtWidget',
    fidelity: 'read-only',
    unsupportedFields: [],
    criticality: 'tier2',
    blastRadius: 'access-affecting',
    naturalKeyStrategy: 'displayName',
    remappable: false,
    adapter: 'graph-native/keelRtWidget',
  });
});

test('a listed type missing from the catalogue still fails loudly', () => {
  assert.throws(() => descriptorsFor(CATALOG.filter((entry) => entry.type !== 'group')), /no catalog entry for resource type group/);
});
