import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { WORKLOAD_COLLECTORS } from '../collect/workloads/registry.mjs';
import { WORKLOADS } from '../collect/workloadContract.mjs';
import { EDGE_TAXONOMY, OTHER_CATEGORY, PRIORITIES, SERVICES, SERVICE_FILES, TAXONOMY, compareInService, compareTypes, placeUnmapped, typeInfo } from './taxonomy.mjs';

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
      assert.ok(category.match instanceof RegExp, `${service}: group ${category.key} needs a match pattern, so a kind Keel has not mapped yet still lands in it`);
      assert.match(category.name, /^[A-Z][a-z]/, `${service}: group name "${category.name}" reads as words`);
    }
  }
  for (const entry of [...Object.values(TAXONOMY), ...Object.values(EDGE_TAXONOMY)]) assert.notEqual(entry.category, OTHER_CATEGORY.key, `${entry.type} has no group`);
});

test('every service lists all its groups up front, so a kind not mapped yet lands in its group', () => {
  const unprefixed = SERVICE_FILES.filter((file) => !file.prefix).map((file) => file.service);
  assert.deepEqual(unprefixed, ['Entra'], 'only Entra places Graph type names with no service prefix');
  for (const file of SERVICE_FILES.filter((entry) => entry.prefix)) {
    assert.ok(file.prefix instanceof RegExp, `${file.service}: prefix is a pattern`);
    assert.ok(file.categories.some((category) => category.key === file.fallback), `${file.service}: fallback "${file.fallback}" is one of its groups`);
  }
  // The patterns agree with the hand-placed lists: every mapped kind, read as if it were
  // new, lands in the service and group it is listed under.
  const wrong = [...Object.values(TAXONOMY), ...Object.values(EDGE_TAXONOMY)]
    .map((entry) => ({ entry, placed: placeUnmapped(entry.type) }))
    .filter(({ entry, placed }) => placed?.service !== entry.service || placed?.category !== entry.category)
    .map(({ entry, placed }) => `${entry.type}: listed under ${entry.service}/${entry.category}, patterns say ${placed ? `${placed.service}/${placed.category}` : 'nowhere'}`);
  assert.deepEqual(wrong, [], 'fix the prefix or match patterns in engine/insights/taxonomy.d/');
  // Kinds Keel does not read yet still land in the right group.
  const future = {
    exchangeTransportRule: ['Exchange', 'Mail flow and protection'],
    exchangeAcceptedDomain: ['Exchange', 'Mail flow and protection'],
    exchangeDistributionGroup: ['Exchange', 'Groups and address lists'],
    exchangeInboxRule: ['Exchange', 'Mailboxes'],
    exchangeOwaMailboxPolicy: ['Exchange', 'Sharing and client access'],
    exchangeMobileDeviceMailboxPolicy: ['Exchange', 'Filtering, retention and mobile'],
    exchangeOrganizationConfig: ['Exchange', 'Organization settings'],
    'exchange-something-new': ['Exchange', 'Organization settings'],
    teamsMeetingPolicy: ['Teams', 'Calling and meetings'],
    teamsAppPermissionPolicy: ['Teams', 'Organization policies'],
    sharepointSharingSetting: ['SharePoint', 'Sharing and access control'],
    purviewInsiderRiskPolicy: ['Purview', 'Insider risk and communication rules'],
    powerPlatformEnvironment: ['Power Platform', 'Environments'],
    defenderAntiPhishPolicy: ['Defender', 'Threat policies and rules'],
    windowsUpdateRing: ['Intune', 'Windows updates'],
    accessReviewHistoryDefinition: ['Entra', 'Access reviews and governance'],
    conditionalAccessTemplate: ['Entra', 'Sign-in rules and methods'],
  };
  for (const [type, [service, group]] of Object.entries(future)) {
    const info = typeInfo(type);
    assert.deepEqual([info.service, info.categoryName, info.known], [service, group, false], type);
  }
});

test('every kind a collector or restore stores under a service code lands in that service\'s groups', () => {
  // Codes such as "exchangeTransportRule" or "teamsMeetingPolicy" that the engine stores
  // but the taxonomy does not map one by one. Read from the source, so a new one is covered.
  const prefixes = { exchange: 'Exchange', teams: 'Teams', purview: 'Purview', sharepoint: 'SharePoint', onedrive: 'SharePoint', powerPlatform: 'Power Platform', powerBi: 'Power Platform', defender: 'Defender' };
  const pattern = new RegExp(`'((${Object.keys(prefixes).join('|')})[A-Z][A-Za-z]+)'`, 'g');
  const codes = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) {
        for (const match of readFileSync(path, 'utf8').matchAll(pattern)) codes.set(match[1], prefixes[match[2]]);
      }
    }
  };
  for (const dir of ['collect', 'restore', 'govern']) walk(fileURLToPath(new URL(`../${dir}/`, import.meta.url)));
  assert.ok(codes.size > 50, `reads the stored codes (${codes.size})`);
  const wrong = [...codes].filter(([code, service]) => typeInfo(code).service !== service || typeInfo(code).category === OTHER_CATEGORY.key);
  assert.deepEqual(wrong, [], 'extend the prefix or match patterns in engine/insights/taxonomy.d/');
  const expected = {
    exchangeTransportRule: 'Mail flow and protection',
    exchangeInboundConnector: 'Mail flow and protection',
    exchangeSafeLinksRule: 'Mail flow and protection',
    exchangeMailboxRetention: 'Mailboxes',
    exchangeAddressList: 'Groups and address lists',
    exchangeClientAccess: 'Sharing and client access',
    exchangeRetentionPolicyTag: 'Filtering, retention and mobile',
    exchangeOrganizationConfig: 'Organization settings',
    teamsMeetingPolicy: 'Calling and meetings',
    teamsGuestMessagingConfiguration: 'Organization policies',
    teamsMembership: 'Teams and members',
    purviewDlpRule: 'Retention and data loss prevention',
    purviewRetentionLabel: 'Retention labels and eDiscovery',
    sharepointAccessSettings: 'Sharing and access control',
  };
  for (const [code, group] of Object.entries(expected)) assert.equal(typeInfo(code).categoryName, group, code);
  // A code stored without its service prefix is placed by the service the row is under.
  assert.equal(typeInfo('transportRule', 'Exchange').categoryName, 'Mail flow and protection');
  assert.equal(typeInfo('meetingPolicy', 'Teams').categoryName, 'Calling and meetings');
  assert.equal(typeInfo('transportRule').categoryName, 'Other settings');
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
