#!/usr/bin/env node
/**
 * Does Keel's backup of PIM role assignments answer CISA ScubaGear MS.AAD.7.4 and 7.5
 * the way ScubaGear's own read does?
 *
 *   node tools/scubagear-pim-check.mjs --config /etc/keel/tenant.json
 *
 * ScubaGear's provider (Get-PrivilegedRole) lists each privileged role's active
 * assignments from Graph beta roleAssignmentScheduleInstances. Keel backs up the
 * assignment schedules and every active assignment (v1.0), and its adapter builds the
 * same list from them (adapters.mjs roleAssignmentsOf): an assignment with no schedule,
 * or whose schedule names no PIM request and no creation time, was made outside PIM, so
 * it has no start date. Rule 7.4 asks whether any assignment never ends, and 7.5
 * whether any has no start date.
 *
 * Beside the comparison it counts, for every Keel schedule ScubaGear also lists, which
 * of the fields Keel reads its start date from are set (`startDateClues`), so a live
 * difference in start dates shows which field would have predicted it.
 *
 * This tool reads both live with the collector credential, GET only (the same
 * read-only transport the scheduled collection uses), and prints, per privileged
 * role, how many assignments each side lists and every difference in whether the
 * start and end dates are set. It prints no id, name or date: only built-in role
 * names, counts and "set" / "not set". Nothing is written to the tenant or the database.
 *
 * Exit codes: 0 the two reads agree; 1 they differ (the output says where); 2 the
 * read failed or the arguments are wrong.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { readConfigFile } from '../engine/config/configFile.mjs';
import { PRIVILEGED_ROLES, privilegedRoleTemplates, roleAssignmentsOf } from '../engine/benchmarks/scubagear/adapters.mjs';
import { readOnlyGraphTransport } from '../cli/keel-workload-collect.mjs';
import { getToken } from './tenant-probe/auth.mjs';

const GRAPH = 'https://graph.microsoft.com';
// What Keel's collection reads (tools/tenant-probe/catalog.d/rbac.mjs), then what
// ScubaGear's provider reads (Get-MgBetaRoleManagementDirectoryRoleAssignmentScheduleInstance).
export const KEEL_READS = Object.freeze({
  roleDefinition: '/v1.0/roleManagement/directory/roleDefinitions',
  roleAssignment: '/v1.0/roleManagement/directory/roleAssignments',
  roleAssignmentSchedule: '/v1.0/roleManagement/directory/roleAssignmentSchedules',
});
export const SCUBA_READ = '/beta/roleManagement/directory/roleAssignmentScheduleInstances';
const MAX_PAGES = 100;
// Graph's two values; anything else prints as "other" so no free text reaches the output.
const ASSIGNMENT_TYPES = new Set(['Assigned', 'Activated']);

const state = (value) => (value === null || value === undefined ? 'not set' : 'set');
const keyOf = (assignment) => `${assignment.principalId}|${assignment.directoryScopeId ?? '/'}`;

async function readAll(transport, path) {
  const items = [];
  let next = `${GRAPH}${path}`;
  for (let page = 0; next; page += 1) {
    if (page >= MAX_PAGES) throw new Error(`${path}: more than ${MAX_PAGES} pages`);
    const response = await transport(next, { method: 'GET' });
    if (response.status < 200 || response.status >= 300) throw new Error(`${path}: HTTP ${response.status}`);
    items.push(...(response.body?.value ?? []));
    next = response.body?.['@odata.nextLink'] ?? null;
    if (next && new URL(next).origin !== GRAPH) throw new Error(`${path}: refused a next page outside Microsoft Graph`);
  }
  return items;
}

/**
 * One person can hold a role both permanently and through an activation or a second schedule; a field
 * is "not set" if any copy lacks it. Both sides merge the same way.
 */
function merge(map, key, entry) {
  const seen = map.get(key);
  map.set(key, seen ? { start: seen.start === 'not set' ? seen.start : entry.start, end: seen.end === 'not set' ? seen.end : entry.end } : entry);
}

/**
 * A token failure's description carries trace and correlation ids, a timestamp and often the app or
 * tenant id, so keep only the HTTP status and the AADSTS code.
 */
export function tokenFailure(error) {
  const message = String(error?.message ?? '');
  const status = /^Token request failed \((\d+)\)/.exec(message)?.[1];
  const code = /AADSTS\d+/.exec(message)?.[0];
  if (!status) return new Error('token request failed before Entra answered');
  return new Error(`token request failed (${status}${code ? `, ${code}` : ''})`);
}

/** Reads what each side needs. Pure apart from the injected transport. */
export async function readPimLive(transport) {
  const facts = {};
  for (const [type, path] of Object.entries(KEEL_READS)) facts[type] = await readAll(transport, path);
  return { facts, instances: await readAll(transport, SCUBA_READ) };
}

/**
 * The comparison, with no id, name or date in it. `facts` holds Keel's three reads by
 * type; `instances` the schedule instances.
 */
export function comparePim({ facts, instances }) {
  const roles = [];
  const clues = {};
  let differences = 0;
  for (const role of privilegedRoleTemplates(facts, 'privileged_roles')) {
    // Keel's adapter side, keyed like the instances (who holds the role, and where).
    const keel = new Map();
    for (const assignment of roleAssignmentsOf(facts, role.templateId)) {
      merge(keel, `${assignment.PrincipalId}|${assignment.DirectoryScopeId}`, { start: state(assignment.StartDateTime), end: state(assignment.EndDateTime) });
    }
    const scuba = new Map();
    let throughGroup = 0;
    for (const instance of instances.filter((candidate) => candidate.roleDefinitionId === role.templateId)) {
      // Keel cannot build a role held through a group (its rules read "could not check"), so those are only counted.
      if (instance.memberType === 'Group') { throughGroup += 1; continue; }
      merge(scuba, keyOf(instance), { start: state(instance.startDateTime), end: state(instance.endDateTime) });
    }
    for (const schedule of facts.roleAssignmentSchedule ?? []) {
      const theirs = schedule.roleDefinitionId === role.templateId ? scuba.get(keyOf(schedule)) : null;
      if (!theirs) continue;
      const clue = [
        `ScubaGear start ${theirs.start}`,
        `createdUsing ${state(schedule.createdUsing)}`,
        `createdDateTime ${state(schedule.createdDateTime)}`,
        `assignmentType ${ASSIGNMENT_TYPES.has(schedule.assignmentType) ? schedule.assignmentType : 'other'}`,
      ].join(', ');
      clues[clue] = (clues[clue] ?? 0) + 1;
    }
    const found = [];
    for (const [key, mine] of keel) {
      const theirs = scuba.get(key);
      if (!theirs) { found.push('an assignment Keel lists that ScubaGear does not'); continue; }
      if (mine.start !== theirs.start) found.push(`start date: Keel ${mine.start}, ScubaGear ${theirs.start}`);
      if (mine.end !== theirs.end) found.push(`end date: Keel ${mine.end}, ScubaGear ${theirs.end}`);
    }
    for (const key of scuba.keys()) if (!keel.has(key)) found.push('an assignment ScubaGear lists that Keel does not');
    const verdicts = (side) => ({
      '7.4 any assignment that never ends': [...side.values()].some((entry) => entry.end === 'not set'),
      '7.5 any assignment with no start date': [...side.values()].some((entry) => entry.start === 'not set'),
    });
    differences += found.length;
    roles.push({ role: role.displayName, keel: keel.size, scubaGear: scuba.size, throughGroup, differences: found, keelSays: verdicts(keel), scubaGearSays: verdicts(scuba) });
  }
  // A role held through a group is one Keel cannot check, and ScubaGear's verdict would rest on holders left out
  // here, so the two cannot be said to agree.
  const heldThroughGroup = roles.some((entry) => entry.throughGroup > 0);
  return { agree: differences === 0 && !heldThroughGroup, heldThroughGroup, roles, privilegedRoles: PRIVILEGED_ROLES.length, instances: instances.length, startDateClues: clues };
}

async function main(argv) {
  const at = argv.indexOf('--config');
  const path = at >= 0 ? argv[at + 1] : null;
  if (!path || argv.length !== 2) {
    process.stderr.write('usage: scubagear-pim-check.mjs --config /etc/keel/<collector>.json\n');
    return 2;
  }
  try {
    const config = readConfigFile(path, { readFile: readFileSync, what: 'collector settings' });
    const transport = readOnlyGraphTransport(async () => {
      try { return (await getToken(config)).accessToken; } catch (error) { throw tokenFailure(error); }
    });
    const result = comparePim(await readPimLive(transport));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.agree ? 0 : 1;
  } catch (error) {
    // The message names the read that failed or the token status, never a token, id or value.
    process.stderr.write(`scubagear-pim-check: ${error.message}\n`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
