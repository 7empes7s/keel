#!/usr/bin/env node
/**
 * Probe of Microsoft's Tenant Configuration Management (TCM) snapshots.
 *
 * Question it answers: can KEEL use Microsoft's own configuration snapshots as a second
 * reader for the settings KEEL does not read itself, on our licence and quota?
 *
 *   node tools/tenant-probe/utcm-probe.mjs check --config /etc/keel/tenant.json --out <dir>
 *   node tools/tenant-probe/utcm-probe.mjs run   --config /etc/keel/tenant.json --out <dir> \
 *     [--workloads exchange,securityandcompliance,teams,entra,intune] [--version v1.0] \
 *     [--max-wait-seconds 2400] [--keep-jobs]
 *
 * `check` only reads: the app's token roles, whether the TCM service principal (and the
 * M365 Admin Services one it relies on) exist, what the TCM principal was granted, and how
 * many snapshot jobs are visible.
 *
 * `run` asks TCM for one snapshot per workload, waits for each job, downloads the result
 * and deletes the jobs it created. Nothing in the tenant's configuration is written: the
 * transport sends GET, the createSnapshot POST (named `KEEL RT …`) and a DELETE of a job
 * this run created, and refuses everything else. Entra and Intune are sampled (KEEL reads
 * them through its own Graph catalogue), to spend little of the monthly quota.
 *
 * Writes <dir>/utcm-probe-<check|run>.json and .md (masked: no names, ids, addresses or
 * values, only types, counts and property names), and the raw snapshots under <dir>/raw/
 * (mode 600; tenant data, never committed).
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readConfigFile } from '../../engine/config/configFile.mjs';
import { decodeRoles, getToken } from './auth.mjs';
import { mask } from './delegated-probe.mjs';
import { UTCM_TYPES, UTCM_WORKLOADS } from './utcm-types.mjs';

export const TCM_APP_ID = '03b07b79-c5bc-4b5e-9bfa-13acf4a99998';
export const ADMIN_SERVICES_APP_ID = '6b91db1b-f05b-405a-a0b2-e3f60b28d645';
export const NEEDED_ROLE = 'ConfigurationMonitoring.ReadWrite.All';
/**
 * TCM refuses a job name with anything but letters, digits and spaces, or outside 8 to 32
 * characters (live, 2026-10-29: "Only alphabets, numbers, and spaces are allowed."), so the
 * KEEL-RT fixture prefix is spelled with spaces here.
 */
export const JOB_PREFIX = 'KEEL RT';
const JOB_NAME = /^KEEL RT [A-Za-z0-9 ]+$/;
/** Short workload codes keep every job name within TCM's 32 characters. */
const WORKLOAD_CODE = { exchange: 'EXO', securityandcompliance: 'SCC', teams: 'TEAMS', entra: 'ENTRA', intune: 'INTUNE' };
/** TCM shows at most 12 snapshot jobs at once. */
export const VISIBLE_JOB_LIMIT = 12;
const TERMINAL = new Set(['succeeded', 'failed', 'partiallySuccessful']);

/** Few types of the workloads KEEL already reads through Graph: enough to see the format. */
export const SAMPLES = Object.freeze({
  entra: ['microsoft.entra.conditionalaccesspolicy', 'microsoft.entra.namedlocationpolicy', 'microsoft.entra.authorizationpolicy'],
  intune: ['microsoft.intune.devicecompliancepolicywindows10', 'microsoft.intune.devicecategory', 'microsoft.intune.roledefinition'],
});
export const DEFAULT_WORKLOADS = Object.freeze(['exchange', 'securityandcompliance', 'teams', 'entra', 'intune']);

export class ProbeScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeScopeError';
  }
}

const GRAPH = 'graph.microsoft.com';
// A snapshot file may be served from Azure storage with a signed link; no token is sent there.
const STORAGE_HOST = /^[a-z0-9-]+\.(blob|dfs)\.core\.windows\.net$/;
const JOB_PATH = /^\/(v1\.0|beta)\/admin\/configurationManagement\/configurationSnapshotJobs\/([0-9a-f-]{36})$/i;
const CREATE_PATH = /^\/(v1\.0|beta)\/admin\/configurationManagement\/configurationSnapshots\/createSnapshot$/;

/**
 * Throws unless the request is one the probe may send. `created` holds the ids of the jobs
 * this run created: only those may be deleted.
 */
export function assertProbeRequest(url, method = 'GET', body = undefined, created = new Set()) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new ProbeScopeError(`refused a plain http request to ${parsed.hostname}`);
  const host = parsed.hostname;
  const verb = String(method).toUpperCase();
  if (host !== GRAPH) {
    if (STORAGE_HOST.test(host) && verb === 'GET' && body === undefined) return { auth: false };
    throw new ProbeScopeError(`refused request to a host the probe does not use: ${host}`);
  }
  if (verb === 'GET' && body === undefined) return { auth: true };
  if (verb === 'POST' && CREATE_PATH.test(parsed.pathname) && !parsed.search) {
    const name = body?.displayName;
    if (typeof name !== 'string' || !JOB_NAME.test(name) || name.length < 8 || name.length > 32) {
      throw new ProbeScopeError('a snapshot job must be named KEEL RT … (letters, digits and spaces, 8 to 32 characters)');
    }
    if (!Array.isArray(body.resources) || body.resources.length === 0) throw new ProbeScopeError('a snapshot names its resources');
    return { auth: true };
  }
  if (verb === 'DELETE' && body === undefined) {
    const id = parsed.pathname.match(JOB_PATH)?.[2]?.toLowerCase();
    if (id && created.has(id)) return { auth: true };
    throw new ProbeScopeError('the probe deletes only snapshot jobs it created');
  }
  throw new ProbeScopeError(`refused ${verb} ${parsed.pathname}`);
}

/**
 * The only way the probe talks to Microsoft. `created` is shared with the caller so that a
 * job id is deletable only once its createSnapshot answer named it.
 */
export function probeTransport(token, fetchImpl = globalThis.fetch, { timeoutMs = 60000, created = new Set() } = {}) {
  const send = async (url, method = 'GET', body = undefined) => {
    const { auth } = assertProbeRequest(url, method, body, created);
    const headers = { accept: 'application/json', 'accept-language': 'en-US', prefer: 'include-unknown-enum-members' };
    if (auth) headers.authorization = `Bearer ${await token()}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { status: null, networkError: String(error?.message ?? error), json: null, text: '' };
    }
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (String(method).toUpperCase() === 'POST' && response.status >= 200 && response.status < 300 && typeof json?.id === 'string') {
      created.add(json.id.toLowerCase());
    }
    return { status: response.status, json, text, location: response.headers.get('location') };
  };
  send.created = created;
  return send;
}

const errorText = (answer) => {
  if (answer.networkError) return `network: ${answer.networkError}`;
  const error = answer.json?.error ?? answer.json;
  // Graph's "One or more validation errors occurred." says what was wrong only in details[].
  const details = Array.isArray(error?.details) ? error.details.map((detail) => detail?.message).filter(Boolean) : [];
  return [error?.code, error?.message, ...details].filter(Boolean).join(': ') || (answer.text ?? '').slice(0, 300);
};
const outcome = (answer) => ({ status: answer.status, error: answer.status >= 200 && answer.status < 300 ? null : mask(errorText(answer)) });

const G = (version, path) => `https://${GRAPH}/${version}${path}`;
const ADMIN = '/admin/configurationManagement';

/** The TCM types to request for one workload. */
export function typesFor(workload, types = UTCM_TYPES) {
  if (SAMPLES[workload]) return [...SAMPLES[workload]];
  return types.filter((row) => row.workload === workload).map((row) => row.type);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function servicePrincipal(send, version, appId) {
  const answer = await send(G(version, `/servicePrincipals?$filter=appId eq '${appId}'&$select=id,appId,displayName`));
  return { ...outcome(answer), id: answer.json?.value?.[0]?.id ?? null };
}

export async function runCheck({ send, roles, version = 'v1.0' }) {
  const report = { kind: 'check', version, app: { roles: roles.filter((role) => /ConfigurationMonitoring/i.test(role)), hasNeededRole: roles.includes(NEEDED_ROLE) } };
  const tcm = await servicePrincipal(send, version, TCM_APP_ID);
  const adminServices = await servicePrincipal(send, version, ADMIN_SERVICES_APP_ID);
  report.tcmPrincipal = { exists: Boolean(tcm.id), status: tcm.status, error: tcm.error };
  report.adminServicesPrincipal = { exists: Boolean(adminServices.id), status: adminServices.status, error: adminServices.error };
  if (tcm.id) {
    const grants = await send(G(version, `/servicePrincipals/${tcm.id}/appRoleAssignments?$select=appRoleId,resourceId,resourceDisplayName`));
    const resources = new Map();
    const granted = [];
    for (const grant of grants.json?.value ?? []) {
      if (!resources.has(grant.resourceId)) {
        const resource = await send(G(version, `/servicePrincipals/${grant.resourceId}?$select=displayName,appRoles`));
        resources.set(grant.resourceId, resource.json ?? {});
      }
      const role = (resources.get(grant.resourceId).appRoles ?? []).find((item) => item.id === grant.appRoleId);
      granted.push(`${grant.resourceDisplayName ?? 'unknown API'}: ${role?.value ?? 'unknown role'}`);
    }
    report.tcmPrincipal.grants = { ...outcome(grants), permissions: granted.sort() };
    const directoryRoles = await send(G(version, `/servicePrincipals/${tcm.id}/transitiveMemberOf/microsoft.graph.directoryRole?$select=displayName`));
    report.tcmPrincipal.directoryRoles = { ...outcome(directoryRoles), roles: (directoryRoles.json?.value ?? []).map((role) => role.displayName).sort() };
  }
  const jobs = await send(G(version, `${ADMIN}/configurationSnapshotJobs?$select=id,displayName,status`));
  report.visibleJobs = { ...outcome(jobs), count: Array.isArray(jobs.json?.value) ? jobs.json.value.length : null };
  report.ready = report.app.hasNeededRole && report.tcmPrincipal.exists && report.adminServicesPrincipal.exists;
  return report;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/**
 * Creates one snapshot job for `types`. A 400 usually names a type TCM does not take: the
 * list is split in two and each half retried, so one bad name does not hide the rest.
 */
const BAD_TYPE = /resource|type|name|invalid|not (?:valid|supported)/i;
const LIMIT_TEXT = /quota|limit|maximum|exceed|too many/i;
// A refused job name is not a bad type: splitting would only resend the same name.

export async function createJobs({ send, version, workload, types, depth = 0, stamp, room = { left: VISIBLE_JOB_LIMIT } }) {
  if (room.left <= 0) return { jobs: [], refused: [{ types, status: null, error: `not sent: no room for another snapshot job (TCM shows at most ${VISIBLE_JOB_LIMIT})` }] };
  room.seq = (room.seq ?? 0) + 1;
  const code = WORKLOAD_CODE[workload] ?? String(workload).replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
  const displayName = `${JOB_PREFIX} ${code} ${stamp}${depth ? ` ${room.seq}` : ''}`;
  const body = { displayName, description: 'KEEL probe: read-only snapshot, deleted after reading', resources: types };
  const answer = await send(G(version, `${ADMIN}/configurationSnapshots/createSnapshot`), 'POST', body);
  if (answer.status >= 200 && answer.status < 300 && answer.json?.id) {
    room.left -= 1;
    return { jobs: [{ id: answer.json.id, types, status: answer.json.status ?? null }], refused: [] };
  }
  const text = errorText(answer);
  // TCM names each type it does not take ("ResourceType 'x' is not supported."): refuse just
  // those and send the rest again as one job, so splitting does not spend the job slots.
  const unsupported = new Set([...text.matchAll(/ResourceType '([^']+)' is not supported/gi)].map((match) => match[1].toLowerCase()));
  const named = types.filter((type) => unsupported.has(type.toLowerCase()));
  if (answer.status === 400 && named.length > 0) {
    const refused = [{ types: named, ...outcome(answer) }];
    const rest = types.filter((type) => !unsupported.has(type.toLowerCase()));
    if (rest.length === 0) return { jobs: [], refused };
    const retried = await createJobs({ send, version, workload, types: rest, depth: depth + 1, stamp, room });
    return { jobs: retried.jobs, refused: [...refused, ...retried.refused] };
  }
  if (answer.status === 400 && types.length > 1 && depth < 6 && BAD_TYPE.test(text) && !LIMIT_TEXT.test(text) && !/displayName/i.test(text)) {
    const half = Math.ceil(types.length / 2);
    const left = await createJobs({ send, version, workload, types: types.slice(0, half), depth: depth + 1, stamp, room });
    const right = await createJobs({ send, version, workload, types: types.slice(half), depth: depth + 1, stamp, room });
    return { jobs: [...left.jobs, ...right.jobs], refused: [...left.refused, ...right.refused] };
  }
  return { jobs: [], refused: [{ types, ...outcome(answer) }] };
}

/** Polls a job until it ends or `maxWaitMs` passes. */
export async function waitForJob({ send, version, id, maxWaitMs, sleep, now }) {
  if (!Number.isFinite(maxWaitMs)) throw new RangeError('maxWaitMs must be a number');
  const started = now();
  const url = G(version, `${ADMIN}/configurationSnapshotJobs/${id}?$select=id,status,errorDetails,resourceLocation,resources,createdDateTime,completedDateTime`);
  let last = null;
  for (;;) {
    const answer = await send(url);
    last = answer;
    const status = answer.json?.status ?? null;
    if (answer.status === 200 && TERMINAL.has(status)) break;
    if (answer.status !== 200 && answer.status !== 429 && answer.status !== null) break;
    if (now() - started >= maxWaitMs) break;
    await sleep(15000);
  }
  const job = last?.json ?? {};
  return {
    status: job.status ?? null,
    httpStatus: last?.status ?? null,
    error: last?.status === 200 ? null : mask(errorText(last ?? {})),
    errorDetails: (job.errorDetails ?? []).slice(0, 40).map(mask),
    errorCount: (job.errorDetails ?? []).length,
    resourceLocation: typeof job.resourceLocation === 'string' && job.resourceLocation ? job.resourceLocation : null,
    seconds: Math.round((now() - started) / 1000),
  };
}

const lower = (value) => String(value ?? '').toLowerCase();

/**
 * Turns a downloaded snapshot into per-type counts and property names, whatever the
 * envelope looks like (the format is not documented). No values are kept.
 */
export function summariseSnapshot(json) {
  const shape = json && typeof json === 'object' && !Array.isArray(json) ? Object.keys(json).sort() : Array.isArray(json) ? ['(array)'] : [];
  const items = Array.isArray(json) ? json
    : Array.isArray(json?.resources) ? json.resources
      : Array.isArray(json?.Resources) ? json.Resources
        : Array.isArray(json?.value) ? json.value : [];
  const itemKeys = new Set();
  const byType = {};
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    Object.keys(item).forEach((key) => itemKeys.add(key));
    const type = lower(item.resourceType ?? item.ResourceType ?? item.resourceName ?? item.ResourceName ?? item.type ?? '(no type)');
    const properties = item.properties ?? item.Properties ?? item;
    const entry = byType[type] ?? (byType[type] = { count: 0, properties: new Set() });
    entry.count += 1;
    if (properties && typeof properties === 'object') Object.keys(properties).forEach((key) => entry.properties.add(key));
  }
  return {
    shape,
    itemKeys: [...itemKeys].sort(),
    total: items.length,
    types: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))
      .map(([type, entry]) => [type, { count: entry.count, properties: [...entry.properties].sort() }])),
  };
}

export async function runSnapshots({
  send, version = 'v1.0', workloads = DEFAULT_WORKLOADS, maxWaitMs = 40 * 60 * 1000, keepJobs = false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), saveRaw = () => {},
  stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''),
}) {
  const report = { kind: 'run', version, workloads: [], deleted: [], notDeleted: [] };
  const visible = await send(G(version, `${ADMIN}/configurationSnapshotJobs?$select=id`));
  report.visibleJobsBefore = Array.isArray(visible.json?.value) ? visible.json.value.length : null;
  if (visible.status !== 200) {
    report.stopped = `could not list snapshot jobs: ${outcome(visible).error ?? visible.status}`;
    return report;
  }
  const room = { left: VISIBLE_JOB_LIMIT - report.visibleJobsBefore };
  try {
    for (const workload of workloads) await snapshotWorkload({ send, version, workload, room, maxWaitMs, sleep, now, saveRaw, stamp, report, keepJobs });
  } catch (error) {
    report.stopped = `stopped early: ${mask(String(error?.message ?? error))}`;
  } finally {
    if (!keepJobs) await deleteCreated({ send, version, report });
  }
  report.findings = findings(report);
  return report;
}

async function snapshotWorkload({ send, version, workload, room, maxWaitMs, sleep, now, saveRaw, stamp, report, keepJobs }) {
  {
    const types = typesFor(workload);
    const entry = { workload, requested: types.length, jobs: [], refused: [] };
    report.workloads.push(entry);
    if (room.left <= 0) {
      entry.skipped = `no room: TCM shows at most ${VISIBLE_JOB_LIMIT} snapshot jobs, and jobs the probe did not create are never deleted`;
      return;
    }
    const created = await createJobs({ send, version, workload, types, stamp, room });
    entry.refused = created.refused.map((refusal) => ({ types: refusal.types, status: refusal.status, error: refusal.error }));
    for (const job of created.jobs) {
      const result = await waitForJob({ send, version, id: job.id, maxWaitMs, sleep, now });
      const record = { types: job.types.length, status: result.status, seconds: result.seconds, errorCount: result.errorCount, errorDetails: result.errorDetails, error: result.error };
      if (result.resourceLocation) {
        try {
          const location = new URL(result.resourceLocation, `https://${GRAPH}/`).href;
          const file = await send(location);
          record.download = { status: file.status, host: new URL(location).hostname === GRAPH ? 'graph' : 'storage', error: file.status === 200 ? null : outcome(file).error, bytes: file.text?.length ?? 0 };
          if (file.status === 200) {
            saveRaw(`${workload}-${created.jobs.indexOf(job)}.json`, file.text);
            record.summary = summariseSnapshot(file.json);
          }
        } catch (error) {
          // The signed link itself never goes in the report: only that it could not be fetched, and why.
          record.download = { status: null, host: 'refused', error: mask(String(error?.name ?? 'Error')) };
        }
      }
      entry.jobs.push(record);
    }
    // Free this workload's slots for the next one (TCM shows at most 12 jobs at once).
    if (!keepJobs) await deleteCreated({ send, version, report, room });
  }
}

/** Deletes the jobs this run created and has not deleted yet; each one deleted frees a slot. */
async function deleteCreated({ send, version, report, room }) {
  for (const id of [...send.created]) {
    if (send.deleted?.has(id)) continue;
    let answer;
    try { answer = await send(G(version, `${ADMIN}/configurationSnapshotJobs/${id}`), 'DELETE'); } catch (error) { answer = { status: `error: ${mask(String(error?.message ?? error))}` }; }
    if (answer.status === 204 || answer.status === 200) {
      report.deleted.push(answer.status);
      (send.deleted ??= new Set()).add(id);
      if (room) room.left += 1;
    } else {
      report.notDeleted.push(answer.status);
      (send.deleted ??= new Set()).add(id);
    }
  }
}

/** What the run says, against what KEEL reads. */
export function findings(report, types = UTCM_TYPES) {
  const byType = new Map(types.map((row) => [row.type, row]));
  const answered = {};
  let resources = 0;
  for (const workload of report.workloads) {
    for (const job of workload.jobs) {
      for (const [type, entry] of Object.entries(job.summary?.types ?? {})) {
        answered[type] = (answered[type] ?? 0) + entry.count;
        resources += entry.count;
      }
    }
  }
  const requested = report.workloads.flatMap((workload) => (workload.skipped ? [] : typesFor(workload.workload, types)));
  const refusals = report.workloads.flatMap((workload) => workload.refused);
  const refusedTypes = new Set(refusals.filter((refusal) => refusal.status !== null).flatMap((refusal) => refusal.types));
  const notSentTypes = new Set(refusals.filter((refusal) => refusal.status === null).flatMap((refusal) => refusal.types));
  const missingWithData = requested.filter((type) => byType.get(type)?.keel === null && answered[type] > 0)
    .map((type) => ({ type, tier: byType.get(type).tier, count: answered[type] }))
    .sort((a, b) => a.tier - b.tier || b.count - a.count || a.type.localeCompare(b.type));
  return {
    resourcesExtracted: resources,
    monthlyQuota: 20000,
    typesRequested: requested.length,
    typesRefused: [...refusedTypes].sort(),
    typesWithData: Object.keys(answered).filter((type) => byType.has(type)).length,
    typesNotSent: [...notSentTypes].sort(),
    typesEmpty: requested.filter((type) => !refusedTypes.has(type) && !notSentTypes.has(type) && !answered[type]).sort(),
    unknownTypesInAnswer: Object.keys(answered).filter((type) => !byType.has(type)).sort(),
    keelLacksWithData: missingWithData,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export function renderMarkdown(report, generatedAt = new Date().toISOString()) {
  const lines = [`# TCM snapshot probe (${report.kind})`, '', `Generated ${generatedAt.slice(0, 10)}. Graph ${report.version}. Masked: types, counts and property names only.`, ''];
  if (report.kind === 'check') {
    lines.push('| Check | Result |', '| --- | --- |',
      `| App holds ${NEEDED_ROLE} | ${report.app.hasNeededRole ? 'yes' : 'no'} (${report.app.roles.join(', ') || 'no TCM roles'}) |`,
      `| TCM service principal exists | ${report.tcmPrincipal.exists ? 'yes' : 'no'}${report.tcmPrincipal.error ? ` (${report.tcmPrincipal.error})` : ''} |`,
      `| M365 Admin Services principal exists | ${report.adminServicesPrincipal.exists ? 'yes' : 'no'} |`,
      `| TCM principal permissions | ${(report.tcmPrincipal.grants?.permissions ?? []).join(', ') || 'none'} |`,
      `| TCM principal directory roles | ${(report.tcmPrincipal.directoryRoles?.roles ?? []).join(', ') || 'none'} |`,
      `| Snapshot jobs visible | ${report.visibleJobs.count ?? `error: ${report.visibleJobs.error}`} |`,
      `| Ready to run | ${report.ready ? 'yes' : 'no'} |`, '');
    return `${lines.join('\n')}\n`;
  }
  if (report.stopped) lines.push(`**Stopped:** ${report.stopped}`, '');
  const f = report.findings;
  if (f) {
    lines.push('## Summary', '', '| Measure | Value |', '| --- | --- |',
      `| Resources extracted (counts against ${f.monthlyQuota} a month) | ${f.resourcesExtracted} |`,
      `| Types requested | ${f.typesRequested} |`,
      `| Types with data | ${f.typesWithData} |`,
      `| Types refused at create | ${f.typesRefused.length} |`,
      `| Types not sent (no room for another job) | ${f.typesNotSent.length} |`,
      `| Types empty | ${f.typesEmpty.length} |`,
      `| Jobs deleted / not deleted | ${report.deleted.length} / ${report.notDeleted.length} |`, '');
    lines.push('## Types KEEL does not read that returned data (best first)', '');
    if (f.keelLacksWithData.length === 0) lines.push('None.', '');
    else lines.push('| Type | Tier | Count |', '| --- | --- | --- |', ...f.keelLacksWithData.map((row) => `| ${row.type} | ${row.tier} | ${row.count} |`), '');
  }
  lines.push('## Jobs', '', '| Workload | Types | Status | Seconds | Errors | Download | Resources |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const workload of report.workloads) {
    if (workload.skipped) lines.push(`| ${workload.workload} | ${workload.requested} | skipped: ${workload.skipped} | | | | |`);
    for (const job of workload.jobs) {
      lines.push(`| ${workload.workload} | ${job.types} | ${job.status ?? job.error} | ${job.seconds} | ${job.errorCount} | ${job.download ? `${job.download.status} (${job.download.host})` : 'none'} | ${job.summary?.total ?? ''} |`);
    }
    for (const refusal of workload.refused) lines.push(`| ${workload.workload} | ${refusal.types.length} | refused ${refusal.status}: ${refusal.error} | | | | |`);
  }
  lines.push('');
  const details = report.workloads.flatMap((workload) => workload.jobs.flatMap((job) => job.errorDetails.map((detail) => `- ${workload.workload}: ${detail}`)));
  if (details.length) lines.push('## Job error details (first 40 per job)', '', ...details, '');
  if (f?.typesRefused.length) lines.push('## Types refused at create', '', f.typesRefused.join(', '), '');
  if (f?.typesEmpty.length) lines.push('## Types with no data', '', f.typesEmpty.join(', '), '');
  const shapes = report.workloads.flatMap((workload) => workload.jobs.filter((job) => job.summary).map((job) => `- ${workload.workload}: envelope keys ${job.summary.shape.join(', ') || 'none'}; item keys ${job.summary.itemKeys.join(', ') || 'none'}`));
  if (shapes.length) lines.push('## Snapshot format', '', ...shapes, '');
  const props = report.workloads.flatMap((workload) => workload.jobs.flatMap((job) => Object.entries(job.summary?.types ?? {})
    .map(([type, entry]) => `| ${type} | ${entry.count} | ${entry.properties.length} | ${entry.properties.slice(0, 12).join(', ')}${entry.properties.length > 12 ? ', …' : ''} |`)));
  if (props.length) lines.push('## Per type', '', '| Type | Count | Properties | First properties |', '| --- | --- | --- | --- |', ...props, '');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv) {
  const command = argv[0];
  const out = argValue(argv, '--out');
  if (!['check', 'run'].includes(command) || !out) {
    console.error('usage: utcm-probe.mjs check|run --config <tenant.json> --out <dir> [--workloads a,b] [--version v1.0] [--max-wait-seconds 2400] [--keep-jobs]');
    return 2;
  }
  const config = readConfigFile(argValue(argv, '--config') ?? '/etc/keel/tenant.json', { readFile: readFileSync, what: 'collector settings' });
  const version = argValue(argv, '--version') ?? 'v1.0';
  let held = null;
  const token = async () => {
    if (!held || held.expiresAt - Date.now() < 120000) held = await getToken(config);
    return held.accessToken;
  };
  const roles = decodeRoles(await token()).roles;
  const send = probeTransport(token);
  mkdirSync(out, { recursive: true });
  let report;
  if (command === 'check') {
    report = await runCheck({ send, roles, version });
  } else {
    const workloads = (argValue(argv, '--workloads') ?? DEFAULT_WORKLOADS.join(',')).split(',').filter(Boolean);
    const unknown = workloads.filter((workload) => !UTCM_WORKLOADS.includes(workload));
    if (unknown.length) {
      console.error(`utcm-probe: unknown workloads ${unknown.join(', ')}`);
      return 2;
    }
    const maxWaitSeconds = Number(argValue(argv, '--max-wait-seconds') ?? 2400);
    if (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds <= 0) {
      console.error('utcm-probe: --max-wait-seconds must be a positive number');
      return 2;
    }
    const maxWaitMs = maxWaitSeconds * 1000;
    const raw = join(out, 'raw');
    mkdirSync(raw, { recursive: true, mode: 0o700 });
    const saveRaw = (name, text) => {
      const path = join(raw, name);
      writeFileSync(path, text, { mode: 0o600 });
      chmodSync(path, 0o600);
    };
    report = await runSnapshots({
      send, version, workloads, saveRaw, keepJobs: argv.includes('--keep-jobs'),
      maxWaitMs,
    });
  }
  writeFileSync(join(out, `utcm-probe-${command}.json`), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, `utcm-probe-${command}.md`), renderMarkdown(report));
  console.log(renderMarkdown(report));
  return command === 'check' && !report.ready ? 3 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`utcm-probe: ${mask(String(error?.message ?? error))}`);
    process.exitCode = 1;
  });
}
