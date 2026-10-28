// Issue #641: every pre-approval policy restore was refused before planning,
// because the permission ids it lists were stored with a null symbol
// ("cannot resolve reference ... unresolvable-at-collection"). A permission id
// belongs to the API that publishes it and is the same in every tenant, so it
// is written as stored. These tests run collection-side canonicalization and
// the restore resolver together, the way a dry run meets them.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalizeAll } from './canonicalize.mjs';
import { resolveSymbol } from '../graph/resolver.mjs';

const GRAPH_APP = '00000003-0000-0000-c000-000000000000';
// ChatMessage.Read.Chat: a resource-specific permission, not one of Graph's appRoles.
const RSC_PERMISSION = '9398a6a2-5ef1-4f3b-9c84-0f5d5e3a8b11';
const APP_ROLE = '7b2449af-6ccd-4f4d-9f78-e550c193f0d1';
const UNKNOWN = 'c0ffee00-1111-4222-8333-444444444444';

const resolverContext = { targetIndex: new Map(), mappingTable: new Map(), runProvenance: new Map() };

const preApprovalPolicy = (permissionIds) => ({
  id: 'b9a1b1c2-0000-4000-8000-000000000641',
  conditions: [{
    scopeType: 'chat',
    sensitivityLabels: { '@odata.type': '#microsoft.graph.allScopeSensitivityLabels', labelKind: 'all' },
    permissions: {
      '@odata.type': '#microsoft.graph.enumeratedPreApprovedPermissions',
      permissionKind: 'enumerated', permissionType: 'application', resourceApplicationId: GRAPH_APP, permissionIds,
    },
  }],
});

const referencesOf = (collected, type) => canonicalizeAll(collected).find((r) => r.resourceType === type).references;

test('a pre-approval policy stores its permission ids with a symbol the restore resolves', () => {
  const refs = referencesOf([['permissionGrantPreApprovalPolicy', [preApprovalPolicy([RSC_PERMISSION])]]], 'permissionGrantPreApprovalPolicy');
  const ref = refs.find((r) => r.field === 'conditions[0].permissions.permissionIds[0]');
  assert.ok(ref, JSON.stringify(refs));
  assert.notEqual(ref.symbol, null, 'never stored with a null symbol');
  assert.equal(ref.klass, 'globalConstant');
  const resolved = resolveSymbol(ref.symbol, resolverContext);
  assert.equal(resolved.resolved, true, JSON.stringify(resolved));
  assert.equal(resolved.via, 'global-constant', 'written as stored');
  // Every reference the policy holds resolves, so the dry run can plan it.
  for (const r of refs) assert.equal(resolveSymbol(r.symbol, resolverContext).resolved, true, r.field);
});

test('a permission id published by a collected service principal still resolves through it', () => {
  const graphSp = { id: 'sp-graph', appId: GRAPH_APP, displayName: 'Microsoft Graph', appRoles: [{ id: APP_ROLE, value: 'Chat.Read.All' }] };
  const refs = referencesOf([
    ['servicePrincipal', [graphSp]],
    ['permissionGrantPreApprovalPolicy', [preApprovalPolicy([APP_ROLE, RSC_PERMISSION])]],
  ], 'permissionGrantPreApprovalPolicy');
  const named = refs.find((r) => r.field === 'conditions[0].permissions.permissionIds[0]');
  assert.equal(named.klass, 'resolvable');
  assert.match(named.symbol, /^permission:/);
  assert.equal(resolveSymbol(named.symbol, resolverContext).via, 'resource-permission');
  const rsc = refs.find((r) => r.field === 'conditions[0].permissions.permissionIds[1]');
  assert.equal(rsc.klass, 'globalConstant');
});

test('a permission grant policy condition set lists permission ids the same way', () => {
  const policy = {
    id: 'keel-rt-641-grant-policy',
    includes: [{ id: 'set-1', permissionType: 'application', resourceApplication: GRAPH_APP, permissions: [RSC_PERMISSION] }],
    excludes: [{ id: 'set-2', permissionType: 'delegated', resourceApplication: GRAPH_APP, permissions: [RSC_PERMISSION] }],
  };
  const refs = referencesOf([['permissionGrantPolicy', [policy]]], 'permissionGrantPolicy');
  for (const field of ['includes[0].permissions[0]', 'excludes[0].permissions[0]']) {
    const ref = refs.find((r) => r.field === field);
    assert.ok(ref, `${field} in ${JSON.stringify(refs)}`);
    assert.equal(ref.klass, 'globalConstant', field);
  }
});

test('an unknown id outside the permission list is still refused, never written blind', () => {
  const policy = preApprovalPolicy([RSC_PERMISSION]);
  policy.conditions[0].permissions.someTenantObjectId = UNKNOWN;
  const refs = referencesOf([['permissionGrantPreApprovalPolicy', [policy]]], 'permissionGrantPreApprovalPolicy');
  const ref = refs.find((r) => r.field === 'conditions[0].permissions.someTenantObjectId');
  assert.equal(ref.symbol, null);
  assert.equal(resolveSymbol(ref.symbol, resolverContext).reason, 'unresolvable-at-collection');
});
