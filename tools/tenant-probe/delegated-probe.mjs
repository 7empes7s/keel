#!/usr/bin/env node
/**
 * Delegated-only probe (delegated access design, build step 1).
 *
 * Calls each area that Microsoft documentation says may need a signed-in user,
 * app-only with the Collector certificate, and records what really happens:
 * works, refused, not supported, not found, no token. One row of the design's
 * section 4 inventory per probe group.
 *
 * Read-only by construction: the transport sends GET only, to a fixed list of
 * Microsoft hosts, never follows a next link or redirect, and keeps no response
 * body (only its status, an error code and message, and an item count). The one
 * POST it sends is Power Platform's `listtenantsettings`, a documented read with
 * no body.
 *
 *   node tools/tenant-probe/delegated-probe.mjs run --config /etc/keel/tenant.json --out <dir> \
 *     [--cmdlets sweep-exo.json,sweep-scc.json,...] [--max-environments 3]
 *
 * Writes <dir>/delegated-probe.json and <dir>/delegated-probe.md. Names of
 * environments, workspaces and the tenant are masked; ids are masked.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { assertTokenFree, getToken } from './auth.mjs';
import { redactSecrets } from './graph.mjs';

const PP = 'https://service.powerapps.com/';
const FLOW = 'https://service.flow.microsoft.com/';
const PBI = 'https://analysis.windows.net/powerbi/api';
const YAMMER = 'https://api.yammer.com';

/** Token audience per fixed host. Dataverse hosts get `https://<host>/`. */
export const AUDIENCE = Object.freeze({
  'graph.microsoft.com': 'https://graph.microsoft.com/',
  'api.bap.microsoft.com': PP,
  'api.powerapps.com': PP,
  'api.flow.microsoft.com': FLOW,
  'api.powerbi.com': `${PBI}/`,
  'www.yammer.com': `${YAMMER}/`,
});
const DATAVERSE_HOST = /^[a-z0-9-]+\.crm[0-9]*\.dynamics\.com$/;

const BAP = 'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform';
/** The only POSTs the probe may send: documented reads, sent with no body. */
export const READ_POSTS = Object.freeze(new Set([`${BAP}/listtenantsettings?api-version=2020-10-01`]));

export class ProbeScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeScopeError';
  }
}

export function audienceFor(url) {
  const { protocol, hostname } = new URL(url);
  if (protocol !== 'https:') return null;
  if (AUDIENCE[hostname]) return AUDIENCE[hostname];
  if (DATAVERSE_HOST.test(hostname)) return `https://${hostname}/`;
  return null;
}

/** Throws unless the request is a GET (or a listed read POST with no body) to a known host. */
export function assertReadRequest(url, method = 'GET', body = undefined) {
  if (audienceFor(url) === null) throw new ProbeScopeError(`refused request to a host the probe does not read: ${url}`);
  const verb = String(method).toUpperCase();
  if (verb === 'GET' && body === undefined) return true;
  if (verb === 'POST' && body === undefined && READ_POSTS.has(url)) return true;
  throw new ProbeScopeError(`the probe is read-only: refused ${verb} ${url}`);
}

/**
 * A transport that can only read. `tokenFor(audience)` returns an access token;
 * each is fetched once and never leaves the closure. A failed token request is
 * returned as `{ tokenError }`, not thrown, because "no token for this API" is a result.
 */
export function readOnlyTransport(tokenFor, fetchImpl = globalThis.fetch, { timeoutMs = 30000 } = {}) {
  const tokens = new Map();
  return async (url, method = 'GET') => {
    assertReadRequest(url, method);
    const audience = audienceFor(url);
    if (!tokens.has(audience)) {
      try {
        tokens.set(audience, { token: await tokenFor(audience) });
      } catch (error) {
        tokens.set(audience, { error: String(error?.message ?? error) });
      }
    }
    const held = tokens.get(audience);
    if (held.error) return { tokenError: held.error };
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${held.token}`, accept: 'application/json', 'accept-language': 'en-US' },
      });
    } catch (error) {
      return { networkError: String(error?.message ?? error) };
    }
    const type = response.headers.get('content-type') ?? '';
    const text = type.includes('json') ? await response.text() : (await response.body?.cancel?.(), '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json };
  };
}

// ---------------------------------------------------------------------------
// What is probed. One group per Docs / Unsure row of section 4.
// `needs` names a value an earlier probe `provides`; without it the probe is skipped.
// `each: 'environment'` runs once per Power Platform environment (capped).
// ---------------------------------------------------------------------------

const G = (version, path) => `https://graph.microsoft.com/${version}${path}`;
const DV = '{dataverse}/api/data/v9.2';
const firstId = (key = 'id') => (json) => json?.value?.[0]?.[key] ?? null;

export const ROWS = Object.freeze([
  { row: 2, area: 'Planner premium plans (Project for the web)', probes: [
    { id: 'dataverse-whoami', each: 'environment', needs: ['dataverse'], url: `${DV}/WhoAmI`, what: 'Dataverse answers this app (an application user exists)' },
    { id: 'dataverse-projects', each: 'environment', needs: ['dataverse'], url: `${DV}/msdyn_projects?$select=msdyn_projectid&$top=1`, what: 'read premium plans' },
  ], unprobed: 'Restore through the Project schedule APIs is a write, so it is not probed.' },
  { row: 3, area: 'Project Online (PWA)', probes: [], unprobed: 'Retired by Microsoft on 30 Sep 2026. Nothing to call.' },
  { row: 5, area: 'Power Platform tenant settings', probes: [
    { id: 'pp-environments', url: `${BAP}/scopes/admin/environments?api-version=2020-10-01`, what: 'list environments (needed by rows 2, 6, 7, 8, 9)', provides: 'environments' },
    { id: 'pp-tenant-settings', method: 'POST', url: `${BAP}/listtenantsettings?api-version=2020-10-01`, what: 'read tenant settings (read-only POST)' },
  ] },
  { row: 6, area: 'Power Apps and flows inside solutions', probes: [
    { id: 'dataverse-solutions', each: 'environment', needs: ['dataverse'], url: `${DV}/solutions?$select=uniquename&$top=1`, what: 'list solutions' },
    { id: 'dataverse-workflows', each: 'environment', needs: ['dataverse'], url: `${DV}/workflows?$select=workflowid&$top=1`, what: 'list flows in Dataverse' },
    { id: 'dataverse-canvasapps', each: 'environment', needs: ['dataverse'], url: `${DV}/canvasapps?$select=canvasappid&$top=1`, what: 'list canvas apps in Dataverse' },
  ], unprobed: 'ExportSolution is a POST action that builds a package, so it is not called.' },
  { row: 7, area: 'Power Apps and flows outside solutions', probes: [
    { id: 'pp-admin-apps', each: 'environment', url: 'https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin/environments/{environment}/apps?api-version=2016-11-01', what: 'admin list of apps' },
    { id: 'pp-admin-flows', each: 'environment', url: 'https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/scopes/admin/environments/{environment}/v2/flows?api-version=2016-11-01', what: 'admin list of flows' },
  ], unprobed: 'The package export is a POST that starts an export job, so it is not called.' },
  { row: 8, area: 'Dynamics 365 (Dataverse) settings and data', probes: [
    { id: 'dataverse-organization', each: 'environment', needs: ['dataverse'], url: `${DV}/organizations?$select=organizationid`, what: 'read organization settings' },
  ] },
  { row: 9, area: 'Dynamics 365 Finance and Operations', probes: [
    { id: 'pp-finance-operations', derived: 'financeOperations', what: 'environments linked to Finance and Operations (from the environment list)' },
  ] },
  { row: 11, area: 'Power BI reports in shared workspaces', probes: [
    { id: 'pbi-member-workspaces', url: 'https://api.powerbi.com/v1.0/myorg/groups?$top=100', what: 'workspaces this app is a member of' },
    { id: 'pbi-admin-workspaces', url: "https://api.powerbi.com/v1.0/myorg/admin/groups?$top=100&$filter=type%20eq%20'Workspace'", what: 'admin list of shared workspaces' },
  ] },
  { row: 12, area: 'Power BI "My workspace" content', probes: [
    { id: 'pbi-admin-personal', url: "https://api.powerbi.com/v1.0/myorg/admin/groups?$top=100&$filter=type%20eq%20'PersonalGroup'", what: 'admin list of personal workspaces', provides: 'personalGroup', pick: firstId() },
    { id: 'pbi-personal-reports', needs: ['personalGroup'], url: 'https://api.powerbi.com/v1.0/myorg/groups/{personalGroup}/reports', what: 'list reports in one personal workspace' },
  ] },
  { row: 14, area: 'SharePoint search schema and term store', probes: [
    { id: 'graph-termstore-groups', url: G('v1.0', '/sites/root/termStore/groups?$select=id'), what: 'term store groups' },
  ], cmdlets: { workload: 'spo', match: /SearchConfiguration|TermGroup/i }, unprobed: 'Search schema export is read by the PnP sweep (Get-PnPSearchConfiguration).' },
  { row: 15, area: 'OneNote pages', probes: [
    { id: 'graph-onenote', url: G('v1.0', '/sites/root/onenote/notebooks?$select=id'), what: 'OneNote notebooks on the root site' },
  ] },
  { row: 16, area: 'Exchange settings (PowerShell)', probes: [], cmdlets: { workload: 'exo' } },
  { row: 17, area: 'Security and Compliance PowerShell (Purview)', probes: [], cmdlets: { workload: 'scc' } },
  { row: 18, area: 'Teams policies (MicrosoftTeams module)', probes: [], cmdlets: { workload: 'teams' } },
  { row: 20, area: 'Viva Engage (Yammer)', probes: [
    { id: 'graph-engage-communities', url: G('v1.0', '/employeeExperience/communities?$select=id&$top=1'), what: 'Engage communities through Graph' },
    { id: 'yammer-network', url: 'https://www.yammer.com/api/v1/networks/current.json', what: 'Engage network settings (Yammer API)' },
  ] },
  { row: 21, area: 'Entra device registration settings', probes: [
    { id: 'graph-device-registration', url: G('v1.0', '/policies/deviceRegistrationPolicy'), what: 'device registration policy' },
  ] },
  { row: 22, area: 'Entra password reset (SSPR) and per-user MFA service settings', probes: [], unprobed: 'No public API for either. Nothing to call.' },
  { row: 23, area: 'Microsoft 365 admin center org settings', probes: [
    { id: 'graph-m365apps-install', url: G('v1.0', '/admin/microsoft365Apps/installationOptions'), what: 'Microsoft 365 Apps installation options' },
    { id: 'graph-report-settings', url: G('v1.0', '/admin/reportSettings'), what: 'report privacy setting' },
    { id: 'graph-profile-card', url: G('v1.0', '/admin/people/profileCardProperties'), what: 'profile card properties' },
    { id: 'graph-apps-and-services', url: G('beta', '/admin/appsAndServices'), what: 'apps and services settings' },
    { id: 'graph-todo-settings', url: G('beta', '/admin/todo'), what: 'To Do settings' },
    { id: 'graph-dynamics-settings', url: G('beta', '/admin/dynamics'), what: 'Dynamics 365 customer voice settings' },
  ], unprobed: 'Admin center settings outside Graph `/admin` have no public API.' },
  { row: 24, area: 'Defender portal settings', probes: [
    { id: 'graph-detection-rules', url: G('beta', '/security/rules/detectionRules?$select=id&$top=1'), what: 'custom detection rules' },
  ], unprobed: 'Advanced features and notification rules have no public API.' },
  { row: 25, area: 'Microsoft Forms', probes: [
    { id: 'graph-forms-settings', url: G('beta', '/admin/forms'), what: 'tenant Forms settings (not forms or answers)' },
  ], unprobed: 'Forms and their answers have no API.' },
  { row: 26, area: 'Loop workspaces', probes: [], unprobed: 'SharePoint Embedded containers of other apps are not open to a third-party app. Nothing to call.' },
  { row: 27, area: 'Stream videos, Whiteboard, Clipchamp', probes: [], unprobed: 'Stored as files in OneDrive and SharePoint; covered by the file backup.' },
  { row: 28, area: 'Bookings', probes: [
    { id: 'graph-bookings', url: G('v1.0', '/solutions/bookingBusinesses?$select=id'), what: 'Bookings calendars' },
  ] },
]);

/** The section 4 rows whose source is Docs or Unsure: every one must be listed above. */
export const DOCS_OR_UNSURE_ROWS = Object.freeze([2, 3, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 28]);

// ---------------------------------------------------------------------------
// Classifying an answer
// ---------------------------------------------------------------------------

const NOT_SUPPORTED = /not supported|unsupported|application permission|app-?only|delegated|not available for|resource not found for the segment|no http resource|isn'?t supported|is not enabled/i;

function errorOf(json) {
  const error = json?.error ?? json;
  const code = error?.code ?? error?.Code ?? error?.errorCode ?? null;
  const message = error?.message ?? error?.Message ?? error?.error_description ?? null;
  return { code: code === null ? null : String(code), message: typeof message === 'string' ? message : null };
}

const tokenCode = (text) => text.match(/AADSTS\d+/)?.[0] ?? null;

/** Turns one answer into `{ outcome, status, code, message, count }`. */
export function classify(answer) {
  if (answer.tokenError) return { outcome: 'no-token', status: null, code: tokenCode(answer.tokenError), message: answer.tokenError, count: null };
  if (answer.networkError) return { outcome: 'error', status: null, code: 'network', message: answer.networkError, count: null };
  const { status, json } = answer;
  if (status >= 200 && status < 300) {
    const count = Array.isArray(json?.value) ? json.value.length : null;
    return { outcome: 'works', status, code: null, message: null, count };
  }
  const { code, message } = errorOf(json);
  const text = `${code ?? ''} ${message ?? ''}`;
  let outcome;
  if (status === 401 || status === 403) outcome = 'refused';
  else if ([400, 405, 501].includes(status)) outcome = 'not-supported';
  else if (status === 404) outcome = NOT_SUPPORTED.test(text) ? 'not-supported' : 'not-found';
  else outcome = 'error';
  return { outcome, status, code, message, count: null };
}

// ---------------------------------------------------------------------------
// Masking: the report carries no names, ids, hosts or addresses from the tenant.
// ---------------------------------------------------------------------------

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TENANT_HOST = /\b[a-z0-9-]+\.(onmicrosoft\.com|sharepoint\.com|crm[0-9]*\.dynamics\.com)\b/gi;
const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g;

export function mask(text) {
  if (typeof text !== 'string') return text;
  return redactSecrets(text)
    .replace(EMAIL, '[address]')
    .replace(TENANT_HOST, '[tenant host]')
    .replace(GUID, '[id]')
    .replace(TIMESTAMP, '[time]')
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** From the BAP environment list: the name and Dataverse URL of each environment. */
export function environmentsOf(json) {
  return (json?.value ?? []).map((env) => ({
    name: env?.name ?? null,
    dataverse: env?.properties?.linkedEnvironmentMetadata?.instanceUrl?.replace(/\/+$/, '') ?? null,
    financeOperations: Boolean(env?.properties?.linkedAppMetadata),
  })).filter((env) => env.name);
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_m, key) => encodeURI(String(values[key])));

/**
 * Runs every probe through `transport`. Returns a report with no secret, name or id in it.
 * `cmdletRows` are the merged rows of sweep-get-cmdlets.ps1 outputs (optional).
 */
export async function runProbe({ transport, maxEnvironments = 3, cmdletRows = [], now = () => new Date() }) {
  const provided = {};
  let environments = [];

  const runOne = async (probe, target) => {
    const values = { ...provided, environment: target.name, dataverse: target.dataverse };
    const missing = (probe.needs ?? []).filter((key) => !values[key]);
    const base = { id: probe.id, what: probe.what, ...(target.label ? { target: target.label } : {}) };
    if (missing.length) {
      return { ...base, outcome: 'skipped', reason: missing.includes('dataverse') ? 'environment has no Dataverse' : `nothing to read: no ${missing.join(', ')}` };
    }
    let url;
    try {
      url = fill(probe.url, values);
      assertReadRequest(url, probe.method ?? 'GET');
    } catch (error) {
      return { ...base, outcome: 'skipped', reason: mask(String(error.message)) };
    }
    const answer = await transport(url, probe.method ?? 'GET');
    const verdict = classify(answer);
    if (probe.provides === 'environments' && verdict.outcome === 'works') {
      environments = environmentsOf(answer.json);
      provided.environments = environments.length;
      verdict.count = environments.length;
    } else if (probe.provides && verdict.outcome === 'works') {
      provided[probe.provides] = probe.pick(answer.json);
    }
    return { ...base, outcome: verdict.outcome, status: verdict.status, code: mask(verdict.code), message: mask(verdict.message), count: verdict.count };
  };

  // Probes that provide a value (the environment list, a personal workspace) run first,
  // so the rows that need it can be listed in section 4 order.
  const early = new Map();
  for (const group of ROWS) {
    for (const probe of group.probes) if (probe.provides) early.set(probe.id, await runOne(probe, { label: null }));
  }

  const rows = [];
  for (const group of ROWS) {
    const results = [];
    for (const probe of group.probes) {
      if (early.has(probe.id)) {
        results.push(early.get(probe.id));
        continue;
      }
      if (probe.derived === 'financeOperations') {
        results.push(provided.environments === undefined
          ? { id: probe.id, what: probe.what, outcome: 'skipped', reason: 'no environment list' }
          : { id: probe.id, what: probe.what, outcome: 'info', count: environments.filter((env) => env.financeOperations).length,
            reason: 'environments linked to Finance and Operations; its own API is a later phase and is not called' });
        continue;
      }
      if (probe.each === 'environment') {
        const targets = environments.slice(0, maxEnvironments);
        if (targets.length === 0) {
          results.push({ id: probe.id, what: probe.what, outcome: 'skipped', reason: provided.environments === undefined ? 'no environment list' : 'no Power Platform environment' });
          continue;
        }
        for (const [index, env] of targets.entries()) results.push(await runOne(probe, { ...env, label: `environment ${index + 1}` }));
        continue;
      }
      results.push(await runOne(probe, { label: null }));
    }
    const cmdlets = group.cmdlets ? cmdletRows.filter((row) => row.workload === group.cmdlets.workload
      && (!group.cmdlets.match || group.cmdlets.match.test(row.cmdlet ?? ''))) : [];
    rows.push({ row: group.row, area: group.area, results, cmdlets: summariseCmdlets(cmdlets, Boolean(group.cmdlets)), unprobed: group.unprobed ?? null, verdict: null });
  }
  for (const row of rows) row.verdict = rowVerdict(row);
  const report = { generatedAt: now().toISOString(), maxEnvironments, environments: environments.length, rows };
  assertTokenFree(report, 'delegated probe report');
  return report;
}

/** Counts by outcome, plus every cmdlet that did not work, masked. */
export function summariseCmdlets(cmdlets, expected) {
  if (!expected) return null;
  if (cmdlets.length === 0) return { swept: false, counts: {}, notWorking: [] };
  const counts = {};
  for (const row of cmdlets) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
  const notWorking = cmdlets.filter((row) => !['works', 'needs-parameter'].includes(row.outcome))
    .map((row) => ({ cmdlet: row.cmdlet, outcome: row.outcome, message: mask(row.error ?? null) }));
  return { swept: true, counts, notWorking };
}

/** One plain verdict per row. */
export function rowVerdict(row) {
  const outcomes = row.results.filter((result) => !['skipped', 'info'].includes(result.outcome)).map((result) => result.outcome);
  if (row.cmdlets?.swept) {
    const { counts } = row.cmdlets;
    if (counts.works) outcomes.push('works');
    if (counts.refused) outcomes.push('refused');
    if (counts['not-supported']) outcomes.push('not-supported');
  }
  if (outcomes.length === 0) return row.results.length || row.cmdlets ? 'not probed (see reasons)' : 'nothing to call';
  const works = outcomes.filter((outcome) => outcome === 'works').length;
  if (works === outcomes.length) return 'app-only works';
  if (works > 0) return 'partly app-only';
  if (outcomes.every((outcome) => ['refused', 'not-supported', 'no-token'].includes(outcome))) return 'app-only refused';
  return 'inconclusive';
}

export function renderMarkdown(report) {
  const lines = [`# Delegated-only probe`, '', `Generated ${report.generatedAt}. Environments read: ${report.environments} (cap ${report.maxEnvironments}).`, '',
    '| Row | Area | Verdict |', '|---|---|---|'];
  for (const row of report.rows) lines.push(`| ${row.row} | ${row.area} | ${row.verdict} |`);
  for (const row of report.rows) {
    lines.push('', `## Row ${row.row}: ${row.area}`, '', `Verdict: **${row.verdict}**`);
    if (row.results.length) {
      lines.push('', '| Probe | Target | Outcome | HTTP | Code | Count | Message or reason |', '|---|---|---|---|---|---|---|');
      for (const r of row.results) {
        const text = (r.reason ?? r.message ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
        lines.push(`| ${r.what} | ${r.target ?? ''} | ${r.outcome} | ${r.status ?? ''} | ${r.code ?? ''} | ${r.count ?? ''} | ${text} |`);
      }
    }
    if (row.cmdlets) {
      if (!row.cmdlets.swept) lines.push('', 'Cmdlet sweep: not supplied.');
      else {
        lines.push('', `Cmdlet sweep: ${Object.entries(row.cmdlets.counts).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
        if (row.cmdlets.notWorking.length) {
          lines.push('', '| Cmdlet | Outcome | Message |', '|---|---|---|');
          for (const c of row.cmdlets.notWorking) lines.push(`| ${c.cmdlet} | ${c.outcome} | ${(c.message ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`);
        }
      }
    }
    if (row.unprobed) lines.push('', `Not called: ${row.unprobed}`);
  }
  return `${lines.join('\n')}\n`;
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(argv) {
  if (argv[0] !== 'run') {
    console.error('usage: delegated-probe.mjs run --config <tenant.json> --out <dir> [--cmdlets a.json,b.json] [--max-environments 3]');
    return 2;
  }
  const configPath = argValue(argv, '--config') ?? '/etc/keel/tenant.json';
  const out = argValue(argv, '--out');
  if (!out) {
    console.error('delegated-probe: --out is required');
    return 2;
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const cmdletRows = (argValue(argv, '--cmdlets') ?? '').split(',').filter(Boolean)
    .flatMap((file) => [JSON.parse(readFileSync(file, 'utf8'))].flat());
  const maxEnvironments = Number(argValue(argv, '--max-environments') ?? 3);
  const transport = readOnlyTransport(async (audience) => (await getToken(config, { scope: `${audience}.default` })).accessToken);
  const report = await runProbe({ transport, maxEnvironments, cmdletRows });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'delegated-probe.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(out, 'delegated-probe.md'), renderMarkdown(report));
  for (const row of report.rows) console.log(`row ${row.row}: ${row.verdict}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`delegated-probe: ${mask(String(error?.message ?? error))}`);
    process.exitCode = 1;
  });
}
