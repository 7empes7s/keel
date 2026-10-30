// A catalogue type with `liveGate` is declared but never collected until a
// live read of it passes: endpoint security templates (deviceManagementTemplate).
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { CATALOG, catalogEntryFor, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS, LIVE_GATED_TYPES } from './descriptors.mjs';
import { collectWithOutcomes, collectM1, M1_TYPES } from './entraAdapter.mjs';
import { typeInfo } from '../insights/taxonomy.mjs';

const TEMPLATE = 'deviceManagementTemplate';

test('endpoint security templates are catalogued, read-only, with no field that moves on its own', () => {
  const entry = catalogEntryFor(TEMPLATE);
  assert.ok(entry, 'the tenant probe reads it');
  assert.equal(entry.version, 'beta');
  assert.equal(entry.path, '/deviceManagement/templates');
  const fields = entry.select.split(',');
  assert.ok(fields.includes('templateSubtype') && fields.includes('templateType'), 'the fields that name the Defender area are read');
  assert.ok(!fields.includes('intentCount'), 'intentCount changes whenever a policy is made, so it is not kept');
  assert.equal(catalogReadPath(entry), `/deviceManagement/templates?$select=${entry.select}`);
});

test('a live-gated type has no descriptor and is never read by the collector', async () => {
  assert.deepEqual([...LIVE_GATED_TYPES], CATALOG.filter((entry) => entry.liveGate).map((entry) => entry.type));
  assert.ok(LIVE_GATED_TYPES.includes(TEMPLATE));
  for (const type of LIVE_GATED_TYPES) {
    assert.ok(!DESCRIPTORS.some((descriptor) => descriptor.type === type), `${type} has no descriptor`);
    assert.ok(!M1_TYPES.includes(type), `${type} is not collected`);
  }

  const paths = [];
  const reader = { async collect(version, path) { paths.push(path); return { items: [], pages: 1, status: 200, error: null }; } };
  const { coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  await collectM1(reader, { tenantId: 'fixture-tenant' });
  assert.ok(!paths.some((path) => path.startsWith('/deviceManagement/templates')), 'no read of the templates');
  assert.equal(coverageDigest[TEMPLATE], undefined, 'never an invented empty list');
});

test('the gated kind already has its name and group, so switching it on needs no portal change', () => {
  const info = typeInfo(TEMPLATE);
  assert.equal(info.known, true);
  assert.equal(info.name, 'Endpoint security template');
  assert.equal(info.service, 'Intune');
  assert.equal(info.category, 'configuration');
});
