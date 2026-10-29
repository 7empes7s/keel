import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ADMIN_SERVICES_APP_ID, JOB_PREFIX, NEEDED_ROLE, ProbeScopeError, SAMPLES, TCM_APP_ID, VISIBLE_JOB_LIMIT,
  assertProbeRequest, createJobs, findings, probeTransport, renderMarkdown, runCheck, runSnapshots, summariseSnapshot, typesFor,
} from './utcm-probe.mjs';
import { UTCM_TYPES, UTCM_WORKLOADS, missingTypes } from './utcm-types.mjs';

const G = 'https://graph.microsoft.com/v1.0';
const CREATE = `${G}/admin/configurationManagement/configurationSnapshots/createSnapshot`;
const JOBS = `${G}/admin/configurationManagement/configurationSnapshotJobs`;
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const body = (resources = ['microsoft.exchange.transportrule']) => ({ displayName: `${JOB_PREFIX} TEST x`, resources });

test('the type list is the TCM schema: unique, lower case, known workloads, a tier only where KEEL reads nothing', () => {
  assert.equal(UTCM_TYPES.length, 270);
  assert.equal(new Set(UTCM_TYPES.map((row) => row.type)).size, UTCM_TYPES.length);
  for (const row of UTCM_TYPES) {
    assert.match(row.type, /^microsoft\.[a-z]+\.[a-z0-9]+$/, row.type);
    assert.ok(UTCM_WORKLOADS.includes(row.workload), row.type);
    if (row.keel === null) assert.ok([1, 2, 3, 4].includes(row.tier), row.type);
    else assert.equal(row.tier, null, row.type);
  }
  // Entra and Intune are read through KEEL's own Graph catalogue.
  assert.ok(UTCM_TYPES.filter((row) => ['entra', 'intune'].includes(row.workload)).every((row) => row.keel));
  // The top restore gap leads the list of what KEEL lacks.
  const top = missingTypes().filter((row) => row.tier === 1).map((row) => row.type);
  for (const type of ['microsoft.exchange.distributiongroup', 'microsoft.exchange.mailboxpermission', 'microsoft.exchange.recipientpermission', 'microsoft.exchange.sharedmailbox']) {
    assert.ok(top.includes(type), type);
  }
  for (const sample of Object.values(SAMPLES).flat()) assert.ok(UTCM_TYPES.some((row) => row.type === sample), sample);
  assert.equal(typesFor('exchange').length, UTCM_TYPES.filter((row) => row.workload === 'exchange').length);
  assert.deepEqual(typesFor('entra'), SAMPLES.entra);
});

test('the probe sends only reads, a KEEL RT snapshot request, and deletes of its own jobs', () => {
  assert.deepEqual(assertProbeRequest(`${G}/servicePrincipals`), { auth: true });
  assert.deepEqual(assertProbeRequest(CREATE, 'POST', body()), { auth: true });
  assert.throws(() => assertProbeRequest(CREATE, 'POST', { ...body(), displayName: 'Prod snapshot' }), /KEEL RT/);
  assert.throws(() => assertProbeRequest(CREATE, 'POST', { ...body(), displayName: 'KEEL RT exo-1' }), /letters, digits and spaces/);
  assert.throws(() => assertProbeRequest(CREATE, 'POST', { ...body(), displayName: `KEEL RT ${'X'.repeat(30)}` }), /8 to 32/);
  assert.throws(() => assertProbeRequest(CREATE, 'POST', { displayName: `${JOB_PREFIX} TEST x`, resources: [] }), /resources/);
  assert.throws(() => assertProbeRequest(`${CREATE}?x=1`, 'POST', body()), ProbeScopeError);
  assert.throws(() => assertProbeRequest(`${G}/admin/configurationManagement/configurationMonitors`, 'POST', body()), ProbeScopeError);
  assert.throws(() => assertProbeRequest(`${G}/users`, 'POST', body()), ProbeScopeError);
  assert.throws(() => assertProbeRequest(`${G}/users/x`, 'PATCH', {}), ProbeScopeError);
  assert.throws(() => assertProbeRequest(`${G}/users`, 'GET', {}), ProbeScopeError);
  assert.throws(() => assertProbeRequest(`${JOBS}/${ID1}`, 'DELETE'), /only snapshot jobs it created/);
  assert.deepEqual(assertProbeRequest(`${JOBS}/${ID1}`, 'DELETE', undefined, new Set([ID1])), { auth: true });
  assert.throws(() => assertProbeRequest(`${G}/users/${ID1}`, 'DELETE', undefined, new Set([ID1])), /only snapshot jobs/);
  assert.throws(() => assertProbeRequest('http://graph.microsoft.com/v1.0/users'), /http/);
  assert.throws(() => assertProbeRequest('https://evil.example.com/x'), /host/);
  // A snapshot file on Azure storage is fetched without the Graph token.
  assert.deepEqual(assertProbeRequest('https://acct.blob.core.windows.net/c/f.json?sig=x'), { auth: false });
  assert.throws(() => assertProbeRequest('https://acct.blob.core.windows.net/c/f.json', 'DELETE'), ProbeScopeError);
});

/** A fake TCM service. `plan` decides answers; every request is recorded. */
function fakeTcm({ visible = 0, createStatus = () => 200, polls = 1, snapshot, deleteStatus = 204 } = {}) {
  const calls = [];
  let next = 0;
  const pollCount = new Map();
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: Boolean(init.headers.authorization), body: init.body ? JSON.parse(init.body) : undefined });
    const reply = (status, json) => ({ status, headers: { get: () => null }, text: async () => (json === undefined ? '' : JSON.stringify(json)) });
    const path = new URL(url).pathname;
    if (init.method === 'POST') {
      const status = createStatus(JSON.parse(init.body).resources);
      if (status !== 200) return reply(status, { error: { code: 'BadRequest', message: 'Resource name is not valid.' } });
      const id = [ID1, ID2][next++];
      return reply(200, { id, status: 'notStarted' });
    }
    if (init.method === 'DELETE') return reply(deleteStatus);
    if (path.endsWith('/configurationSnapshotJobs')) return reply(200, { value: Array.from({ length: visible }, (_, i) => ({ id: `j${i}` })) });
    const job = path.match(/configurationSnapshotJobs\/([0-9a-f-]{36})$/)?.[1];
    if (job) {
      const seen = (pollCount.get(job) ?? 0) + 1;
      pollCount.set(job, seen);
      if (seen <= polls) return reply(200, { id: job, status: 'running' });
      return reply(200, { id: job, status: 'partiallySuccessful', errorDetails: ['Exporting microsoft.exchange.place for admin@contoso.onmicrosoft.com failed'], resourceLocation: `https://graph.microsoft.com/beta/admin/configurationManagement/configurationSnapshots('${job}')` });
    }
    if (path.includes("configurationSnapshots('")) return reply(200, snapshot);
    return reply(404, { error: { code: 'NotFound' } });
  };
  return { calls, fetchImpl };
}

const SNAPSHOT = { displayName: 'x', resources: [
  { resourceType: 'microsoft.exchange.distributionGroup', displayName: 'Finance DL', properties: { Identity: 'Finance DL', Members: ['a@contoso.com'] } },
  { resourceType: 'microsoft.exchange.distributionGroup', displayName: 'Sales DL', properties: { Identity: 'Sales DL', ManagedBy: ['b@contoso.com'] } },
  { resourceType: 'microsoft.exchange.transportRule', displayName: 'Rule', properties: { Identity: 'Rule' } },
] };

test('a run creates, waits for, downloads and deletes its own jobs, and reports what KEEL lacks', async () => {
  const tcm = fakeTcm({ snapshot: SNAPSHOT, polls: 2 });
  const send = probeTransport(async () => 'token', tcm.fetchImpl);
  const saved = [];
  let clock = 0;
  const report = await runSnapshots({ send, workloads: ['exchange'], sleep: async (ms) => { clock += ms; }, now: () => clock, saveRaw: (name, text) => saved.push([name, text]), stamp: 'T' });
  const posts = tcm.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1);
  assert.ok(posts[0].body.displayName === `${JOB_PREFIX} EXO T`);
  assert.deepEqual(posts[0].body.resources, typesFor('exchange'));
  assert.deepEqual(tcm.calls.filter((call) => call.method === 'DELETE').map((call) => call.url), [`${JOBS}/${ID1}`]);
  assert.deepEqual(report.deleted, [204]);
  const job = report.workloads[0].jobs[0];
  assert.equal(job.status, 'partiallySuccessful');
  assert.equal(job.seconds, 30);
  assert.equal(job.summary.total, 3);
  assert.deepEqual(job.summary.types['microsoft.exchange.distributiongroup'], { count: 2, properties: ['Identity', 'ManagedBy', 'Members'] });
  assert.equal(saved.length, 1);
  assert.deepEqual(report.findings.keelLacksWithData, [{ type: 'microsoft.exchange.distributiongroup', tier: 1, count: 2 }]);
  assert.equal(report.findings.resourcesExtracted, 3);
  const md = renderMarkdown(report, '2026-10-27T00:00:00Z');
  assert.ok(md.includes('| microsoft.exchange.distributiongroup | 1 | 2 |'));
  // Masked: no addresses, tenant hosts, names of objects or values.
  for (const leak of ['contoso', '@', 'Finance DL', ID1]) assert.ok(!md.includes(leak), leak);
  assert.ok(!JSON.stringify(report).includes('contoso'));
});

test('a 400 at create is split so one bad type name does not hide the rest', async () => {
  const bad = 'microsoft.exchange.place';
  const tcm = fakeTcm({ createStatus: (resources) => (resources.includes(bad) ? 400 : 200) });
  const send = probeTransport(async () => 'token', tcm.fetchImpl);
  const types = ['microsoft.exchange.transportrule', bad, 'microsoft.exchange.sharedmailbox', 'microsoft.exchange.mailcontact'];
  const result = await createJobs({ send, version: 'v1.0', workload: 'exchange', types, stamp: 'T' });
  assert.deepEqual(result.refused.map((refusal) => refusal.types), [[bad]]);
  assert.deepEqual(result.jobs.flatMap((job) => job.types).sort(), types.filter((type) => type !== bad).sort());
  assert.ok(result.jobs.length <= 2);
  // TCM takes only letters, digits and spaces, 8 to 32 characters, and each split needs its own name.
  const names = tcm.calls.filter((call) => call.method === 'POST').map((call) => call.body.displayName);
  assert.ok(names.every((name) => /^[A-Za-z0-9 ]{8,32}$/.test(name)), names.join(', '));
  assert.equal(new Set(names).size, names.length);
});

test('a refusal keeps Graph\'s validation details, which say what was wrong', async () => {
  const fetchImpl = async () => ({ status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: 'BadRequest', message: 'One or more validation errors occurred.', details: [{ code: 'BadRequest', message: 'Snapshot Job displayName contains invalid characters.' }] } }) });
  const send = probeTransport(async () => 'token', fetchImpl);
  const result = await createJobs({ send, version: 'v1.0', workload: 'entra', types: ['microsoft.entra.authorizationpolicy'], stamp: '202610291111' });
  assert.match(result.refused[0].error, /displayName contains invalid characters/);
});

test('a refused job name is not split into more requests', async () => {
  let posts = 0;
  const fetchImpl = async () => { posts += 1; return { status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ error: { code: 'BadRequest', message: 'One or more validation errors occurred.', details: [{ message: 'Snapshot Job displayName contains invalid characters.' }] } }) }; };
  const send = probeTransport(async () => 'token', fetchImpl);
  const result = await createJobs({ send, version: 'v1.0', workload: 'exchange', types: ['microsoft.exchange.place', 'microsoft.exchange.transportrule', 'microsoft.exchange.mailcontact'], stamp: '202610291111' });
  assert.equal(posts, 1);
  assert.equal(result.refused.length, 1);
});

test('no job is created when TCM already shows its limit of jobs, and others\' jobs are never deleted', async () => {
  const tcm = fakeTcm({ visible: VISIBLE_JOB_LIMIT });
  const send = probeTransport(async () => 'token', tcm.fetchImpl);
  const report = await runSnapshots({ send, workloads: ['exchange', 'teams'], sleep: async () => {}, saveRaw: () => {} });
  assert.equal(tcm.calls.filter((call) => call.method !== 'GET').length, 0);
  assert.ok(report.workloads.every((workload) => workload.skipped));
});

test('a job that never ends is given up after the wait, then still deleted', async () => {
  const tcm = fakeTcm({ snapshot: SNAPSHOT, polls: 1000 });
  const send = probeTransport(async () => 'token', tcm.fetchImpl);
  let clock = 0;
  const report = await runSnapshots({ send, workloads: ['teams'], maxWaitMs: 60000, sleep: async (ms) => { clock += ms; }, now: () => clock, saveRaw: () => {} });
  assert.equal(report.workloads[0].jobs[0].status, 'running');
  assert.equal(report.workloads[0].jobs[0].download, undefined);
  assert.deepEqual(report.deleted, [204]);
});

test('a snapshot file on storage is read without the Graph token', async () => {
  const calls = [];
  const send = probeTransport(async () => 'token', async (url, init) => {
    calls.push(init.headers.authorization);
    return { status: 200, headers: { get: () => null }, text: async () => '[]' };
  });
  await send('https://acct.blob.core.windows.net/c/f.json?sig=x');
  assert.deepEqual(calls, [undefined]);
});

test('snapshot summaries read any envelope and keep names, not values', () => {
  assert.deepEqual(summariseSnapshot([{ ResourceType: 'Microsoft.Teams.MeetingPolicy', Properties: { Identity: 'Global', AllowChat: true } }]).types,
    { 'microsoft.teams.meetingpolicy': { count: 1, properties: ['AllowChat', 'Identity'] } });
  assert.equal(summariseSnapshot({ value: [{ resourceName: 'microsoft.entra.group' }] }).total, 1);
  assert.equal(summariseSnapshot(null).total, 0);
  assert.ok(!JSON.stringify(summariseSnapshot(SNAPSHOT)).includes('Finance'));
});

test('findings list types that answered with nothing, and types the schema list does not know', () => {
  const report = { workloads: [{ workload: 'securityandcompliance', refused: [{ types: ['microsoft.securityandcompliance.securityfilter'] }], jobs: [{ summary: { types: {
    'microsoft.securityandcompliance.protectionalert': { count: 4 }, 'microsoft.securityandcompliance.newthing': { count: 1 } } } }] }] };
  const result = findings(report);
  assert.ok(result.typesEmpty.includes('microsoft.securityandcompliance.supervisoryreviewpolicy'));
  assert.ok(!result.typesEmpty.includes('microsoft.securityandcompliance.securityfilter'));
  assert.deepEqual(result.typesRefused, ['microsoft.securityandcompliance.securityfilter']);
  assert.deepEqual(result.unknownTypesInAnswer, ['microsoft.securityandcompliance.newthing']);
  assert.deepEqual(result.keelLacksWithData, []);
});

test('check reports the role, both principals, the TCM grants and the visible jobs', async () => {
  const fetchImpl = async (url) => {
    const reply = (json) => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) });
    if (url.includes(TCM_APP_ID)) return reply({ value: [{ id: 'tcm-sp' }] });
    if (url.includes(ADMIN_SERVICES_APP_ID)) return reply({ value: [] });
    if (url.includes('/tcm-sp/appRoleAssignments')) return reply({ value: [{ appRoleId: 'r1', resourceId: 'graph-sp', resourceDisplayName: 'Microsoft Graph' }] });
    if (url.includes('/graph-sp?')) return reply({ appRoles: [{ id: 'r1', value: 'Policy.Read.All' }] });
    if (url.includes('transitiveMemberOf')) return reply({ value: [{ displayName: 'Global Reader' }] });
    if (url.includes('configurationSnapshotJobs')) return reply({ value: [{}, {}] });
    return { status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const report = await runCheck({ send: probeTransport(async () => 'token', fetchImpl), roles: [NEEDED_ROLE, 'User.Read.All'] });
  assert.equal(report.app.hasNeededRole, true);
  assert.deepEqual(report.app.roles, [NEEDED_ROLE]);
  assert.equal(report.tcmPrincipal.exists, true);
  assert.deepEqual(report.tcmPrincipal.grants.permissions, ['Microsoft Graph: Policy.Read.All']);
  assert.deepEqual(report.tcmPrincipal.directoryRoles.roles, ['Global Reader']);
  assert.equal(report.adminServicesPrincipal.exists, false);
  assert.equal(report.visibleJobs.count, 2);
  assert.equal(report.ready, false);
  assert.ok(renderMarkdown(report).includes('| Ready to run | no |'));
});

test('a snapshot link on a host the probe does not use is refused, and the jobs are still deleted', async () => {
  const tcm = fakeTcm({ snapshot: SNAPSHOT, polls: 0 });
  const inner = tcm.fetchImpl;
  const fetchImpl = async (url, init) => {
    const answer = await inner(url, init);
    if (/configurationSnapshotJobs\/[0-9a-f-]{36}$/.test(new URL(url).pathname) && init.method === 'GET') {
      return { ...answer, text: async () => JSON.stringify({ id: ID1, status: 'succeeded', resourceLocation: 'https://evil.example.com/f?sig=SECRETSIG' }) };
    }
    return answer;
  };
  const send = probeTransport(async () => 'token', fetchImpl);
  const report = await runSnapshots({ send, workloads: ['teams'], sleep: async () => {}, saveRaw: () => {} });
  assert.equal(report.workloads[0].jobs[0].download.host, 'refused');
  assert.deepEqual(report.deleted, [204]);
  assert.ok(!JSON.stringify(report).includes('SECRETSIG'));
  assert.ok(!JSON.stringify(report).includes('evil.example.com'));
});

test('a quota or limit refusal is not split into more requests, and splitting stops at the job limit', async () => {
  const quota = fakeTcm({ createStatus: () => 400 });
  const quotaFetch = async (url, init) => {
    const answer = await quota.fetchImpl(url, init);
    if (init.method === 'POST') return { ...answer, text: async () => JSON.stringify({ error: { code: 'BadRequest', message: 'Monthly quota exceeded.' } }) };
    return answer;
  };
  const types = typesFor('exchange');
  const one = await createJobs({ send: probeTransport(async () => 'token', quotaFetch), version: 'v1.0', workload: 'exchange', types, stamp: 'T' });
  assert.equal(quota.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(one.refused.length, 1);

  const bad = fakeTcm({ createStatus: (resources) => (resources.length > 1 ? 400 : 200) });
  const room = { left: 2 };
  const split = await createJobs({ send: probeTransport(async () => 'token', bad.fetchImpl), version: 'v1.0', workload: 'exchange', types: types.slice(0, 8), stamp: 'T', room });
  assert.equal(split.jobs.length, 2);
  assert.equal(room.left, 0);
  assert.ok(split.refused.every((refusal) => refusal.status === 400 || /no room/.test(refusal.error)));
});

test('types not sent for lack of room are not counted as refused by TCM', () => {
  const report = { workloads: [{ workload: 'teams', refused: [{ types: ['microsoft.teams.vdipolicy'], status: null }], jobs: [] }] };
  const result = findings(report);
  assert.deepEqual(result.typesRefused, []);
  assert.deepEqual(result.typesNotSent, ['microsoft.teams.vdipolicy']);
  assert.ok(!result.typesEmpty.includes('microsoft.teams.vdipolicy'));
});
