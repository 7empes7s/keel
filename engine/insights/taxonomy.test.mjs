import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOADS } from '../collect/workloadContract.mjs';
import { EDGE_TAXONOMY, OTHER_CATEGORY, PRIORITIES, SERVICES, SERVICE_FILES, TAXONOMY, compareInService, compareTypes, typeInfo } from './taxonomy.mjs';

const DIR = new URL('./taxonomy.d/', import.meta.url);

test('every taxonomy.d file is imported and listed in SERVICE_FILES', async () => {
  const source = readFileSync(new URL('./taxonomy.mjs', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/from '\.\/taxonomy\.d\/([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...imported].sort(), readdirSync(DIR).filter((name) => name.endsWith('.mjs')).sort());
  const files = await Promise.all(imported.map(async (name) => (await import(new URL(name, DIR))).default));
  assert.deepEqual(new Set(SERVICE_FILES), new Set(files));
});

test('every catalogued type and workload read has an entry', () => {
  const required = new Set([
    ...CATALOG.map((entry) => entry.type),
    ...WORKLOAD_COLLECTORS.map((collector) => collector.workload),
    ...WORKLOADS,
  ]);
  const missing = [...required].filter((type) => !TAXONOMY[type]);
  assert.deepEqual(missing, [], `add these to engine/insights/taxonomy.d/: ${missing.join(', ')}`);
  const stale = Object.keys(TAXONOMY).filter((type) => !required.has(type));
  assert.deepEqual(stale, [], `these entries match no catalogued type or workload: ${stale.join(', ')}`);
});

test('every entry has a plain name, a known service and a priority with a reason', () => {
  for (const entry of Object.values(TAXONOMY)) {
    assert.ok(SERVICES.includes(entry.service), `${entry.type}: service ${entry.service}`);
    assert.ok(PRIORITIES.includes(entry.priority), `${entry.type}: priority ${entry.priority}`);
    assert.match(entry.priorityReason ?? '', /^[A-Z].+\.$/, `${entry.type}: reason is one sentence`);
    assert.match(entry.name, /^[A-Za-z]/, `${entry.type}: name starts with a letter`);
    const prose = entry.name.replace(/\b(macOS|eDiscovery|PowerShell|SharePoint|OneDrive|PowerPoint)\b/g, '');
    assert.doesNotMatch(prose, /[a-z][A-Z]|_/, `${entry.type}: name "${entry.name}" reads as a code`);
    assert.ok(!entry.name.endsWith('.'), `${entry.type}: name is not a sentence`);
  }
});

test('names are unique within a service, so a grouped list never shows two identical rows', () => {
  const seen = new Map();
  for (const entry of Object.values(TAXONOMY)) {
    const key = `${entry.service}:${entry.name.toLowerCase()}`;
    assert.ok(!seen.has(key), `${entry.type} and ${seen.get(key)} are both "${entry.name}"`);
    seen.set(key, entry.type);
  }
});

test('catalogue types take their priority from blast radius and criticality', () => {
  assert.deepEqual(
    { name: TAXONOMY.conditionalAccessPolicy.name, service: TAXONOMY.conditionalAccessPolicy.service, priority: TAXONOMY.conditionalAccessPolicy.priority },
    { name: 'Conditional Access policy', service: 'Entra', priority: 'critical' },
  );
  assert.equal(TAXONOMY.servicePrincipal.priority, 'high');
  assert.equal(TAXONOMY.deviceConfiguration.priority, 'normal');
  assert.equal(TAXONOMY.deviceConfiguration.service, 'Intune');
  assert.equal(TAXONOMY.organizationalBranding.priority, 'low');
  assert.equal(TAXONOMY['purview-retention-dlp'].priority, 'critical');
});

test('an unmapped code still reads as words and says it is not classified', () => {
  assert.deepEqual(typeInfo('someNewPolicyType'), {
    type: 'someNewPolicyType',
    name: 'Some new policy type',
    service: null,
    priority: 'normal',
    priorityReason: 'Not classified yet.',
    category: 'other',
    categoryName: 'Other settings',
    categoryRank: 99,
    typeRank: 0,
    known: false,
  });
  assert.equal(typeInfo('group').known, true);
  assert.equal(typeInfo('').name, 'Unknown type');
});

test('compareTypes ranks the most urgent first, then by service and name', () => {
  const sorted = ['organizationalBranding', 'someNewType', 'deviceConfiguration', 'servicePrincipal', 'conditionalAccessPolicy']
    .sort(compareTypes);
  assert.deepEqual(sorted, ['conditionalAccessPolicy', 'servicePrincipal', 'deviceConfiguration', 'someNewType', 'organizationalBranding']);
});

test('every entry sits in exactly one group of kinds in its own service file, so no list shows it ungrouped', () => {
  for (const { service, entries: catalogued, edges = {}, categories } of SERVICE_FILES) {
    const entries = { ...catalogued, ...edges };
    assert.ok(Array.isArray(categories) && categories.length, `${service}: add categories to its taxonomy.d file`);
    const placed = categories.flatMap((category) => category.types);
    const twice = placed.filter((type, index) => placed.indexOf(type) !== index);
    assert.deepEqual(twice, [], `${service}: in more than one group: ${twice.join(', ')}`);
    const ungrouped = Object.keys(entries).filter((type) => !placed.includes(type));
    assert.deepEqual(ungrouped, [], `${service}: put these in a group in its taxonomy.d file: ${ungrouped.join(', ')}`);
    const foreign = placed.filter((type) => !entries[type]);
    assert.deepEqual(foreign, [], `${service}: groups name types this file does not map: ${foreign.join(', ')}`);
    const keys = categories.map((category) => category.key);
    assert.equal(new Set(keys).size, keys.length, `${service}: group keys are unique`);
    assert.ok(!keys.includes(OTHER_CATEGORY.key), `${service}: "${OTHER_CATEGORY.key}" is kept for unplaced types`);
    for (const category of categories) {
      assert.ok(category.types.length, `${service}: group ${category.key} is empty`);
      assert.match(category.name, /^[A-Z][a-z]/, `${service}: group name "${category.name}" reads as words`);
    }
  }
  for (const entry of [...Object.values(TAXONOMY), ...Object.values(EDGE_TAXONOMY)]) assert.notEqual(entry.category, OTHER_CATEGORY.key, `${entry.type} has no group`);
});

test('every link type an edge change can store has an entry, a service and a priority', async () => {
  const source = readFileSync(new URL('../govern/diffSnapshots.mjs', import.meta.url), 'utf8');
  const block = /const EDGE_RESOURCE_TYPE = \{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
  const stored = [...block.matchAll(/:\s*'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.ok(stored.length >= 7, 'reads the edge types from diffSnapshots.mjs');
  for (const type of stored) {
    const entry = EDGE_TAXONOMY[type];
    assert.ok(entry, `add ${type} to an edges map in engine/insights/taxonomy.d/`);
    assert.ok(SERVICES.includes(entry.service) && PRIORITIES.includes(entry.priority), `${type}: service and priority`);
    assert.ok(!TAXONOMY[type], `${type} is both a catalogue type and a link`);
  }
});

test('inside a service, people and objects come before roles, policies and settings', () => {
  const entra = ['organization', 'conditionalAccessPolicy', 'roleAssignment', 'group', 'user', 'servicePrincipal'].sort(compareInService);
  assert.deepEqual(entra, ['user', 'group', 'roleAssignment', 'servicePrincipal', 'conditionalAccessPolicy', 'organization']);
  assert.deepEqual(['someNewType', 'deviceConfiguration', 'managedDevice'].sort(compareInService), ['managedDevice', 'deviceConfiguration', 'someNewType']);
  assert.equal(typeInfo('user').categoryName, 'Users and contacts');
  assert.equal(typeInfo('exchange-mail-flow').categoryName, 'Mail flow and protection');
  assert.deepEqual(['roleAssignment', 'groupMembership', 'group'].sort(compareInService), ['group', 'groupMembership', 'roleAssignment']);
  assert.equal(typeInfo('groupMembership').service, 'Entra');
});
