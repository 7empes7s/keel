// Roadmap task-104: Teams configuration and structural membership adapter.
//
// Acceptance:
//  - team setting and member changes have separate outcomes;
//  - no message endpoints are called;
//  - missing Teams qualification disables writes;
//  - relationship retry and verification preserve tenant identity.
// Mutation checks:
//  - count Teams messages as configuration;
//  - inherit SharePoint proof as Teams qualification;
//  - conflate group and Teams membership completeness.
//
// Everything runs against the isolated test database and an in-memory fake Graph.
// No tenant is read or written.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { grantRole } from '../authz/administration.mjs';
import { listWorkloads } from '../collect/registry.mjs';
import { SHAREPOINT_OPERATIONS } from '../collect/workloads/sharepoint.mjs';
import {
  TEAMS_OPERATIONS, TeamsScopeError, assertTeamsRequest, collectTeams, readTeams, recordTeamsRun, teamsActivation,
} from '../collect/workloads/teams.mjs';
import { scopeProblems } from '../collect/workloadContract.mjs';
import { buildCoverageReport } from '../coverage/report.mjs';
import { WORKLOAD_WRITE_OPERATIONS, buildOperationLedger, workloadWriteQualification } from '../coverage/qualification.mjs';
import { planDeletionWaves, planWaves } from '../restore/wavePlanner.mjs';
import {
  TEAMS_MEMBER_ADD, TEAMS_MEMBER_REMOVE, TEAMS_MEMBER_UPDATE, TEAMS_RESTORE_EVIDENCE_KIND, TEAMS_SETTINGS_WRITE, TEAMS_WRITE_OPERATIONS,
  createTeamsRestoreArtifact, executeTeamsRestore, loadTeamsSource, planTeamsRestore, readLiveTeam,
} from '../restore/workloads/teams.mjs';
import { approveContentEffects, contentEffectsDigest } from '../safety/contentEffects.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

let schemaReady = false;
async function schemaClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  if (!schemaReady) {
    await client.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
    schemaReady = true;
  }
  return client;
}

const NOW = new Date('2026-10-03T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_TENANT = '00000000-0000-4000-8000-0000000000f2';
const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOREIGN_TEAM = 'aaaaaaaa-0000-4000-8000-0000000000ff';
const OWNER = 'bbbbbbbb-0000-4000-8000-000000000001';
const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000002';
const LEAVER = 'bbbbbbbb-0000-4000-8000-000000000003';
const GUEST = 'bbbbbbbb-0000-4000-8000-000000000004';
const PARTNER = 'bbbbbbbb-0000-4000-8000-000000000005'; // a user in another tenant
const GRAPH = 'https://graph.microsoft.com/v1.0';

let tenantSeq = 0;
const nextTenant = () => `sha256:task-104-${tenantSeq += 1}`;

const SETTINGS = Object.freeze({
  memberSettings: { allowCreateUpdateChannels: true, allowDeleteChannels: false, allowAddRemoveApps: true },
  guestSettings: { allowCreateUpdateChannels: false, allowDeleteChannels: false },
  messagingSettings: { allowUserEditMessages: true, allowUserDeleteMessages: false, allowChannelMentions: true },
  funSettings: { allowGiphy: true, giphyContentRating: 'moderate' },
  discoverySettings: { showInTeamsSearchAndSuggestions: false },
});

const rawMember = (userId, roles = [], tenantId = TENANT, id = null) => ({
  '@odata.type': '#microsoft.graph.aadUserConversationMember',
  id: id ?? `MCMj${userId.slice(-4)}${tenantId.slice(-2)}MjY3Zjk=`,
  userId, tenantId, roles, displayName: `User ${userId.slice(-1)}`, email: `${userId.slice(-4)}@contoso.test`,
});

function teamBody(teamId, overrides = {}) {
  return {
    '@odata.context': `${GRAPH}/$metadata#teams/$entity`,
    id: teamId, displayName: 'Finance', description: 'Finance team', visibility: 'private', isArchived: false,
    classification: null, specialization: 'none', webUrl: `https://teams.microsoft.com/l/team/${teamId}`,
    createdDateTime: '2025-01-01T00:00:00Z', tenantId: TENANT, ...structuredClone(SETTINGS),
    // Adversarial: content a team body can carry when expanded. Never stored.
    messages: [{ id: 'msg-1', body: { content: 'Q3 numbers attached' } }],
    channels: [{ id: '19:general', displayName: 'General', messages: [{ id: 'msg-2', body: { content: 'secret' } }] }],
    ...overrides,
  };
}

/**
 * An in-memory Graph for teams. `hooks.read(path)` can fail a read; `hooks.write({ method,
 * path, body, state })` can override a write ('throw' loses the response after applying
 * nothing, 'apply-then-throw' applies and then loses the response).
 */
function fakeTeams({ teams = { [TEAM]: { body: teamBody(TEAM), members: [], groupMembers: [] } }, hooks = {} } = {}) {
  const state = { teams: structuredClone(teams) };
  const requests = [];
  let contentCalls = 0;
  const json = (body, status = 200) => ({ status, headers: {}, body });
  function applyWrite(method, path, body) {
    const [, , teamId, , membershipId] = path.split('/');
    const team = state.teams[teamId];
    if (!team) return json({ error: { code: 'NotFound' } }, 404);
    if (method === 'PATCH' && !membershipId) {
      for (const [key, value] of Object.entries(body)) team.body[key] = { ...team.body[key], ...structuredClone(value) };
      return json(null, 204);
    }
    if (method === 'POST') {
      const userId = /users\('([^']+)'\)/.exec(body['user@odata.bind'])[1];
      // Graph reports a guest user's role as 'guest'; it is the user's type, never sent.
      const member = rawMember(userId, userId === GUEST ? [...body.roles, 'guest'] : [...body.roles], TENANT);
      team.members.push(member);
      return json(member, 201);
    }
    const member = team.members.find((candidate) => candidate.id === membershipId);
    if (!member) return json({ error: { code: 'NotFound' } }, 404);
    if (method === 'PATCH') { member.roles = [...body.roles]; return json(member); }
    if (method === 'DELETE') { team.members = team.members.filter((candidate) => candidate !== member); return json(null, 204); }
    return json(null, 405);
  }
  async function transport(url, init) {
    const method = init?.method ?? 'GET';
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/v1.0', '');
    requests.push({ url, method, path, body: init?.body ?? null });
    if (/messages|chats|channels|replies|hostedContents|filesFolder/i.test(parsed.pathname + parsed.search)) {
      contentCalls += 1;
      return json({ value: [{ id: 'msg-x', body: { content: 'content' } }] });
    }
    if (method !== 'GET') {
      const override = hooks.write?.({ method, path, body: init.body, state });
      if (override === 'throw') throw new Error('socket hang up');
      if (override === 'apply-then-throw') { applyWrite(method, path, init.body); throw new Error('socket hang up'); }
      if (override) return override;
      return applyWrite(method, path, init.body);
    }
    const failed = hooks.read?.(path);
    if (failed) return failed;
    let match;
    if (path === '/teams') {
      const ids = Object.keys(state.teams);
      if (parsed.searchParams.get('$skiptoken')) return json({ value: ids.slice(1).map((id) => ({ id, displayName: state.teams[id].body.displayName })) });
      return json({ value: ids.slice(0, 1).map((id) => ({ id, displayName: state.teams[id].body.displayName })), '@odata.nextLink': `${GRAPH}/teams?$skiptoken=page2` });
    }
    if ((match = /^\/teams\/([^/]+)$/.exec(path))) return state.teams[match[1]] ? json(structuredClone(state.teams[match[1]].body)) : json(null, 404);
    if ((match = /^\/teams\/([^/]+)\/members$/.exec(path))) return json({ value: structuredClone(state.teams[match[1]].members) });
    if ((match = /^\/groups\/([^/]+)\/members$/.exec(path))) return json({ value: state.teams[match[1]].groupMembers.map((id) => ({ '@odata.type': '#microsoft.graph.user', id })) });
    return json({ error: { code: 'NotFound' } }, 404);
  }
  return {
    state, requests, transport,
    contentCalls: () => contentCalls,
    writes: () => requests.filter((request) => request.method !== 'GET'),
    members: (teamId = TEAM) => state.teams[teamId].members,
  };
}

const ledgerRow = (id, enabled) => ({ id, state: enabled ? 'live-qualified' : 'fixture-tested', enabled });
function readLedger(tenantRef, { sharePoint = true, teams = true } = {}) {
  return {
    tenantRef,
    rows: [
      ...SHAREPOINT_OPERATIONS.map((id) => ledgerRow(id, sharePoint)),
      ...TEAMS_OPERATIONS.map((id) => ledgerRow(id, typeof teams === 'boolean' ? teams : teams.includes(id))),
    ],
  };
}
const liveWrite = (operationId, tenantRef, extra = {}) => ({
  operationId, kind: 'live-write-capture', synthetic: false, tenantRef,
  capturedAt: '2026-10-02T00:00:00Z', version: 'v1.0', ok: true, readBackVerified: true, proofRef: `${operationId}.json@sha256:x`, ...extra,
});
/** Qualification of every Teams write. `teams` lists the Teams writes with live proof. */
function qualifications(tenantRef, { sharePoint = true, teams = TEAMS_WRITE_OPERATIONS, ledger = readLedger(tenantRef) } = {}) {
  const evidence = [
    ...(sharePoint ? [liveWrite('sharepoint.tenant-settings.update', tenantRef)] : []),
    ...teams.map((id) => liveWrite(id, tenantRef)),
  ];
  return Object.fromEntries(TEAMS_WRITE_OPERATIONS.map((id) => [id, workloadWriteQualification(id, { readLedger: ledger, evidence, tenantRef, now: NOW })]));
}

let principalSeq = 0;
async function principal(client, label, role) {
  const email = `${label.replace(/[^a-z0-9-]/gi, '')}-${principalSeq += 1}@example.test`;
  const { rows } = await client.query(`INSERT INTO principal (email) VALUES ($1) RETURNING id`, [email]);
  if (role) await grantRole(client, { principalId: rows[0].id, role, grantedBy: rows[0].id, activeFrom: new Date(Date.now() - 60_000) });
  return rows[0].id;
}

/** The source: a recorded collection of the team as it was. */
async function recordSource(client, tenantRef, { members, groupMembers = [OWNER, MEMBER], settings = SETTINGS, read = {} } = {}) {
  const graph = fakeTeams({
    teams: { [TEAM]: { body: teamBody(TEAM, structuredClone(settings)), members: members ?? [rawMember(OWNER, ['owner']), rawMember(MEMBER), rawMember(LEAVER)], groupMembers } },
    hooks: { read: (path) => read[path] },
  });
  const result = await readTeams({ transport: graph.transport, tenantId: TENANT, now: () => NOW });
  const run = await recordTeamsRun(client, { tenantRef, result });
  return loadTeamsSource(client, { tenantRef, collectionId: run.id });
}

async function planned(client, tenantRef, { source, graph, requester } = {}) {
  const recorded = source ?? await recordSource(client, tenantRef);
  const live = await readLiveTeam({ transport: graph.transport, teamId: TEAM });
  graph.requests.length = 0;
  const plan = planTeamsRestore({ source: recorded, live, tenantId: TENANT, teamId: TEAM });
  const requestedBy = requester ?? await principal(client, `${tenantRef}-requester`, 'restorer');
  const artifact = await createTeamsRestoreArtifact(client, { tenantRef, plan, requestedBy });
  return { plan, artifact, requestedBy };
}

/** A live team that drifted from the source: settings changed, a member left, a member joined. */
function driftedGraph(hooks = {}, overrides = {}) {
  return fakeTeams({
    teams: {
      [TEAM]: {
        body: teamBody(TEAM, { funSettings: { allowGiphy: false, giphyContentRating: 'strict' }, ...overrides }),
        members: [rawMember(OWNER, ['owner']), rawMember(MEMBER)],
        groupMembers: [OWNER, MEMBER],
      },
    },
    hooks,
  });
}

const byKind = (result, kind) => result.operations.filter((op) => op.kind === kind);

// --------------------------------------------------------------------- reads

test('the reader keeps settings, Teams membership and group membership as separate observations and never touches messages', async () => {
  const graph = fakeTeams({
    teams: {
      [TEAM]: { body: teamBody(TEAM), members: [rawMember(OWNER, ['owner']), rawMember(PARTNER, [], OTHER_TENANT)], groupMembers: [OWNER] },
      [FOREIGN_TEAM]: { body: teamBody(FOREIGN_TEAM, { tenantId: OTHER_TENANT }), members: [rawMember(MEMBER)], groupMembers: [MEMBER] },
    },
  });
  const result = await readTeams({ transport: graph.transport, tenantId: TENANT, now: () => NOW });
  assert.equal(result.outcome, 'complete');
  assert.equal(result.discovery.pages, 2, 'discovery follows the next page');
  assert.equal(result.teams.length, 1);
  const [team] = result.teams;
  assert.deepEqual(team.fields.memberSettings, SETTINGS.memberSettings);
  assert.deepEqual(team.fields.messagingSettings, SETTINGS.messagingSettings, 'messaging settings are configuration');
  assert.equal(team.fieldCoverage.members.operation, 'teams.membership');
  assert.equal(team.fieldCoverage.groupMembers.operation, 'teams.group-membership');
  assert.deepEqual(team.fields.groupMembers.map((member) => member.id), [OWNER]);
  // A member from another tenant keeps its own tenant identity.
  assert.deepEqual(team.fields.members.map((member) => `${member.tenantId}|${member.userId}`).sort(), [`${OTHER_TENANT}|${PARTNER}`, `${TENANT}|${OWNER}`].sort());

  // Messages are content: never requested, never stored, never counted as a field.
  assert.equal(graph.contentCalls(), 0);
  for (const request of graph.requests) assert.doesNotMatch(request.url, /messages|chats|channels|replies|hostedContents/i);
  const stored = JSON.stringify(team);
  assert.doesNotMatch(stored, /Q3 numbers|secret|msg-1|msg-2/);
  for (const field of ['messages', 'channels']) {
    assert.equal(field in team.fields, false, `${field} is not a configuration field`);
    assert.equal(field in team.fieldCoverage, false, `${field} is not counted in coverage`);
  }
  const counted = Object.values(result.fieldCounts).reduce((sum, count) => sum + count, 0);
  assert.equal(counted, Object.keys(team.fieldCoverage).length);
  assert.equal(counted, 5 + 9 + 2, 'five settings groups, nine properties, two memberships');

  // A team of another tenant is recorded out of scope; its members are never read.
  assert.deepEqual(result.outOfScope, [{ teamId: FOREIGN_TEAM, reason: 'the team belongs to another tenant' }]);
  assert.equal(graph.requests.some((request) => request.url.includes(`${FOREIGN_TEAM}/members`)), false);

  // Every message and chat shape is refused before it is sent, whatever its container.
  for (const url of [
    `${GRAPH}/teams/${TEAM}/channels/19:general/messages`, `${GRAPH}/teams/${TEAM}/primaryChannel/messages`, `${GRAPH}/chats`,
    `${GRAPH}/teams/${TEAM}/channels`, `${GRAPH}/teams/${TEAM}?$expand=channels`, `${GRAPH}/users/${OWNER}/chats/x/messages`,
    `${GRAPH}/teams/${TEAM}/channels/19:general/filesFolder`, `https://evil.example/v1.0/teams/${TEAM}`,
  ]) assert.throws(() => assertTeamsRequest(url, 'GET'), TeamsScopeError, url);
  assert.notEqual(scopeProblems({ kind: 'graph', method: 'GET', endpoint: '/teams/{team-id}/channels/{channel-id}/messages' }).length, 0);
});

test('group and Teams membership completeness are independent', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const denied = { status: 403, headers: {}, body: { error: { code: 'Authorization_RequestDenied' } } };

  // Group membership denied: Teams membership is still complete, and still a basis.
  const groupDenied = await recordSource(client, tenantRef, { read: { [`/groups/${TEAM}/members`]: denied } });
  assert.equal(groupDenied.outcome, 'partial');
  const [groupDeniedTeam] = groupDenied.observations;
  assert.equal(groupDeniedTeam.fieldCoverage.members.status, 'observed');
  assert.equal(groupDeniedTeam.fieldCoverage.groupMembers.status, 'denied');
  const live = await readLiveTeam({ transport: driftedGraph().transport, teamId: TEAM });
  const fromGroupDenied = planTeamsRestore({ source: groupDenied, live, tenantId: TENANT, teamId: TEAM });
  assert.deepEqual(fromGroupDenied.operations.filter((op) => op.kind !== 'settings').map((op) => op.kind), ['member-add']);
  assert.equal(fromGroupDenied.groupMembership.status, 'denied');

  // Teams membership failed: a complete group read does not stand in for it.
  const teamsFailed = await recordSource(client, tenantRef, { read: { [`/teams/${TEAM}/members`]: { status: 500, headers: {}, body: null } } });
  const [teamsFailedTeam] = teamsFailed.observations;
  assert.equal(teamsFailedTeam.fieldCoverage.members.status, 'failed');
  assert.equal(teamsFailedTeam.fieldCoverage.groupMembers.status, 'observed');
  assert.equal('members' in teamsFailedTeam.fields, false, 'no member list is invented from the group');
  const fromTeamsFailed = planTeamsRestore({ source: teamsFailed, live, tenantId: TENANT, teamId: TEAM });
  assert.deepEqual(fromTeamsFailed.operations.map((op) => op.kind), ['settings']);
  assert.ok(fromTeamsFailed.manual.some((item) => item.field === 'members' && /Teams membership was failed/.test(item.reason)));
  assert.equal(fromTeamsFailed.groupMembership.status, 'observed');

  // A live Teams membership read that is incomplete authorizes no removal.
  const extraLive = await readLiveTeam({ transport: fakeTeams({ teams: { [TEAM]: { body: teamBody(TEAM), members: [rawMember(OWNER, ['owner']), rawMember(MEMBER), rawMember(LEAVER), rawMember(GUEST)], groupMembers: [] } } }).transport, teamId: TEAM });
  const source = await recordSource(client, tenantRef);
  assert.deepEqual(planTeamsRestore({ source, live: extraLive, tenantId: TENANT, teamId: TEAM }).operations.map((op) => op.kind), ['member-remove']);
  const incomplete = planTeamsRestore({ source, live: { ...extraLive, membersComplete: false }, tenantId: TENANT, teamId: TEAM });
  assert.deepEqual(incomplete.operations, []);
  assert.ok(incomplete.manual.some((item) => /not complete, so no removal/.test(item.reason)));
});

// ------------------------------------------------------------- qualification

test('Teams activates only on its own proof, after SharePoint; SharePoint proof never counts for Teams', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();

  // Reads: SharePoint fully qualified, Teams only fixture-tested.
  for (const [name, ledger] of Object.entries({
    sharePointOnly: readLedger(tenantRef, { sharePoint: true, teams: false }),
    teamsWithoutSharePoint: readLedger(tenantRef, { sharePoint: false, teams: true }),
    groupReadMissing: readLedger(tenantRef, { teams: TEAMS_OPERATIONS.filter((id) => id !== 'teams.group-membership') }),
  })) {
    const graph = fakeTeams();
    const { run, result, activation } = await collectTeams(client, { tenantRef, ledger, transport: graph.transport, tenantId: TENANT, now: () => NOW });
    assert.equal(activation.enabled, false, name);
    assert.equal(run.outcome, 'disabled', name);
    assert.equal(result, null, name);
    assert.equal(graph.requests.length, 0, `${name}: no request at all`);
  }
  assert.match(teamsActivation(readLedger(tenantRef, { sharePoint: false })).reasons[0], /SharePoint is not qualified/);
  const graph = fakeTeams();
  const enabled = await collectTeams(client, { tenantRef, ledger: readLedger(tenantRef), transport: graph.transport, tenantId: TENANT, now: () => NOW });
  assert.equal(enabled.run.outcome, 'complete');

  // Writes: every Teams write needs its own live capture, and SharePoint first.
  const spEvidence = [liveWrite('sharepoint.tenant-settings.update', tenantRef)];
  const ledger = readLedger(tenantRef);
  for (const id of TEAMS_WRITE_OPERATIONS) {
    const inherited = workloadWriteQualification(id, { readLedger: ledger, evidence: spEvidence, tenantRef, now: NOW });
    assert.equal(inherited.enabled, false, `${id}: SharePoint proof alone`);
    assert.equal(inherited.state, 'disabled');
    const fixture = workloadWriteQualification(id, {
      readLedger: ledger, evidence: [...spEvidence, { operationId: id, kind: 'fixture', synthetic: true, ok: true }], tenantRef, now: NOW,
    });
    assert.equal(fixture.enabled, false, `${id}: a fixture pass`);
    const noSharePoint = workloadWriteQualification(id, { readLedger: ledger, evidence: [liveWrite(id, tenantRef)], tenantRef, now: NOW });
    assert.equal(noSharePoint.state, 'live-qualified');
    assert.equal(noSharePoint.enabled, false, `${id}: Teams proof without SharePoint`);
    assert.ok(noSharePoint.reasons.some((reason) => /sharepoint\.tenant-settings\.update must be live-qualified first/.test(reason)));
    const readBackOff = workloadWriteQualification(id, {
      readLedger: readLedger(tenantRef, { teams: TEAMS_OPERATIONS.filter((op) => op !== WORKLOAD_WRITE_OPERATIONS[id].readBack) }),
      evidence: [...spEvidence, liveWrite(id, tenantRef)], tenantRef, now: NOW,
    });
    assert.equal(readBackOff.enabled, false, `${id}: its Teams read-back is not enabled`);
    assert.equal(workloadWriteQualification(id, { readLedger: ledger, evidence: [...spEvidence, liveWrite(id, tenantRef)], tenantRef, now: NOW }).enabled, true, id);
  }
  // Not catalogue types: the Entra ledger is unchanged by them.
  assert.equal(buildOperationLedger().types.some((row) => ['teamsTeamSettings', 'teamsMembership'].includes(row.resourceType)), false);
  assert.ok(listWorkloads().some((descriptor) => descriptor.workload === 'teams-settings' && descriptor.enabledByDefault === false));
});

test('missing Teams qualification disables writes: zero requests', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const { artifact } = await planned(client, tenantRef, { graph: driftedGraph() });
  for (const [name, quals] of Object.entries({
    none: {},
    sharePointOnly: qualifications(tenantRef, { teams: [] }),
    teamsWithoutSharePoint: qualifications(tenantRef, { sharePoint: false }),
  })) {
    const graph = driftedGraph();
    const result = await executeTeamsRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: graph.transport, qualifications: quals });
    assert.equal(result.outcome, 'disabled', name);
    assert.ok(result.operations.every((op) => op.outcome === 'disabled' && op.writes === 0), name);
    assert.equal(graph.requests.length, 0, `${name}: no request at all`);
  }
});

// ----------------------------------------------------------------- restore

test('team setting and member changes have separate outcomes and separate evidence', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const { plan, artifact } = await planned(client, tenantRef, { graph: driftedGraph() });
  assert.deepEqual(plan.operations.map((op) => op.kind), ['settings', 'member-add']);
  assert.deepEqual(plan.operations[0].body, { funSettings: SETTINGS.funSettings }, 'only the changed settings group');
  assert.equal(plan.operations[1].member.userId, LEAVER);
  assert.ok(plan.excluded.some((item) => item.field === 'messages' && /never read or restored/.test(item.reason)));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.operations[0].body));

  // The member write fails; the settings write still verifies, on its own.
  const graph = driftedGraph({ write: ({ method }) => (method === 'POST' ? { status: 400, headers: {}, body: { error: { code: 'BadRequest' } } } : null) });
  const result = await executeTeamsRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: graph.transport, qualifications: qualifications(tenantRef) });
  assert.equal(result.outcome, 'partial');
  assert.equal(byKind(result, 'settings')[0].outcome, 'verified');
  assert.deepEqual(byKind(result, 'settings')[0].verified, ['funSettings']);
  assert.equal(byKind(result, 'member-add')[0].outcome, 'failed');
  assert.deepEqual(graph.state.teams[TEAM].body.funSettings, SETTINGS.funSettings);
  const { rows } = await client.query(`SELECT subject FROM evidence WHERE tenant_ref = $1 AND kind = $2 ORDER BY seq`, [tenantRef, TEAMS_RESTORE_EVIDENCE_KIND]);
  assert.deepEqual(rows.map((row) => `${row.subject.operationId}:${row.subject.outcome}`), [
    `${TEAMS_SETTINGS_WRITE}:verified`, `${TEAMS_MEMBER_ADD}:failed`, 'teams.restore:partial',
  ]);

  // Settings qualified, membership not: the settings run, no member request is sent.
  const { artifact: second } = await planned(client, tenantRef, { graph: driftedGraph() });
  const settingsOnly = driftedGraph();
  const partial = await executeTeamsRestore(client, {
    tenantRef, artifactId: second.id, tenantId: TENANT, transport: settingsOnly.transport, qualifications: qualifications(tenantRef, { teams: [TEAMS_SETTINGS_WRITE] }),
  });
  assert.equal(byKind(partial, 'settings')[0].outcome, 'verified');
  assert.equal(byKind(partial, 'member-add')[0].outcome, 'disabled');
  assert.deepEqual(settingsOnly.writes().map((request) => request.method), ['PATCH']);
});

test('a role change and a removal verify against the same live team they were planned on', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const graph = fakeTeams({ teams: { [TEAM]: { body: teamBody(TEAM), members: [rawMember(OWNER, ['owner']), rawMember(MEMBER, ['owner']), rawMember(LEAVER), rawMember(GUEST)], groupMembers: [] } } });
  const { plan, artifact } = await planned(client, tenantRef, { graph });
  assert.deepEqual(plan.operations.map((op) => op.kind), ['member-update', 'member-remove']);
  const result = await executeTeamsRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: graph.transport, qualifications: qualifications(tenantRef) });
  assert.equal(result.outcome, 'verified', JSON.stringify(result.operations));
  assert.deepEqual(graph.writes().map((request) => request.method), ['PATCH', 'DELETE']);
  assert.deepEqual(graph.members().find((member) => member.userId === MEMBER).roles, []);
  assert.equal(graph.members().some((member) => member.userId === GUEST), false);
});

test('an ambiguous member write is reconciled by re-reading, never resent, and verification keeps tenant identity', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const posts = (graph) => graph.writes().filter((request) => request.method === 'POST').length;
  const memberQuals = qualifications(tenantRef, { teams: [TEAMS_MEMBER_ADD] });

  // The response is lost after the platform applied it: verified, sent once.
  const lost = driftedGraph({ write: ({ method }) => (method === 'POST' ? 'apply-then-throw' : null) });
  const { artifact: a1 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const reconciled = await executeTeamsRestore(client, { tenantRef, artifactId: a1.id, tenantId: TENANT, transport: lost.transport, qualifications: memberQuals });
  const [add] = byKind(reconciled, 'member-add');
  assert.equal(add.outcome, 'verified');
  assert.match(add.reasons[0], /not resent/);
  assert.equal(posts(lost), 1);

  // A 503 that applied nothing: failed, sent once, not retried.
  const unavailable = driftedGraph({ write: ({ method }) => (method === 'POST' ? { status: 503, headers: {}, body: null } : null) });
  const { artifact: a2 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const failed = await executeTeamsRestore(client, { tenantRef, artifactId: a2.id, tenantId: TENANT, transport: unavailable.transport, qualifications: memberQuals });
  assert.equal(byKind(failed, 'member-add')[0].outcome, 'failed');
  assert.equal(posts(unavailable), 1);

  // A throttled write was not applied: resent after Retry-After.
  let throttled = false;
  const slow = driftedGraph({ write: ({ method }) => {
    if (method !== 'POST' || throttled) return null;
    throttled = true;
    return { status: 429, headers: { 'retry-after': '3' }, body: null };
  } });
  const waits = [];
  const { artifact: a3 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const retried = await executeTeamsRestore(client, { tenantRef, artifactId: a3.id, tenantId: TENANT, transport: slow.transport, qualifications: memberQuals, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(byKind(retried, 'member-add')[0].outcome, 'verified');
  assert.equal(posts(slow), 2);
  assert.deepEqual(waits, [3000]);

  // The platform reports success but the member appears under another tenant: not verified.
  const impostor = driftedGraph({ write: ({ method, state }) => {
    if (method !== 'POST') return null;
    state.teams[TEAM].members.push(rawMember(LEAVER, [], OTHER_TENANT));
    return { status: 201, headers: {}, body: {} };
  } });
  const { artifact: a4 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const wrongTenant = await executeTeamsRestore(client, { tenantRef, artifactId: a4.id, tenantId: TENANT, transport: impostor.transport, qualifications: memberQuals });
  assert.equal(byKind(wrongTenant, 'member-add')[0].outcome, 'verification-failed');
  assert.equal(posts(impostor), 1);
  // Same for an ambiguous outcome: a same-id user in another tenant is not "already applied".
  const ambiguousImpostor = driftedGraph({ write: ({ method, state }) => {
    if (method !== 'POST') return null;
    state.teams[TEAM].members.push(rawMember(LEAVER, [], OTHER_TENANT));
    return 'throw';
  } });
  const { artifact: a5 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const ambiguousWrongTenant = await executeTeamsRestore(client, { tenantRef, artifactId: a5.id, tenantId: TENANT, transport: ambiguousImpostor.transport, qualifications: memberQuals });
  assert.equal(byKind(ambiguousWrongTenant, 'member-add')[0].outcome, 'failed');
  assert.equal(posts(ambiguousImpostor), 1);

  // The team moved to another tenant since the plan: refused before any write.
  const moved = driftedGraph({}, { tenantId: OTHER_TENANT });
  const { artifact: a6 } = await planned(client, tenantRef, { graph: driftedGraph() });
  const refused = await executeTeamsRestore(client, { tenantRef, artifactId: a6.id, tenantId: TENANT, transport: moved.transport, qualifications: qualifications(tenantRef) });
  assert.ok(refused.operations.every((op) => op.outcome === 'refused'));
  assert.equal(moved.writes().length, 0);
  // And a plan for one tenant never runs as another.
  const other = driftedGraph();
  assert.equal((await executeTeamsRestore(client, { tenantRef, artifactId: a6.id, tenantId: OTHER_TENANT, transport: other.transport, qualifications: qualifications(tenantRef) })).outcome, 'refused');
  assert.equal(other.requests.length, 0);

  // A source member from another tenant is never added automatically.
  const source = await recordSource(client, tenantRef, { members: [rawMember(OWNER, ['owner']), rawMember(PARTNER, [], OTHER_TENANT)] });
  const crossTenant = planTeamsRestore({ source, live: await readLiveTeam({ transport: driftedGraph().transport, teamId: TEAM }), tenantId: TENANT, teamId: TEAM });
  assert.equal(crossTenant.operations.some((op) => op.member?.userId === PARTNER), false);
  assert.ok(crossTenant.manual.some((item) => item.member === `${OTHER_TENANT}|${PARTNER}` && /another tenant/.test(item.reason)));
  assert.throws(() => planTeamsRestore({ source, live: { team: teamBody(TEAM, { tenantId: OTHER_TENANT }), members: [], membersComplete: true }, tenantId: TENANT, teamId: TEAM }), /does not belong to the managed tenant/);
  assert.throws(() => planTeamsRestore({ source, live: { team: teamBody(TEAM), members: [], membersComplete: true }, tenantId: OTHER_TENANT, teamId: TEAM }), /different tenant/);
});

test('a concurrent change invalidates only the operations it touches; a guest addition needs exact approval', async (t) => {
  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  const { artifact } = await planned(client, tenantRef, { graph: driftedGraph() });
  // Someone adds a member after the plan: member operations are stale, settings still run.
  const graph = driftedGraph();
  graph.state.teams[TEAM].members.push(rawMember(GUEST, ['guest']));
  const result = await executeTeamsRestore(client, { tenantRef, artifactId: artifact.id, tenantId: TENANT, transport: graph.transport, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(result, 'member-add')[0].outcome, 'stale');
  assert.equal(byKind(result, 'settings')[0].outcome, 'verified');
  assert.deepEqual(graph.writes().map((request) => request.method), ['PATCH']);

  // Restoring a guest widens access: blocked with no request until approved exactly.
  const source = await recordSource(client, tenantRef, { members: [rawMember(OWNER, ['owner']), rawMember(MEMBER), rawMember(GUEST, ['guest'])] });
  const { plan, artifact: guestArtifact } = await planned(client, tenantRef, { source, graph: driftedGraph() });
  assert.deepEqual(plan.contentEffects.map((effect) => `${effect.resourceType}:${effect.field}:${effect.effect}`), ['teamsMembership:guests:externally-sharing']);
  const blockedGraph = driftedGraph();
  const blocked = await executeTeamsRestore(client, { tenantRef, artifactId: guestArtifact.id, tenantId: TENANT, transport: blockedGraph.transport, qualifications: qualifications(tenantRef) });
  assert.equal(blocked.outcome, 'blocked-content-effect');
  assert.equal(blockedGraph.requests.length, 0);
  const approver = await principal(client, `${tenantRef}-approver`, 'approver');
  await approveContentEffects(client, {
    tenantRef, artifactId: guestArtifact.id, approverId: approver, effectsDigest: contentEffectsDigest(plan.contentEffects), justification: 'guest re-invited by the team owner',
  });
  const approvedGraph = driftedGraph();
  const approved = await executeTeamsRestore(client, { tenantRef, artifactId: guestArtifact.id, tenantId: TENANT, transport: approvedGraph.transport, qualifications: qualifications(tenantRef) });
  assert.equal(byKind(approved, 'member-add')[0].outcome, 'verified');
  assert.deepEqual(approvedGraph.writes().find((request) => request.method === 'POST').body.roles, [], 'the guest role is the user\'s type, never sent');

  // A plan that would leave the team without an owner is refused outright.
  const ownerless = await recordSource(client, tenantRef, { members: [rawMember(MEMBER)] });
  const refusedPlan = planTeamsRestore({ source: ownerless, live: await readLiveTeam({ transport: driftedGraph().transport, teamId: TEAM }), tenantId: TENANT, teamId: TEAM });
  assert.match(refusedPlan.refusals[0].reason, /no owner/);
});

test('Teams workload types never enter Entra waves, and coverage reports the disabled workload', async (t) => {
  assert.throws(() => planWaves([{ naturalKey: `teams:${TEAM}:settings`, resourceType: 'teamsTeamSettings', payload: {}, references: [] }]), /workload restore path/);
  assert.throws(() => planDeletionWaves([{ naturalKey: `teams:${TEAM}:members`, resourceType: 'teamsMembership', payload: {}, references: [] }]), /workload restore path/);

  const client = await schemaClient(t);
  const tenantRef = nextTenant();
  await collectTeams(client, { tenantRef, ledger: readLedger(tenantRef, { teams: false }), transport: fakeTeams().transport, tenantId: TENANT, now: () => NOW });
  const report = await buildCoverageReport(client, { tenantRef, catalog: [], descriptors: [] });
  const entry = report.workloads.find((item) => item.workload === 'teams-settings');
  assert.equal(entry.status, 'disabled');
  assert.equal(entry.covered, false);
  assert.ok(entry.reasons.some((reason) => /teams\.settings is fixture-tested/.test(reason)));
});
