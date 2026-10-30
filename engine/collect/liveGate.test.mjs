// A catalogue type with `liveGate` is declared but never collected until a
// live read of it passes. Endpoint security templates (deviceManagementTemplate)
// passed theirs on 2026-10-30 (operator queue Q283) and are collected.
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { CATALOG, catalogEntryFor, catalogReadPath } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS, LIVE_GATED_TYPES, descriptorsFor } from './descriptors.mjs';
import { collectWithOutcomes, M1_TYPES } from './entraAdapter.mjs';
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

test('after its live read check, the template list is collected', async () => {
  assert.equal(catalogEntryFor(TEMPLATE).liveGate, undefined);
  assert.ok(M1_TYPES.includes(TEMPLATE));
  const paths = [];
  const reader = { async collect(version, path) {
    paths.push(path);
    const items = path.startsWith('/deviceManagement/templates')
      ? [{ id: 'tpl-1', displayName: 'Endpoint detection and response', templateType: 'securityTemplate', templateSubtype: 'endpointDetectionReponse' }]
      : [];
    return { items, pages: 1, status: 200, error: null };
  } };
  const { collected, coverageDigest } = await collectWithOutcomes(reader, { tenantId: 'fixture-tenant' });
  assert.ok(paths.includes(catalogReadPath(catalogEntryFor(TEMPLATE))));
  assert.equal(coverageDigest[TEMPLATE].outcome, 'complete');
  assert.equal(new Map(collected).get(TEMPLATE)[0].templateSubtype, 'endpointDetectionReponse');
});

test('a live-gated catalogue entry gets no descriptor, so nothing collects it', () => {
  assert.deepEqual([...LIVE_GATED_TYPES], CATALOG.filter((entry) => entry.liveGate).map((entry) => entry.type));
  const gated = { type: 'keelRtGated', path: '/keelRtGated', version: 'beta', criticality: 'tier3', blastRadius: 'cosmetic', liveGate: 'fixture' };
  const descriptors = descriptorsFor([...CATALOG, gated]);
  assert.ok(!descriptors.some((descriptor) => descriptor.type === 'keelRtGated'));
  assert.deepEqual(descriptors.map((descriptor) => descriptor.type), DESCRIPTORS.map((descriptor) => descriptor.type));
});

test('the template kind has its name and group', () => {
  const info = typeInfo(TEMPLATE);
  assert.equal(info.known, true);
  assert.equal(info.name, 'Endpoint security template');
  assert.equal(info.service, 'Intune');
  assert.equal(info.category, 'configuration');
});

test('an older policy points at its template as a Microsoft constant, collected or not', async () => {
  const { canonicalizeAll, CONTEXT_EXCLUDED_TYPES } = await import('../cir/canonicalize.mjs');
  const template = '0f2b5d70-d4e9-4156-8c16-1397eb6c54a5';
  const intent = { id: '11111111-1111-4111-8111-111111111111', displayName: 'KEEL-RT-edr', templateId: template };
  const referenceOf = (collected) => canonicalizeAll(collected)
    .find((row) => row.resourceType === 'deviceManagementIntent').references.find((ref) => ref.field === 'templateId');
  const alone = referenceOf([['deviceManagementIntent', [intent]]]);
  const withTemplates = referenceOf([
    ['deviceManagementIntent', [intent]],
    [TEMPLATE, [{ id: template, displayName: 'Endpoint detection and response', templateSubtype: 'endpointDetectionReponse' }]],
  ]);
  assert.deepEqual(withTemplates, alone, 'reading the templates never turns the reference into a tenant object');
  assert.equal(withTemplates.klass, 'globalConstant');
  assert.equal(withTemplates.symbol, `global:${template}`);
  assert.ok(CONTEXT_EXCLUDED_TYPES.has(TEMPLATE), 'template ids are never stored as tenant identity');
});
