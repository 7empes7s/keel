/** The PIM check compares Keel's assignment list with ScubaGear's schedule instances
 * without printing an id, name or date, and reads with GET only. No tenant is touched. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { FIXTURE_BACKUPS } from '../engine/benchmarks/scubagear/fixtureTenant.mjs';
import { readOnlyGraphTransport } from '../cli/keel-workload-collect.mjs';
import { KEEL_READS, SCUBA_READ, comparePim, readPimLive, tokenFailure } from './scubagear-pim-check.mjs';

const facts = {
  roleDefinition: FIXTURE_BACKUPS.roleDefinition,
  roleAssignment: FIXTURE_BACKUPS.roleAssignment,
  roleAssignmentSchedule: FIXTURE_BACKUPS.roleAssignmentSchedule,
};

/** What ScubaGear's read would list when it agrees with Keel's backup. */
function matchingInstances() {
  const instances = facts.roleAssignmentSchedule.map((schedule) => ({
    principalId: schedule.principalId, roleDefinitionId: schedule.roleDefinitionId, directoryScopeId: schedule.directoryScopeId ?? '/',
    memberType: schedule.memberType ?? 'Direct', assignmentType: 'Assigned',
    // An assignment made outside PIM has no start date in the instances (Q294).
    startDateTime: schedule.createdUsing == null && schedule.createdDateTime == null ? null : schedule.scheduleInfo?.startDateTime ?? null,
    endDateTime: schedule.scheduleInfo?.expiration?.type === 'noExpiration' ? null : schedule.scheduleInfo?.expiration?.endDateTime ?? null,
  }));
  for (const active of facts.roleAssignment) {
    const scheduled = facts.roleAssignmentSchedule.some((schedule) => schedule.principalId === active.principalId
      && schedule.roleDefinitionId === active.roleDefinitionId && (schedule.directoryScopeId ?? '/') === (active.directoryScopeId ?? '/'));
    if (!scheduled) {
      instances.push({
        principalId: active.principalId, roleDefinitionId: active.roleDefinitionId, directoryScopeId: active.directoryScopeId ?? '/',
        memberType: 'Direct', assignmentType: 'Assigned', startDateTime: null, endDateTime: null,
      });
    }
  }
  return instances;
}

test('the two reads agree when the instances match the backup', () => {
  const result = comparePim({ facts, instances: matchingInstances() });
  assert.equal(result.agree, true, JSON.stringify(result.roles, null, 2));
  const ga = result.roles.find((role) => role.role === 'Global Administrator');
  assert.ok(ga.keel > 0);
  assert.equal(ga.keel, ga.scubaGear);
  assert.deepEqual(ga.keelSays, ga.scubaGearSays);
});

test('a schedule start date where ScubaGear sees none is a difference, and changes the 7.5 answer', () => {
  // Every assignment went through PIM in Keel's backup; ScubaGear's read sees no start date.
  const instances = matchingInstances().filter((instance) => facts.roleAssignmentSchedule
    .some((schedule) => schedule.principalId === instance.principalId && schedule.roleDefinitionId === instance.roleDefinitionId))
    .map((instance) => ({ ...instance, startDateTime: null }));
  const scheduled = { ...facts, roleAssignment: [], roleAssignmentSchedule: facts.roleAssignmentSchedule.map((schedule) => ({
    ...schedule, createdUsing: `request-${schedule.id}`, createdDateTime: '2026-01-01T00:00:00Z', scheduleInfo: { ...schedule.scheduleInfo, startDateTime: '2026-01-01T00:00:00Z' },
  })) };
  const result = comparePim({ facts: scheduled, instances });
  assert.equal(result.agree, false);
  const differing = result.roles.filter((role) => role.differences.length);
  assert.ok(differing.length > 0);
  assert.ok(differing.every((role) => role.differences.every((text) => text === 'start date: Keel set, ScubaGear not set')));
  assert.ok(differing.some((role) => role.keelSays['7.5 any assignment with no start date'] !== role.scubaGearSays['7.5 any assignment with no start date']));
});

test('a schedule made outside PIM has no start date on either side, and the clues count which fields were set', () => {
  // Q294: Graph's v1.0 schedule gives a direct assignment the read time as its start; the beta instance has none.
  const ada = facts.roleAssignmentSchedule.find((schedule) => schedule.createdUsing === null);
  assert.ok(ada?.scheduleInfo.startDateTime, 'the fixture holds a direct assignment with a v1.0 start date');
  const result = comparePim({ facts, instances: matchingInstances() });
  assert.equal(result.agree, true, JSON.stringify(result.roles, null, 2));
  const ga = result.roles.find((role) => role.role === 'Global Administrator');
  assert.equal(ga.scubaGearSays['7.5 any assignment with no start date'], true);
  assert.equal(ga.keelSays['7.5 any assignment with no start date'], true);
  assert.deepEqual(result.startDateClues, {
    'ScubaGear start set, createdUsing set, createdDateTime set, assignmentType Activated': 1,
    'ScubaGear start not set, createdUsing not set, createdDateTime not set, assignmentType Assigned': 1,
  });
});

test('missing and extra assignments are named, a group holder is only counted, and no id, name or date is printed', () => {
  const instances = matchingInstances();
  const dropped = instances.shift();
  instances.push({ ...dropped, principalId: 'aaaaaaaa-0000-4000-8000-0000000000ff' });
  instances.push({ ...dropped, principalId: 'bbbbbbbb-0000-4000-8000-0000000000ff', memberType: 'Group' });
  const result = comparePim({ facts, instances });
  assert.equal(result.agree, false);
  const all = result.roles.flatMap((role) => role.differences);
  assert.ok(all.includes('an assignment Keel lists that ScubaGear does not'));
  assert.ok(all.includes('an assignment ScubaGear lists that Keel does not'));
  assert.equal(result.roles.reduce((sum, role) => sum + role.throughGroup, 0), 1);
  assert.equal(result.heldThroughGroup, true);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/i, 'no object id');
  assert.doesNotMatch(text, /KEEL-RT-|\d{4}-\d{2}-\d{2}T/, 'no name or date');
});

test('the live read sends GET only, to the reads each side makes, and follows next pages', async () => {
  const calls = [];
  const pages = {
    [`https://graph.microsoft.com${KEEL_READS.roleDefinition}`]: { value: facts.roleDefinition },
    [`https://graph.microsoft.com${KEEL_READS.roleAssignment}`]: { value: facts.roleAssignment.slice(0, 1), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$skiptoken=x' },
    'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$skiptoken=x': { value: facts.roleAssignment.slice(1) },
    [`https://graph.microsoft.com${KEEL_READS.roleAssignmentSchedule}`]: { value: facts.roleAssignmentSchedule },
    [`https://graph.microsoft.com${SCUBA_READ}`]: { value: matchingInstances() },
  };
  const transport = async (url, init) => {
    calls.push([init?.method, url]);
    return pages[url] ? { status: 200, body: pages[url] } : { status: 404, body: null };
  };
  const read = await readPimLive(transport);
  assert.ok(calls.every(([method]) => method === 'GET'));
  assert.equal(read.facts.roleAssignment.length, facts.roleAssignment.length);
  assert.equal(comparePim(read).agree, true);

  await assert.rejects(readPimLive(async () => ({ status: 403, body: null })), /HTTP 403/);
  const outside = async (url) => ({ status: 200, body: { value: [], '@odata.nextLink': url.includes('evil') ? null : 'https://evil.example/next' } });
  await assert.rejects(readPimLive(outside), /outside Microsoft Graph/);
});

test('a role held through a group means the two cannot agree, even with no other difference', () => {
  const instances = matchingInstances();
  instances.push({ ...instances[0], principalId: 'bbbbbbbb-0000-4000-8000-0000000000ff', memberType: 'Group' });
  const result = comparePim({ facts, instances });
  assert.ok(result.roles.every((role) => role.differences.length === 0));
  assert.equal(result.heldThroughGroup, true);
  assert.equal(result.agree, false);
});

test('two Keel schedules for one holder merge the way ScubaGear copies do: a never-ending one is not hidden by a later dated one', () => {
  const [first] = facts.roleAssignmentSchedule;
  const permanent = { ...first, id: `${first.id}-permanent`, scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'noExpiration' } } };
  const dated = { ...first, id: `${first.id}-dated`, scheduleInfo: { startDateTime: '2026-01-01T00:00:00Z', expiration: { type: 'afterDateTime', endDateTime: '2027-01-01T00:00:00Z' } } };
  const schedules = [permanent, dated, ...facts.roleAssignmentSchedule.slice(1)];
  const twice = { ...facts, roleAssignmentSchedule: schedules };
  const key = (x) => `${x.principalId}|${x.roleDefinitionId}|${x.directoryScopeId ?? '/'}`;
  // ScubaGear sees only the dated copy.
  const instances = matchingInstances().map((instance) => (key(instance) === key(first)
    ? { ...instance, startDateTime: '2026-01-01T00:00:00Z', endDateTime: '2027-01-01T00:00:00Z' } : instance));
  const result = comparePim({ facts: twice, instances });
  assert.equal(result.agree, false);
  assert.ok(result.roles.flatMap((role) => role.differences).includes('end date: Keel not set, ScubaGear set'));
});

test('a token failure keeps only the status and the AADSTS code', () => {
  const raw = new Error("Token request failed (400): unauthorized_client — AADSTS700016: Application with identifier "
    + "'11111111-2222-4333-8444-555555555555' was not found in the directory 'contoso.onmicrosoft.com'. Trace ID: "
    + '66666666-7777-4888-9999-000000000000 Correlation ID: 12345678-1234-4123-8123-123456789012 Timestamp: 2026-10-30 21:00:00Z');
  assert.equal(tokenFailure(raw).message, 'token request failed (400, AADSTS700016)');
  assert.equal(tokenFailure(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')).message, 'token request failed before Entra answered');
});

test('every read sends Accept-Language en-US, which the PIM instances read needs', async () => {
  // Node's fetch sends `Accept-Language: *` by default; the beta roleAssignmentScheduleInstances read
  // answers that with 400 CultureNotFoundException (Q294), and en-US with 200.
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, headers: init.headers });
    const ok = init.headers['accept-language'] === 'en-US';
    return new Response(JSON.stringify(ok ? { value: [] } : { error: { code: 'CultureNotFoundException' } }), { status: ok ? 200 : 400 });
  };
  const transport = readOnlyGraphTransport(async () => 'token', fetchImpl);
  const read = await readPimLive(transport);
  assert.deepEqual(read.instances, []);
  assert.deepEqual(sent.map((request) => new URL(request.url).pathname), [...Object.values(KEEL_READS), SCUBA_READ]);
  assert.ok(sent.every((request) => request.headers['accept-language'] === 'en-US' && request.headers.authorization === 'Bearer token'));
});
