import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOADS } from '../collect/workloadContract.mjs';
import { PRIORITIES, SERVICES, SERVICE_FILES, TAXONOMY, compareTypes, typeInfo } from './taxonomy.mjs';

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
