// The permission catalogue (permissionCatalog.mjs) against the code that uses each
// permission. A permission the code starts using must be listed, or the setup page would
// call it "not used by Keel"; a listed permission nothing uses must go, or the page would
// ask admins to grant it.
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { KEEL_PERMISSIONS, PERMISSION_APIS, PERMISSION_KINDS, PERMISSION_SERVICES, PERMISSION_TYPES, apiForAppId } from './permissionCatalog.mjs';
import { registeredWorkloads } from './prerequisites.mjs';
import { READ_GRANTS } from '../discovery/grants.mjs';
import { WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { EXPANSION_INVENTORY, WORKLOAD_WRITE_OPERATIONS } from '../coverage/qualification.mjs';
import { WKLD_WRITE_OPERATIONS } from '../restore/workloads/writeDeclarations.mjs';
import { UNIFIED_AUDIT } from '../identity/auditSources.mjs';

// Discovery names these as hints only; Keel reads no people's data, so it never uses them.
const NEVER_USED_HINTS = new Set(['CallRecords.Read.All', 'Bookings.Read.All', 'SubjectRightsRequest.Read.All']);

// Every `permissions: [...]` list and `permission: '...'` value inside a declaration.
function declared(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => declared(item, out));
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'permissions' && Array.isArray(inner)) inner.forEach((name) => out.add(name));
      else if (key === 'permission' && typeof inner === 'string') out.add(inner.split(' ')[0]);
      else declared(inner, out);
    }
  }
  return out;
}

function collectorUses() {
  const names = new Set(Object.values(READ_GRANTS).filter((name) => !NEVER_USED_HINTS.has(name)));
  declared(WORKLOAD_DESCRIPTORS, names);
  for (const requirement of registeredWorkloads()) {
    if (requirement.identity === 'collector') requirement.graphPermissions.forEach((name) => names.add(name));
  }
  return names;
}

function restorerUses() {
  const names = new Set();
  declared(WKLD_WRITE_OPERATIONS, names);
  declared(WORKLOAD_WRITE_OPERATIONS, names);
  for (const entry of Object.values(EXPANSION_INVENTORY)) {
    if (entry.status === 'qualified-subset') names.add(entry.permission.split(' ')[0]);
  }
  for (const requirement of registeredWorkloads()) {
    if (requirement.identity === 'restorer') requirement.graphPermissions.forEach((name) => names.add(name));
  }
  const dir = new URL('../restore/', import.meta.url);
  for (const file of readdirSync(dir).filter((name) => name.endsWith('Operations.mjs'))) {
    for (const match of readFileSync(new URL(file, dir), 'utf8').matchAll(/permission: '([A-Za-z0-9.]+)'/g)) names.add(match[1]);
  }
  return names;
}

const listed = (identity) => new Set(KEEL_PERMISSIONS.filter((entry) => entry.identity === identity).map((entry) => entry.name));

test('every permission the backup reader uses is listed, and every listed one is used', () => {
  const uses = collectorUses();
  const names = listed('collector');
  assert.deepEqual([...uses].filter((name) => !names.has(name)).sort(), [], 'used by the code but missing from the catalogue');
  const optional = new Set(KEEL_PERMISSIONS.filter((entry) => entry.need === 'optional').map((entry) => entry.name));
  assert.deepEqual([...names].filter((name) => !uses.has(name) && !optional.has(name)).sort(), [], 'listed as required but nothing uses it');
});

test('every permission the restore writer uses is listed, and every listed one is used', () => {
  const uses = restorerUses();
  const names = listed('restorer');
  assert.deepEqual([...uses].filter((name) => !names.has(name)).sort(), [], 'used by the code but missing from the catalogue');
  assert.deepEqual([...names].filter((name) => !uses.has(name)).sort(), [], 'listed but nothing uses it');
});

test('the backup reader is read-only and the Purview audit search is the planned optional permission', () => {
  for (const entry of KEEL_PERMISSIONS.filter((candidate) => candidate.identity === 'collector')) {
    assert.ok(!/ReadWrite|\.Create/.test(entry.name), `${entry.name} is a write permission on the backup reader`);
  }
  const optional = KEEL_PERMISSIONS.filter((entry) => entry.need === 'optional');
  assert.deepEqual(optional.map((entry) => entry.name), [UNIFIED_AUDIT.permission]);
});

test('each entry names a known API, service and kind, has words, and appears once', () => {
  const services = new Set(PERMISSION_SERVICES.map((service) => service.key));
  const seen = new Set();
  for (const entry of KEEL_PERMISSIONS) {
    assert.ok(PERMISSION_APIS[entry.api], `${entry.name}: unknown API ${entry.api}`);
    assert.ok(services.has(entry.service), `${entry.name}: unknown service ${entry.service}`);
    assert.ok(PERMISSION_KINDS.includes(entry.kind), `${entry.name}: unknown kind ${entry.kind}`);
    assert.ok(PERMISSION_TYPES.includes(entry.type), `${entry.name}: unknown type ${entry.type}`);
    assert.ok(entry.words && entry.usedFor && entry.words !== entry.name, `${entry.name}: needs plain words`);
    const key = `${entry.identity}:${entry.type}:${entry.api}:${entry.name}`;
    assert.ok(!seen.has(key), `${key} is listed twice`);
    seen.add(key);
  }
  assert.equal(apiForAppId(PERMISSION_APIS.exchange.appId), 'exchange');
  assert.equal(apiForAppId('not-an-api'), null);
});
