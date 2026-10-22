import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { buildLiveIndex } from './liveState.mjs';

// Issue #473: the live read for a restore sent `/policySets/{parent}` as it
// stood. Every catalogue kind is read here against a fake tenant that answers
// any path with one object, and no path it is asked for may still hold a
// `{placeholder}`.
const requiredFields = new Set(CATALOG.map((entry) => entry.parent?.requires).filter(Boolean));
const keyFields = new Set(CATALOG.map((entry) => entry.parent?.key).filter((key) => key && key !== 'id'));
const childFields = new Set(CATALOG.map((entry) => entry.childField).filter(Boolean));

function anyObject() {
  const object = { id: '11111111-2222-3333-4444-555555555555', displayName: 'KEEL-RT-object' };
  for (const field of requiredFields) object[field] = true;
  for (const field of keyFields) object[field] = `parent-${field}`;
  for (const field of childFields) object[field] = [{ id: 'child-1' }];
  return object;
}

function recordingReader() {
  const paths = [];
  return {
    paths,
    async collect(_version, path) {
      paths.push(path);
      return { items: [anyObject()], pages: 1, status: 200, error: null };
    },
  };
}

const naturalKeyFor = (type, object) => `${type}:${object.id}`;

test('no live read path holds an unfilled placeholder', async () => {
  for (const entry of CATALOG) {
    const reader = recordingReader();
    await buildLiveIndex(reader, { resourceTypes: [entry.type], naturalKeyFor });
    assert.ok(reader.paths.length > 0, `${entry.type}: nothing was read`);
    for (const path of reader.paths) {
      assert.doesNotMatch(path, /\{[A-Za-z]+\}|%7B[A-Za-z]+%7D/i, `${entry.type}: ${path}`);
    }
  }
});

test('a policy set is read per set with its items', async () => {
  const reader = recordingReader();
  const index = await buildLiveIndex(reader, { resourceTypes: ['policySet'], naturalKeyFor });
  assert.deepEqual(reader.paths, [
    '/deviceAppManagement/policySets?$select=id',
    '/deviceAppManagement/policySets/11111111-2222-3333-4444-555555555555?$expand=items',
  ]);
  assert.equal(index.get('policySet:11111111-2222-3333-4444-555555555555')?.state, 'present');
});

test('a failed per-parent read fails the live index', async () => {
  const reader = {
    async collect(_version, path) {
      if (path.includes('?$expand=items')) return { items: [], pages: 0, status: 400, error: { status: 400, error: 'PolicySet Id is invalid' } };
      return { items: [{ id: 'set-1' }], pages: 1, status: 200, error: null };
    },
  };
  await assert.rejects(
    buildLiveIndex(reader, { resourceTypes: ['policySet'], naturalKeyFor }),
    /listing policySet per parent failed: PolicySet Id is invalid/,
  );
});
