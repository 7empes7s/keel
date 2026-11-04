/**
 * Issue #993: connected organizations and access package assignment policies
 * (entitlementPolicyOperations.mjs), against an in-memory entitlement
 * management Graph. The applyWave tests drive the production path: this file
 * is the remapping proof qualification.mjs records for both kinds.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { remappingFor } from '../coverage/qualification.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { policyLoosenings } from './entitlementPolicyOperations.mjs';
import { applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const EM = '/identityGovernance/entitlementManagement';
const ORGS = `${EM}/connectedOrganizations`;
const POLICIES = `${EM}/assignmentPolicies`;
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' };

const PARTNER_TENANT = 'cccccccc-0000-4000-8000-000000000001';
const SOURCE_ORG = 'aaaaaaaa-0000-4000-8000-000000000010';
const SOURCE_SPONSOR = 'aaaaaaaa-0000-4000-8000-000000000011';
const TARGET_SPONSOR = 'bbbbbbbb-0000-4000-8000-000000000011';
const GONE_SPONSOR = 'aaaaaaaa-0000-4000-8000-000000000012';
const SOURCE_PACKAGE = 'aaaaaaaa-0000-4000-8000-000000000002';
const TARGET_PACKAGE = 'bbbbbbbb-0000-4000-8000-000000000002';
const SOURCE_GROUP = 'aaaaaaaa-0000-4000-8000-000000000003';
const TARGET_GROUP = 'bbbbbbbb-0000-4000-8000-000000000003';
const SOURCE_APPROVER = 'aaaaaaaa-0000-4000-8000-000000000004';
const TARGET_APPROVER = 'bbbbbbbb-0000-4000-8000-000000000004';
const TARGET_ORG = 'bbbbbbbb-0000-4000-8000-000000000010';

const ORG_KEY = `connectedOrganization:${SOURCE_ORG}`;
const SPONSOR_KEY = 'user:ann@contoso.com';
const GONE_KEY = 'user:bob@contoso.com';
const PACKAGE_KEY = `accessPackage:${SOURCE_PACKAGE}`;
const GROUP_KEY = 'group:KEEL-RT-requestors';
const APPROVER_KEY = 'user:approver@contoso.com';

/**
 * Entitlement management in memory: connected organizations (with their
 * sponsor lists) and assignment policies (with their package). `refuseTenant`
 * makes a create of an organization naming that tenant fail as Graph does.
 */
function entitlementGraph({ orgs = [], policies = [], packages = [TARGET_PACKAGE], refuseTenant = null } = {}) {
  const state = {
    orgs: new Map(orgs.map((org) => [org.id, { internalSponsors: [], externalSponsors: [], ...structuredClone(org) }])),
    policies: new Map(policies.map((policy) => [policy.id, structuredClone(policy)])),
  };
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });
  const orgView = ({ internalSponsors, externalSponsors, ...org }) => org;
  return {
    state,
    calls,
    async read(version, path) {
      calls.push({ method: 'GET', path });
      const [base] = path.split('?');
      if (base === ORGS) return ok(200, { value: [...state.orgs.values()].map(orgView) });
      if (base === POLICIES) return ok(200, { value: [...state.policies.values()] });
      const sponsors = /^.*\/connectedOrganizations\/([^/]+)\/(internalSponsors|externalSponsors)$/.exec(base);
      if (sponsors) {
        const org = state.orgs.get(decodeURIComponent(sponsors[1]));
        return org ? ok(200, { value: org[sponsors[2]].map((id) => ({ id })) }) : notFound();
      }
      const org = /^.*\/connectedOrganizations\/([^/]+)$/.exec(base);
      if (org) {
        const found = state.orgs.get(decodeURIComponent(org[1]));
        return found ? ok(200, orgView(found)) : notFound();
      }
      const policy = /^.*\/assignmentPolicies\/([^/]+)$/.exec(base);
      if (policy) {
        const found = state.policies.get(decodeURIComponent(policy[1]));
        return found ? ok(200, found) : notFound();
      }
      return notFound();
    },
    async write(version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'POST' && path === ORGS) {
        if (refuseTenant && (body.identitySources ?? []).some((source) => source.tenantId === refuseTenant)) {
          return { ok: false, status: 400, body: { error: { code: 'InvalidTenant', message: 'The tenant could not be found.' } } };
        }
        next += 1;
        const created = { ...body, id: `created-org-${next}`, internalSponsors: [], externalSponsors: [] };
        state.orgs.set(created.id, created);
        return ok(201, orgView(created));
      }
      const sponsorRef = /^.*\/connectedOrganizations\/([^/]+)\/(internalSponsors|externalSponsors)\/\$ref$/.exec(path);
      if (method === 'POST' && sponsorRef) {
        const org = state.orgs.get(decodeURIComponent(sponsorRef[1]));
        if (!org) return notFound();
        org[sponsorRef[2]].push(body['@odata.id'].split('/').pop());
        return ok(204, null);
      }
      const orgPatch = /^.*\/connectedOrganizations\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && orgPatch) {
        const found = state.orgs.get(decodeURIComponent(orgPatch[1]));
        if (!found) return notFound();
        Object.assign(found, body);
        return ok(202, orgView(found));
      }
      if (method === 'POST' && path === POLICIES) {
        if (!packages.includes(body.accessPackage?.id)) return { ok: false, status: 400, body: { error: { code: 'AccessPackageNotFound' } } };
        next += 1;
        const created = { ...body, id: `created-policy-${next}` };
        state.policies.set(created.id, created);
        return ok(201, created);
      }
      const policyPut = /^.*\/assignmentPolicies\/([^/]+)$/.exec(path);
      if (method === 'PUT' && policyPut) {
        const id = decodeURIComponent(policyPut[1]);
        if (!state.policies.has(id)) return notFound();
        state.policies.set(id, { ...body, id });
        return ok(200, { ...body, id });
      }
      return notFound();
    },
  };
}

const context = (targets = []) => ({ targetIndex: new Map(targets), mappingTable: new Map(), runProvenance: new Map() });
const withRefs = (referenceContext, extra = {}) => ({ ...FAST, referenceContext, ...extra });
const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const noTrustOrExtension = (graph) => {
  for (const { body } of writes(graph)) {
    const keys = JSON.stringify(body ?? {}).match(/"([^"]+)":/g) ?? [];
    for (const key of keys) {
      const name = key.slice(1, -2);
      assert.equal(TRUST_FIELD_PATTERN.test(name), false, `no trust field in a body: ${name}`);
      assert.equal(/customExtension/i.test(name), false, `no custom extension in a body: ${name}`);
    }
  }
};
const approved = (resource, verb = 'create') => classifyContentEffects([{ ...resource, verb }]).effects;

// ------------------------------------------------------ connected organization

const tenantSource = { '@odata.type': '#microsoft.graph.azureActiveDirectoryTenant', tenantId: PARTNER_TENANT, displayName: 'Fabrikam' };
const domainSource = { '@odata.type': '#microsoft.graph.domainIdentitySource', domainName: 'fabrikam.example', displayName: 'Fabrikam mail' };
const federationSource = { '@odata.type': '#microsoft.graph.externalDomainFederation', domainName: 'tailspin.example', displayName: 'Tailspin', issuerUri: 'https://sts.tailspin.example/adfs' };

const orgResource = (extra = {}) => ({
  naturalKey: ORG_KEY, resourceType: 'connectedOrganization', blastRadius: 'access-affecting',
  payload: {
    id: SOURCE_ORG, displayName: 'KEEL-RT-Fabrikam', description: 'Partner', state: 'configured', createdDateTime: '2026-01-01T00:00:00Z',
    identitySources: [tenantSource, domainSource],
    internalSponsors: [{ '@odata.type': '#microsoft.graph.user', id: SOURCE_SPONSOR, displayName: 'Ann', userPrincipalName: 'ann@contoso.com' }],
  },
  references: [
    { field: 'identitySources[0].tenantId', symbol: `foreignTenant:${PARTNER_TENANT}`, required: true },
    { field: 'internalSponsors[0].id', symbol: SPONSOR_KEY, required: true },
  ],
  ...extra,
});

test('connected organizations and policies are approval-held, and a dry run shows the other tenant and domain in plain words', () => {
  assert.ok(APPROVAL_HELD_KINDS.includes('connectedOrganization'));
  assert.ok(APPROVAL_HELD_KINDS.includes('accessPackageAssignmentPolicy'));
  const effects = approved(orgResource());
  const sources = effects.find((effect) => effect.field === 'identitySources');
  assert.equal(sources.effect, 'access-changing');
  assert.deepEqual(sources.after, [
    `the Microsoft Entra organization "Fabrikam" (tenant ID ${PARTNER_TENANT})`,
    'the domain fabrikam.example ("Fabrikam mail")',
  ]);
  assert.deepEqual(effects.find((effect) => effect.field === 'internalSponsors').after, [SPONSOR_KEY]);
});

test('a connected organization is created with its identity sources and its sponsor matched in the target', async () => {
  const graph = entitlementGraph();
  const resource = orgResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  const sent = writes(graph);
  assert.equal(sent[0].path, ORGS);
  assert.deepEqual(sent[0].body, { displayName: 'KEEL-RT-Fabrikam', description: 'Partner', state: 'configured', identitySources: [tenantSource, domainSource] });
  assert.deepEqual(sent.slice(1), [{ method: 'POST', path: `${ORGS}/created-org-1/internalSponsors/$ref`, body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${TARGET_SPONSOR}` } }]);
  assert.equal(JSON.stringify(sent).includes(SOURCE_SPONSOR), false, 'never a sponsor id from the backup\'s tenant');
  assert.equal(result.applied.changes.sponsorsAdded, 1);
  noTrustOrExtension(graph);
});

test('the connected organization dry run lists the identity sources in plain words and writes nothing', async () => {
  const graph = entitlementGraph();
  const resource = orgResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { mode: 'dry-run' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(result.applied.changes.identitySources, [`the Microsoft Entra organization "Fabrikam" (tenant ID ${PARTNER_TENANT})`, 'the domain fabrikam.example ("Fabrikam mail")']);
  assert.equal(result.applied.changes.sponsorsAdded, 1);
  assert.equal(writes(graph).length, 0);
});

test('without the approval a connected organization is held, and nothing is written', async () => {
  const graph = entitlementGraph();
  const resource = orgResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.deepEqual([...result.skipped.completion[0].fields].sort(), ['identitySources', 'internalSponsors', 'state']);
  assert.equal(graph.calls.length, 0);
});

test('a sponsor missing from the target is a manual step that names them; the organization and the others are written', async () => {
  const graph = entitlementGraph();
  const base = orgResource();
  const resource = orgResource({
    payload: { ...base.payload, internalSponsors: [...base.payload.internalSponsors, { '@odata.type': '#microsoft.graph.user', id: GONE_SPONSOR, displayName: 'Bob' }] },
    references: [...base.references, { field: 'internalSponsors[1].id', symbol: GONE_KEY, required: true }],
  });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(graph.state.orgs.get('created-org-1').internalSponsors, [TARGET_SPONSOR]);
  const step = result.applied.completion.find((entry) => entry.requirement === 'sponsors');
  assert.match(step.description, /the internal sponsor bob@contoso.com does not exist in the target/);
  assert.equal(JSON.stringify(writes(graph)).includes(GONE_SPONSOR), false);
});

test('a federated domain source is never written: a manual step, and the other sources are', async () => {
  const graph = entitlementGraph();
  const base = orgResource();
  const resource = orgResource({ payload: { ...base.payload, identitySources: [domainSource, federationSource] } });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph)[0].body.identitySources, [domainSource]);
  const step = result.applied.completion.find((entry) => entry.requirement === 'trustFields');
  assert.match(step.description, /the federated domain tailspin.example/);
  noTrustOrExtension(graph);
});

test('an organization with only a federated domain source is a manual step, and nothing is written', async () => {
  const graph = entitlementGraph();
  const resource = orgResource({ payload: { ...orgResource().payload, identitySources: [federationSource] } });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: .*federated domain tailspin.example/);
  assert.equal(graph.calls.length, 0);
});

test('Graph refusing a tenant that does not exist is reported once, not retried', async () => {
  const graph = entitlementGraph({ refuseTenant: PARTNER_TENANT });
  const resource = orgResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.failed?.error ?? '', /The tenant could not be found/);
  assert.equal(graph.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(graph.state.orgs.size, 0);
});

test('a connected organization update sends only the changed fields and adds a missing sponsor', async () => {
  const live = { id: TARGET_ORG, displayName: 'KEEL-RT-Fabrikam', description: 'Changed by hand', state: 'configured', identitySources: [domainSource, tenantSource] };
  const graph = entitlementGraph({ orgs: [live] });
  const resource = orgResource({ live: { state: 'present', targetId: TARGET_ORG, payload: live } });
  const result = await applyIdentityObjectWrite(graph, resource, 'update', withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource, 'update') }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph).map((call) => `${call.method} ${call.path}`), [`PATCH ${ORGS}/${TARGET_ORG}`, `POST ${ORGS}/${TARGET_ORG}/internalSponsors/$ref`]);
  assert.deepEqual(writes(graph)[0].body, { description: 'Partner' }, 'identity sources in another order are no change');
});

test('a second restore of the same organization finds the first one and does not create it twice', async () => {
  const graph = entitlementGraph();
  const resource = orgResource();
  const ctx = withRefs(context([[SPONSOR_KEY, TARGET_SPONSOR]]), { approvedContentEffects: approved(resource) });
  assert.equal((await applyIdentityObjectWrite(graph, resource, 'create', ctx)).failed, undefined);
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /already there/);
  assert.equal(graph.calls.filter((call) => call.method === 'POST' && call.path === ORGS).length, 1);
  assert.equal(graph.state.orgs.size, 1);
});

test('a connected organization is never deleted by a restore', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, orgResource({ live: { state: 'present', targetId: TARGET_ORG, payload: orgResource().payload } }), 'delete', FAST);
  assert.match(result.failed?.error ?? '', /unsupported operation/);
  assert.equal(graph.calls.length, 0);
});

// ------------------------------------------------------- assignment policy

const user = (userId, description) => ({ '@odata.type': '#microsoft.graph.singleUser', userId, description });
const policyPayload = (extra = {}) => ({
  id: 'source-policy', displayName: 'KEEL-RT-policy', description: 'Requests from the requestors group', createdDateTime: '2026-01-01T00:00:00Z',
  allowedTargetScope: 'specificDirectoryUsers',
  specificAllowedTargets: [{ '@odata.type': '#microsoft.graph.groupMembers', groupId: SOURCE_GROUP, description: 'Requestors' }],
  expiration: { type: 'afterDuration', duration: 'P30D' },
  requestorSettings: { enableTargetsToSelfAddAccess: true, enableOnBehalfRequestorsToAddAccess: false, onBehalfRequestors: [] },
  requestApprovalSettings: {
    isApprovalRequiredForAdd: true, isApprovalRequiredForUpdate: false,
    stages: [{
      durationBeforeAutomaticDenial: 'P2D', isApproverJustificationRequired: false, isEscalationEnabled: false,
      primaryApprovers: [{ '@odata.type': '#microsoft.graph.requestorManager', managerLevel: 1 }],
      fallbackPrimaryApprovers: [user(SOURCE_APPROVER, 'Approver')], escalationApprovers: [], fallbackEscalationApprovers: [],
    }],
  },
  reviewSettings: { isEnabled: false, primaryReviewers: [], fallbackReviewers: [] },
  accessPackage: { id: SOURCE_PACKAGE, displayName: 'KEEL-RT-Package', description: 'Finance access' },
  ...extra,
});
const POLICY_REFS = [
  { field: 'accessPackage.id', symbol: PACKAGE_KEY, required: true },
  { field: 'specificAllowedTargets[0].groupId', symbol: GROUP_KEY, required: true },
  { field: 'requestApprovalSettings.stages[0].fallbackPrimaryApprovers[0].userId', symbol: APPROVER_KEY, required: true },
];
const policyResource = (extra = {}) => ({
  naturalKey: 'accessPackageAssignmentPolicy:source-policy', resourceType: 'accessPackageAssignmentPolicy', blastRadius: 'access-affecting',
  payload: policyPayload(), references: POLICY_REFS, ...extra,
});
const POLICY_TARGETS = [[PACKAGE_KEY, TARGET_PACKAGE], [GROUP_KEY, TARGET_GROUP], [APPROVER_KEY, TARGET_APPROVER]];

test('a policy is created on the target\'s package, with its requestors and approvers matched in the target', async () => {
  const graph = entitlementGraph();
  const resource = policyResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  const [post] = writes(graph);
  assert.equal(post.path, POLICIES);
  assert.deepEqual(post.body.accessPackage, { id: TARGET_PACKAGE });
  assert.equal(post.body.specificAllowedTargets[0].groupId, TARGET_GROUP);
  assert.deepEqual(post.body.requestApprovalSettings.stages[0].fallbackPrimaryApprovers, [user(TARGET_APPROVER, 'Approver')]);
  assert.deepEqual(post.body.requestApprovalSettings.stages[0].primaryApprovers, [{ '@odata.type': '#microsoft.graph.requestorManager', managerLevel: 1 }], 'a relative approver is kept as it is');
  for (const id of [SOURCE_PACKAGE, SOURCE_GROUP, SOURCE_APPROVER]) assert.equal(JSON.stringify(post).includes(id), false, 'never an id from the backup\'s tenant');
  assert.equal(result.applied.targetId, 'created-policy-1');
  noTrustOrExtension(graph);
});

test('an approver who cannot be matched holds the whole policy as a manual step that names them', async () => {
  const graph = entitlementGraph();
  const resource = policyResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context([[PACKAGE_KEY, TARGET_PACKAGE], [GROUP_KEY, TARGET_GROUP]]), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /^manual: This policy names the user approver@contoso.com \(fallback approver \(stage 1\)\), which is not in the target/);
  assert.match(result.skipped.reason, /fewer approvers/);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/.test(result.skipped.completion[0].description), false, 'no raw ids in the step');
  assert.equal(graph.calls.length, 0, 'nothing is written: not even a policy without that approver');
});

test('an approver the backup has no reference for (not in it) holds the policy too', async () => {
  const graph = entitlementGraph();
  const resource = policyResource({ references: POLICY_REFS.slice(0, 2) });
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.match(result.skipped?.reason ?? '', /names the user "Approver"/);
  assert.equal(graph.calls.length, 0);
});

test('a policy whose package is not in the target fails as a dependency', async () => {
  const graph = entitlementGraph();
  const result = await applyIdentityObjectWrite(graph, policyResource(), 'create', withRefs(context([[GROUP_KEY, TARGET_GROUP], [APPROVER_KEY, TARGET_APPROVER]])));
  assert.match(result.failed?.error ?? '', /^dependency: its access package "KEEL-RT-Package" is not in the target/);
  assert.equal(graph.calls.length, 0);
});

test('without the approval a new policy is held as a weakening, and nothing is written', async () => {
  const graph = entitlementGraph();
  const resource = policyResource();
  const result = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(POLICY_TARGETS), { mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /^manual: This weakens who can get access: it lets people request the access package/);
  assert.match(result.skipped.reason, /changes admin access/);
  assert.equal(result.skipped.completion[0].weakensProtection, true);
  assert.equal(graph.calls.length, 0);
});

const livePolicy = (extra = {}) => ({ ...policyPayload(), id: 'live-policy', accessPackage: { id: TARGET_PACKAGE },
  specificAllowedTargets: [{ '@odata.type': '#microsoft.graph.groupMembers', groupId: TARGET_GROUP, description: 'Requestors' }],
  requestApprovalSettings: { ...policyPayload().requestApprovalSettings, stages: [{ ...policyPayload().requestApprovalSettings.stages[0], fallbackPrimaryApprovers: [user(TARGET_APPROVER, 'Approver')] }] },
  ...extra });

test('an update that removes the approval step is held as a weakening until it is approved, then replaces the policy', async () => {
  const live = livePolicy({ description: 'Changed by hand' });
  const graph = entitlementGraph({ policies: [live] });
  const backup = policyPayload({ requestApprovalSettings: { isApprovalRequiredForAdd: false, isApprovalRequiredForUpdate: false, stages: [] } });
  const resource = policyResource({ payload: backup, live: { state: 'present', targetId: 'live-policy', payload: live } });
  const held = await applyIdentityObjectWrite(graph, resource, 'update', withRefs(context(POLICY_TARGETS), { mode: 'enforce' }));
  assert.match(held.skipped?.reason ?? '', /removes the approval step \(isApprovalRequiredForAdd\)/);
  assert.match(held.skipped.reason, /0 approval stage\(s\) where there are 1 now/);
  // The approval also names who may request: the backup names them by their
  // natural key, and live by the target's ids.
  assert.deepEqual(held.skipped.completion[0].fields, ['requestApprovalSettings', 'specificAllowedTargets']);
  assert.doesNotMatch(held.skipped.reason, /adds people/, 'the same requestors, matched in the target, are no loosening');
  assert.equal(writes(graph).length, 0);

  const written = await applyIdentityObjectWrite(graph, resource, 'update', withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(resource, 'update') }));
  assert.equal(written.failed, undefined, written.failed?.error);
  const [put] = writes(graph);
  assert.equal(put.method, 'PUT');
  assert.equal(put.path, `${POLICIES}/live-policy`);
  assert.deepEqual(put.body.requestApprovalSettings, { isApprovalRequiredForAdd: false, isApprovalRequiredForUpdate: false, stages: [] });
  assert.deepEqual(put.body.accessPackage, { id: TARGET_PACKAGE });
  noTrustOrExtension(graph);
});

test('an update in the same tenant that changes no access setting needs no approval', async () => {
  const live = { ...policyPayload({ description: 'Changed by hand' }), id: 'live-policy' };
  const graph = entitlementGraph({ policies: [live], packages: [SOURCE_PACKAGE] });
  const resource = policyResource({ live: { state: 'present', targetId: 'live-policy', payload: live } });
  const sameTenant = context([[PACKAGE_KEY, SOURCE_PACKAGE], [GROUP_KEY, SOURCE_GROUP], [APPROVER_KEY, SOURCE_APPROVER]]);
  const result = await applyIdentityObjectWrite(graph, resource, 'update', withRefs(sameTenant, { mode: 'enforce' }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  assert.deepEqual(result.applied.changes.fields, ['description']);
});

test('custom extensions are never written: a manual step on create, and an update of a live policy that has them is held', async () => {
  const extension = [{ stage: 'assignmentRequestCreated', customExtension: { id: 'ext-1', displayName: 'KEEL-RT-notify', endpointConfiguration: { logicAppWorkflowName: 'notify' } } }];
  const graph = entitlementGraph();
  const resource = policyResource({ payload: policyPayload({ customExtensionStageSettings: extension }) });
  const created = await applyIdentityObjectWrite(graph, resource, 'create', withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(resource) }));
  assert.equal(created.failed, undefined, created.failed?.error);
  assert.match(created.applied.completion.find((step) => step.requirement === 'customExtensions').description, /"KEEL-RT-notify" was not added/);
  noTrustOrExtension(graph);

  const live = livePolicy({ description: 'Changed by hand', customExtensionStageSettings: extension });
  const other = entitlementGraph({ policies: [live] });
  const update = policyResource({ live: { state: 'present', targetId: 'live-policy', payload: { ...live, customExtensionStageSettings: undefined } } });
  const held = await applyIdentityObjectWrite(other, update, 'update', withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(update, 'update') }));
  assert.match(held.skipped?.reason ?? '', /calls custom extensions .* would take them off/);
  assert.equal(writes(other).length, 0);
});

test('a second restore of the same policy finds the first one and does not create it twice', async () => {
  const graph = entitlementGraph();
  const resource = policyResource();
  const ctx = withRefs(context(POLICY_TARGETS), { approvedContentEffects: approved(resource) });
  assert.equal((await applyIdentityObjectWrite(graph, resource, 'create', ctx)).failed, undefined);
  const again = await applyIdentityObjectWrite(graph, resource, 'create', ctx);
  assert.match(again.skipped?.reason ?? '', /already there/);
  assert.equal(graph.calls.filter((call) => call.method === 'POST').length, 1);
});

test('loosenings: wider requestor scope, more requestors, approvers taken off; tightening names none', () => {
  const before = livePolicy();
  assert.deepEqual(policyLoosenings(before, { ...before, allowedTargetScope: 'allDirectoryUsers' }), ['it changes who may request from specificDirectoryUsers to allDirectoryUsers']);
  assert.deepEqual(policyLoosenings(before, { ...before, allowedTargetScope: 'somethingNew' }), ['it changes who may request from specificDirectoryUsers to somethingNew'], 'an unknown scope counts as loosening');
  assert.deepEqual(policyLoosenings(before, { ...before, specificAllowedTargets: [...before.specificAllowedTargets, user(TARGET_APPROVER)] }), ['it adds people who may request']);
  const stage = before.requestApprovalSettings.stages[0];
  assert.deepEqual(policyLoosenings(before, { ...before, requestApprovalSettings: { ...before.requestApprovalSettings, stages: [{ ...stage, fallbackPrimaryApprovers: [] }] } }), ['it takes approvers off stage 1']);
  assert.deepEqual(policyLoosenings(before, { ...before, allowedTargetScope: 'notSpecified', reviewSettings: { isEnabled: true } }), []);
  // How long access lasts: longer, or no expiry, loosens; shorter does not.
  const longer = ['it lets access last longer before it expires'];
  assert.deepEqual(policyLoosenings(before, { ...before, expiration: { type: 'afterDuration', duration: 'P90D' } }), longer);
  assert.deepEqual(policyLoosenings(before, { ...before, expiration: { type: 'noExpiration' } }), longer);
  assert.deepEqual(policyLoosenings(before, { ...before, expiration: { type: 'afterDateTime', endDateTime: '2027-01-01T00:00:00Z' } }), longer, 'one KEEL cannot compare counts as longer');
  assert.deepEqual(policyLoosenings(before, { ...before, expiration: { type: 'afterDuration', duration: 'P7D' } }), []);
});

// ------------------------------------------------- production applyWave path

const governor = { async acquire() {}, observeRetryAfter() {} };

test('remapping proof: create and update of both kinds are qualified by this file', () => {
  for (const kind of ['connectedOrganization', 'accessPackageAssignmentPolicy']) {
    for (const verb of ['create', 'update']) {
      assert.equal(remappingFor(kind, verb).qualified, true, `${kind} ${verb}`);
      assert.equal(remappingFor(kind, verb).proofRef, 'engine/restore/entitlementPolicyOperations.test.mjs');
    }
  }
});

test('applyWave: the organization lands with its sponsor, then a policy that lets its members request', async () => {
  const graph = entitlementGraph();
  const org = { ...orgResource(), verb: 'create' };
  const first = await applyWave(graph, governor, [org], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map([[SPONSOR_KEY, TARGET_SPONSOR]]),
    approvedContentEffects: classifyContentEffects([org]).effects,
  });
  assert.deepEqual(first.failed, [], JSON.stringify(first.failed));
  assert.deepEqual(first.skipped, [], JSON.stringify(first.skipped));
  const created = [...graph.state.orgs.values()][0];
  assert.deepEqual(created.internalSponsors, [TARGET_SPONSOR]);

  const payload = policyPayload({
    allowedTargetScope: 'specificConnectedOrganizationUsers',
    specificAllowedTargets: [{ '@odata.type': '#microsoft.graph.connectedOrganizationMembers', connectedOrganizationId: SOURCE_ORG, description: 'Fabrikam' }],
  });
  const policy = {
    ...policyResource({ payload, references: [POLICY_REFS[0], { field: 'specificAllowedTargets[0].connectedOrganizationId', symbol: ORG_KEY, required: true }, POLICY_REFS[2]] }),
    verb: 'create',
  };
  const second = await applyWave(graph, governor, [policy], {
    targetTenant: 'fixture-tenant', mode: 'enforce',
    existingTargetIds: new Map([[PACKAGE_KEY, TARGET_PACKAGE], [ORG_KEY, created.id], [APPROVER_KEY, TARGET_APPROVER]]),
    approvedContentEffects: classifyContentEffects([policy]).effects,
  });
  assert.deepEqual(second.failed, [], JSON.stringify(second.failed));
  assert.deepEqual(second.skipped, [], JSON.stringify(second.skipped));
  const [written] = graph.state.policies.values();
  assert.equal(written.specificAllowedTargets[0].connectedOrganizationId, created.id);
  noTrustOrExtension(graph);
});

test('applyWave: an unapproved policy is held and writes nothing', async () => {
  const graph = entitlementGraph();
  const policy = { ...policyResource(), verb: 'create' };
  const result = await applyWave(graph, governor, [policy], {
    targetTenant: 'fixture-tenant', mode: 'enforce', existingTargetIds: new Map(POLICY_TARGETS), approvedContentEffects: [],
  });
  assert.equal(result.applied.length, 0);
  assert.equal(writes(graph).length, 0);
});
