// Issue #542: one resolver for the PowerShell config each family connects with.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { familyConfigPath, restorerSibling, workloadPowershellConfigPath } from './powershellConfigs.mjs';

const TENANT_ID = '0a1b2c3d-0000-4000-8000-000000000001';
const files = new Map(Object.entries({
  '/etc/keel/exchange-collector.json': { tenantId: TENANT_ID, clientId: 'collector', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/exchange-restorer.json': { tenantId: TENANT_ID, clientId: 'restorer', organization: 'contoso.onmicrosoft.com' },
  '/etc/keel/purview-collector.json': { organization: 'contoso.onmicrosoft.com', clientId: 'purview-collector' },
  '/etc/keel/same-app-restorer.json': { tenantId: TENANT_ID, clientId: 'collector' },
  '/etc/keel/other-restorer.json': { tenantId: '0a1b2c3d-0000-4000-8000-000000000099', clientId: 'restorer' },
}).map(([path, value]) => [path, JSON.stringify(value)]));
const readFile = (path) => {
  if (!files.has(path)) throw new Error(`unexpected read: ${path}`);
  return files.get(path);
};
const exists = (path) => files.has(path);
const scope = { powershellConfigs: { exchange: '/etc/keel/exchange-collector.json', purview: '/etc/keel/purview-collector.json' } };
const resolveFor = (family, role, extra = {}) => familyConfigPath(family, { role, scope, tenantId: TENANT_ID, readFile, exists, ...extra });

test('the collector uses powershellConfigs; the restorer uses the -restorer.json sibling when it exists', () => {
  assert.equal(resolveFor('exchange', 'collector'), '/etc/keel/exchange-collector.json');
  assert.equal(resolveFor('exchange', 'restorer'), '/etc/keel/exchange-restorer.json');
  assert.equal(resolveFor('purview', 'collector'), '/etc/keel/purview-collector.json');
  // No purview-restorer.json on this host: the caller keeps its own file.
  assert.equal(resolveFor('purview', 'restorer'), null);
  assert.equal(resolveFor('teams', 'collector'), null);
  assert.equal(resolveFor(null, 'restorer'), null);
  assert.equal(restorerSibling('/etc/keel/exchange-collector.json'), '/etc/keel/exchange-restorer.json');
  assert.equal(restorerSibling('/etc/keel/tenant.json'), null);
});

test('powershellRestorerConfigs names the restorer file explicitly and wins over the sibling', () => {
  files.set('/etc/keel/exo-writer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer' }));
  const explicit = { ...scope, powershellRestorerConfigs: { exchange: '/etc/keel/exo-writer.json' } };
  assert.equal(resolveFor('exchange', 'restorer', { scope: explicit }), '/etc/keel/exo-writer.json');
});

test('a workload maps to its family, the way the collect connects', () => {
  const options = { role: 'collector', scope, tenantId: TENANT_ID, readFile, exists };
  assert.equal(workloadPowershellConfigPath('exchange-mail-flow', options), '/etc/keel/exchange-collector.json');
  assert.equal(workloadPowershellConfigPath('purview-labels', options), '/etc/keel/purview-collector.json');
  assert.equal(workloadPowershellConfigPath('sharepoint-site-grants', options), null);
});

test('another tenant, the collector registration, a path outside /etc/keel or an unknown family is refused', () => {
  assert.throws(() => resolveFor('exchange', 'restorer', { scope: { ...scope, powershellRestorerConfigs: { exchange: '/etc/keel/other-restorer.json' } } }), /names another tenant/);
  assert.throws(() => resolveFor('exchange', 'restorer', { scope: { ...scope, powershellRestorerConfigs: { exchange: '/etc/keel/same-app-restorer.json' } } }), /separate Restorer/);
  assert.throws(() => resolveFor('exchange', 'restorer', { scope: { ...scope, powershellRestorerConfigs: { exchange: '/etc/keel/exchange-collector.json' } } }), /separate Restorer/);
  assert.throws(() => resolveFor('exchange', 'restorer', { scope: { ...scope, powershellRestorerConfigs: { exchange: '/tmp/restorer.json' } } }), /under \/etc\/keel/);
  assert.throws(() => resolveFor('exchange', 'collector', { scope: { powershellConfigs: { entra: '/etc/keel/exchange-collector.json' } } }), /not a PowerShell family/);
  assert.throws(() => resolveFor('exchange', 'writer'), /unknown role/);
});

test('a restorer file must name the tenant and share no app or certificate with any collector', () => {
  files.set('/etc/keel/no-tenant-restorer.json', JSON.stringify({ clientId: 'restorer' }));
  files.set('/etc/keel/same-cert-restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'restorer', certPath: '/etc/keel/collector.pem' }));
  const named = (path) => ({ scope: { ...scope, powershellRestorerConfigs: { exchange: path, teams: path } } });
  assert.throws(() => resolveFor('exchange', 'restorer', named('/etc/keel/no-tenant-restorer.json')), /names no tenantId/);
  // A family with no collector file is still checked against the Graph collector.
  const graphCollector = { tenantId: TENANT_ID, clientId: 'graph-collector', certPath: '/etc/keel/collector.pem' };
  assert.throws(() => resolveFor('teams', 'restorer', { ...named('/etc/keel/same-cert-restorer.json'), separateFrom: [graphCollector] }), /separate Restorer/);
  assert.throws(() => resolveFor('teams', 'restorer', { ...named('/etc/keel/exchange-restorer.json'), separateFrom: [{ clientId: 'restorer' }] }), /separate Restorer/);
  assert.equal(resolveFor('teams', 'restorer', { ...named('/etc/keel/exchange-restorer.json'), separateFrom: [graphCollector] }), '/etc/keel/exchange-restorer.json');
});

test('a restorer file is refused when it is or shares an app with another family\'s collector file', () => {
  files.set('/etc/keel/purview-app-restorer.json', JSON.stringify({ tenantId: TENANT_ID, clientId: 'purview-collector' }));
  const named = (path) => ({ scope: { ...scope, powershellRestorerConfigs: { exchange: path } } });
  assert.throws(() => resolveFor('exchange', 'restorer', named('/etc/keel/purview-app-restorer.json')), /separate Restorer/);
  assert.throws(() => resolveFor('exchange', 'restorer', named('/etc/keel/purview-collector.json')), /separate Restorer/);
});
